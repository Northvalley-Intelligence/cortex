/**
 * Trace retrieval.
 *
 * The trace is the product (MISSION.md:7,88). Its job is to answer one question well: given a
 * bad output, was the prompt at fault, the model, or Cortex itself?
 *
 * Answering that needs more than "here is the prompt and the response". It needs the fault to
 * be *attributable*, which is why `diagnosis` exists: Generation 0 proved a truncated call is
 * indistinguishable from a healthy one by prompt+output alone, so a trace that shows only
 * those two would confidently mislead a reader into blaming the prompt for a harness bug
 * (BDD-018).
 */

export function getTrace(db, callId) {
  const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId);
  if (!call) return null;

  const attempts = db
    .prepare(`SELECT * FROM attempts WHERE call_id = ? ORDER BY attempt_no ASC`)
    .all(callId);

  return {
    trace_id: call.id,
    job_id: call.job_id,
    client: call.client,
    purpose: call.purpose,
    priority_class: call.priority_class,
    status: call.status,
    input: {
      prompt: call.prompt,
      system_prompt: call.system_prompt,
      params: JSON.parse(call.params || "{}"),
      min_context_window: call.min_context_window,
    },
    output: call.output,
    error: call.error_code ? { code: call.error_code, message: call.error_message } : null,
    resolved_by: call.provider_id ? { provider: call.provider_id, model: call.model } : null,
    timing: {
      submitted_at: call.submitted_at,
      started_at: call.started_at,
      completed_at: call.completed_at,
      queue_wait_ms: call.started_at ? call.started_at - call.submitted_at : null,
      total_ms: call.completed_at ? call.completed_at - call.submitted_at : null,
    },
    attempts: attempts.map((a) => ({
      attempt_no: a.attempt_no,
      provider: a.provider_id,
      model: a.model,
      provider_version: a.provider_version,
      status: a.status,
      failure_kind: a.failure_kind,
      error_message: a.error_message,
      latency_ms: a.latency_ms,
      request_payload: a.request_payload ? JSON.parse(a.request_payload) : null,
      response_text: a.response_text,
      tokens: {
        sent_estimate: a.sent_tokens_estimate,
        // What the model ACTUALLY read. The gap against sent_estimate is the truncation tell.
        evaluated: a.evaluated_tokens,
        completion: a.completion_tokens,
      },
      requested_num_ctx: a.requested_num_ctx,
      truncation_detected: Boolean(a.truncation_detected),
      // Provider stop signal + whether the ANSWER was cut off at the token cap (output-side
      // truncation), as opposed to truncation_detected which is the INPUT being cut.
      done_reason: a.done_reason,
      output_truncated: Boolean(a.output_truncated),
      cost_usd: a.cost_usd,
    })),
    diagnosis: diagnose(call, attempts),
  };
}

/**
 * Attribute the outcome to a responsible layer.
 *
 * Deliberately conservative: it names a fault only where the evidence is unambiguous, and
 * says "inconclusive" otherwise. A diagnosis that guesses would be worse than none, because
 * the whole point is to stop guessing about whether the prompt or the model failed.
 */
export function diagnose(call, attempts) {
  const truncated = attempts.find((a) => a.truncation_detected);
  if (truncated) {
    return {
      fault: "harness",
      confident: true,
      summary:
        `Cortex sent ~${truncated.sent_tokens_estimate} tokens but the model evaluated ` +
        `${truncated.evaluated_tokens} against a num_ctx of ${truncated.requested_num_ctx}, ` +
        `so the prompt was silently truncated and the start of it never reached the model.`,
      do_not_conclude:
        "Do NOT revise the prompt on the basis of this output. The model did not read the " +
        "whole prompt, so the output is evidence about Cortex's context handling, not about " +
        "prompt quality.",
    };
  }

  if (call.error_code === "context_window_exceeded") {
    return {
      fault: "caller",
      confident: true,
      summary:
        "The prompt did not fit the effective context floor of the eligible providers, so " +
        "Cortex refused to send it rather than truncating it.",
      do_not_conclude: "This call never reached a model; it says nothing about model quality.",
    };
  }

  if (call.status === "exhausted") {
    return {
      fault: "availability",
      confident: true,
      summary:
        `Every eligible provider failed with an availability error ` +
        `(${attempts.map((a) => `${a.provider_id}: ${a.failure_kind}`).join("; ")}). ` +
        `No model produced an answer.`,
      do_not_conclude: "This is a quota/outage signal, not a prompt or model quality signal.",
    };
  }

  const contentFailure = attempts.find((a) => a.failure_kind === "content");
  if (contentFailure) {
    return {
      fault: "prompt_or_model",
      confident: false,
      summary:
        `${contentFailure.provider_id} was reachable and answered, but the answer was ` +
        `unusable. The full prompt was evaluated (${contentFailure.evaluated_tokens} tokens), ` +
        `so this IS a legitimate quality signal about the prompt or the model.`,
      next_step:
        "This is the 'blame the prompt' case: the input and output are both recorded above, " +
        "so the prompt can be revised against real evidence and resubmitted.",
    };
  }

  // Output truncation: the model hit the completion token cap and the answer was cut off. This
  // is flagged even when the call "succeeded", because a partial or empty completion looks like
  // a bad model until you know the answer was severed mid-stream. The classic trap is a
  // thinking model whose <think> block eats the whole maxTokens budget before any real output,
  // leaving an empty response the caller then fails to parse. The fix is the caller's budget,
  // not the prompt or the model, so it is named here rather than left to be re-diagnosed.
  const outputTruncated = attempts.find((a) => a.output_truncated);
  if (outputTruncated) {
    const cap = JSON.parse(outputTruncated.request_payload || "{}")?.options?.num_predict
      ?? JSON.parse(outputTruncated.request_payload || "{}")?.max_tokens ?? null;
    return {
      fault: "caller",
      confident: true,
      summary:
        `${outputTruncated.provider_id} stopped at the output token cap` +
        (cap ? ` (~${cap} tokens)` : "") +
        ` (done_reason=length), so the completion was cut off mid-stream` +
        (outputTruncated.completion_tokens != null
          ? ` after ${outputTruncated.completion_tokens} generated tokens` : "") +
        `. A short or empty answer here is severed output, not a model that answered poorly.`,
      next_step:
        "Raise the completion budget (params.maxTokens / max_tokens). If the model is a " +
        "thinking model, its reasoning can consume the entire budget before any answer is " +
        "emitted -- either give it a much larger budget or disable thinking; a non-thinking " +
        "model returns the same structured answer in a fraction of the tokens.",
    };
  }

  if (call.status === "succeeded") {
    return { fault: null, confident: true, summary: "Call succeeded." };
  }

  return { fault: "unknown", confident: false, summary: "No attempt recorded a decisive cause." };
}

/** Distinct values for the grid's filter dropdowns. Cheap; not per-page. */
export function traceFacets(db) {
  const clients = db.prepare(`SELECT DISTINCT client FROM calls WHERE client IS NOT NULL ORDER BY client`).all().map((r) => r.client);
  const purposes = db.prepare(`SELECT DISTINCT purpose FROM calls WHERE purpose IS NOT NULL AND purpose <> '' ORDER BY purpose`).all().map((r) => r.purpose);
  return { clients, purposes };
}

export function listTraces(db, { limit = 50, offset = 0, status, client, provider, job, purpose, priorityClass, q } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const where = [];
  const args = [];
  if (status) { where.push("c.status = ?"); args.push(status); }
  if (client) { where.push("c.client = ?"); args.push(client); }
  if (job) { where.push("c.job_id = ?"); args.push(job); }
  if (provider) { where.push("c.provider_id = ?"); args.push(provider); }
  if (purpose) { where.push("c.purpose = ?"); args.push(purpose); }
  if (priorityClass) { where.push("c.priority_class = ?"); args.push(priorityClass); }
  // Free-text search across the fields an operator navigates by (id, client, purpose). Prompt
  // BODY is intentionally not searched here -- it is unindexed and can be large; drill into a
  // row's trace to read the prompt. This keeps the grid query fast on a big store.
  if (q) { const like = `%${q}%`; where.push("(c.id LIKE ? OR c.client LIKE ? OR c.purpose LIKE ?)"); args.push(like, like, like); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM calls c ${clause}`).get(...args).n ?? 0;
  // provider_path carries the ORDERED list of provider attempts, not just the final resolver,
  // so a list view can show "gemini -> openrouter" instead of collapsing a fallback to its
  // last hop. MDE principle: a view must not drop identity/connection information — a row that
  // shows only the resolving provider hides that the call was tried elsewhere first.
  const rows = db
    .prepare(
      `SELECT c.id AS trace_id, c.job_id, c.client, c.purpose, c.priority_class, c.status,
              c.provider_id, c.model, c.submitted_at, c.completed_at, c.error_code,
              (SELECT COUNT(*) FROM attempts a WHERE a.call_id = c.id) AS attempt_count,
              (SELECT MAX(truncation_detected) FROM attempts a WHERE a.call_id = c.id) AS truncated,
              (SELECT json_group_array(json_object('provider', provider_id, 'status', status, 'failure_kind', failure_kind))
                 FROM (SELECT provider_id, status, failure_kind FROM attempts WHERE call_id = c.id ORDER BY attempt_no)) AS provider_path
       FROM calls c ${clause}
       ORDER BY c.submitted_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, lim, off);
  return {
    total,
    limit: lim,
    offset: off,
    traces: rows.map((r) => ({ ...r, provider_path: r.provider_path ? JSON.parse(r.provider_path) : [] })),
  };
}
