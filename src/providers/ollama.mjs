/**
 * Local provider (Ollama, native API).
 *
 * Cortex speaks Ollama's native protocol rather than an OpenAI-compatible shim because it
 * needs two things the shim does not expose:
 *
 *   1. `options.num_ctx` per request -- to size the window to the client's declared floor.
 *   2. `prompt_eval_count` in the response -- to prove the model actually read the prompt.
 *
 * Generation 0 established why this matters (.mde/evidence/GEN-000-ollama-silent-truncation.md):
 * with the default num_ctx, a ~10,500-token prompt was evaluated as exactly 4096 tokens. The
 * needle at the start of the prompt was dropped, the model answered wrongly, and the call
 * returned HTTP 200 with a success status. Nothing in the response says "I truncated this".
 *
 * Truncation detection here is exact rather than heuristic. Ollama truncates to precisely
 * num_ctx, so `prompt_eval_count >= num_ctx` means the ceiling was hit and content was
 * discarded; `prompt_eval_count < num_ctx` means the whole prompt fit. This needs no
 * tokenizer and cannot drift from the model's real behaviour.
 */
import { ProviderError, TruncationError, FAILURE_AVAILABILITY } from "../failures.mjs";

export async function callOllama({ provider, prompt, systemPrompt, params, numCtx, signal }) {
  const body = {
    model: provider.model,
    prompt,
    stream: false,
    options: {
      // Explicit and per-call. Never inherit the provider default -- that default is the bug.
      num_ctx: numCtx,
      temperature: params.temperature ?? 0.1,
      ...(params.maxTokens ? { num_predict: params.maxTokens } : {}),
    },
    keep_alive: "10m",
  };
  if (systemPrompt) body.system = systemPrompt;
  // Honour a JSON-mode request so the same call yields structured output on the local provider
  // too. Ollama takes format:"json"; the OpenAI-style response_format object maps to it.
  if (params.responseFormat?.type === "json_object" || params.responseFormat === "json") {
    body.format = "json";
  }

  let res;
  try {
    res = await fetch(`${provider.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ProviderError(`ollama transport: ${err.message}`, {
      failureKind: FAILURE_AVAILABILITY,
      provider: provider.id,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`ollama ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      provider: provider.id,
    });
  }

  const data = await res.json();
  const evaluatedTokens = data.prompt_eval_count ?? null;

  // The whole reason this provider exists in this shape.
  if (evaluatedTokens !== null && evaluatedTokens >= numCtx) {
    throw new TruncationError(
      `Local model silently truncated the prompt: it evaluated ${evaluatedTokens} tokens ` +
        `against a num_ctx of ${numCtx}, so the start of the prompt was discarded. ` +
        `The model returned a plausible answer anyway -- this call is being failed rather ` +
        `than returned, because a truncated answer is indistinguishable from a good one.`,
      {
        provider: provider.id,
        evaluatedTokens,
        requestedNumCtx: numCtx,
        truncationDetected: true,
      },
    );
  }

  // done_reason 'length' means the model hit num_predict and the ANSWER was cut off (distinct
  // from the input truncation above). Ollama still returns HTTP 200 with whatever text it had
  // -- often empty for a thinking model whose <think> block consumed the whole budget -- so the
  // signal is recorded rather than inferred later from a suspiciously short response.
  const doneReason = data.done_reason ?? null;
  return {
    text: data.response ?? "",
    evaluatedTokens,
    completionTokens: data.eval_count ?? null,
    requestedNumCtx: numCtx,
    truncationDetected: false,
    doneReason,
    outputTruncated: doneReason === "length",
    providerVersion: provider.model,
    requestPayload: body,
  };
}

/** Reports which models the local runtime can actually serve right now. */
export async function ollamaHealth(provider, signal) {
  try {
    const res = await fetch(`${provider.baseUrl}/api/tags`, { signal });
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    return {
      ok: models.includes(provider.model),
      models,
      reason: models.includes(provider.model) ? null : `model ${provider.model} not pulled`,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
