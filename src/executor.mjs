/**
 * Executes one call against the provider chain, and records what happened.
 *
 * Order of business, and why:
 *
 *   1. Filter providers by the client's declared context window. Eligibility is decided
 *      BEFORE routing, so a fallback can never quietly land the prompt on a smaller model
 *      than the client asked for (MISSION.md:33, BDD-011).
 *   2. Compute the floor as the minimum effective window across eligible providers, and
 *      reject a prompt that does not fit it -- clearly, without truncating (MISSION.md:70).
 *   3. Try each eligible provider in order, falling through ONLY on availability failures
 *      (BDD-013).
 *   4. Write one attempt row per provider tried, whatever the outcome.
 *
 * The trace is written on every path, including the ones that throw. A missing trace is a
 * mission failure (MISSION.md:88), so there is no early return that skips recording.
 */
import { callProvider } from "./providers/index.mjs";
import { estimatePromptTokens, estimateRequiredWindow } from "./tokens.mjs";
import {
  classifyFailure,
  shouldFallBack,
  ContextFloorError,
  FAILURE_HARNESS,
} from "./failures.mjs";
import { providerAvailable } from "./config.mjs";
import { redact } from "./redact.mjs";

/**
 * Providers that can honour the declared window, in chain order.
 *
 * Uses effectiveContextWindow, never an advertised figure. Generation 0 proved the local
 * runtime advertises 131072 while defaulting to 4096 -- a 32x lie. Eligibility computed from
 * advertised numbers would be wrong by construction.
 */
export function eligibleProviders(providers, minContextWindow) {
  return providers.filter(
    (p) => providerAvailable(p) && p.effectiveContextWindow >= minContextWindow,
  );
}

export function contextFloor(providers) {
  if (providers.length === 0) return 0;
  return Math.min(...providers.map((p) => p.effectiveContextWindow));
}

export class Executor {
  #db;
  #config;

  constructor(db, config) {
    this.#db = db;
    this.#config = config;
  }

  #recordAttempt(callId, attemptNo, row) {
    this.#db
      .prepare(
        `INSERT INTO attempts (call_id, attempt_no, provider_id, model, provider_version,
           started_at, completed_at, latency_ms, status, failure_kind, error_message,
           request_payload, response_text, sent_tokens_estimate, evaluated_tokens,
           completion_tokens, requested_num_ctx, truncation_detected, done_reason,
           output_truncated, cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        callId,
        attemptNo,
        row.providerId,
        row.model,
        row.providerVersion ?? null,
        row.startedAt,
        row.completedAt,
        row.latencyMs,
        row.status,
        row.failureKind ?? null,
        row.errorMessage ?? null,
        row.requestPayload ? JSON.stringify(row.requestPayload) : null,
        row.responseText ?? null,
        row.sentTokensEstimate ?? null,
        row.evaluatedTokens ?? null,
        row.completionTokens ?? null,
        row.requestedNumCtx ?? null,
        row.truncationDetected ? 1 : 0,
        row.doneReason ?? null,
        row.outputTruncated ? 1 : 0,
        row.costUsd ?? null,
      );
  }

  #cost(provider, evaluatedTokens, completionTokens) {
    const inTok = evaluatedTokens ?? 0;
    const outTok = completionTokens ?? 0;
    return (
      (inTok / 1000) * (provider.costPer1kInputUsd ?? 0) +
      (outTok / 1000) * (provider.costPer1kOutputUsd ?? 0)
    );
  }

  /**
   * Run one call to a terminal state.
   *
   * Returns { status, output, providerId, model, errorCode, errorMessage }.
   * `exhausted` means every eligible provider hit an availability failure -- distinct from
   * `failed`, which means a reachable model produced an unusable answer. Collapsing the two
   * would erase the difference between "the service was down" and "the prompt was bad".
   */
  async execute(call) {
    const providers = this.#config.providers;
    const minWindow = call.min_context_window;
    const eligible = eligibleProviders(providers, minWindow);

    if (eligible.length === 0) {
      const err = new ContextFloorError(
        `No configured provider satisfies the declared context window of ${minWindow} tokens. ` +
          `Eligible providers: none. Configured: ${providers
            .map((p) => `${p.id}(${p.effectiveContextWindow})`)
            .join(", ")}.`,
        { minContextWindow: minWindow },
      );
      return {
        status: "failed",
        errorCode: err.code,
        errorMessage: err.message,
        providerId: null,
        model: null,
      };
    }

    const floor = contextFloor(eligible);
    const required = estimateRequiredWindow({
      prompt: call.prompt,
      systemPrompt: call.system_prompt,
      params: call.params,
    });

    // Fail clearly instead of silently truncating. MISSION.md:33,47,70 -- BDD-010.
    if (required > floor) {
      return {
        status: "failed",
        errorCode: "context_window_exceeded",
        errorMessage:
          `Prompt requires ~${required} tokens (prompt + reserved completion) but the ` +
          `effective floor across eligible providers is ${floor} tokens ` +
          `(${eligible.map((p) => `${p.id}=${p.effectiveContextWindow}`).join(", ")}). ` +
          `Refusing to send: a smaller handler would truncate this prompt silently. ` +
          `Either shorten the prompt or declare a higher min_context_window to narrow routing.`,
        providerId: null,
        model: null,
      };
    }

    const sentTokensEstimate = estimatePromptTokens({
      prompt: call.prompt,
      systemPrompt: call.system_prompt,
    });

    /**
     * Continue numbering from any earlier attempts on this call rather than restarting at 1.
     *
     * A requeued call (machine sleep, lease expiry, manual retry) executes this method again.
     * Restarting the counter collided with UNIQUE(call_id, attempt_no), the insert threw, and
     * the worker marked the call `failed` with an internal error -- so a call that should have
     * succeeded on retry died instead, and its earlier attempts were the only reason why.
     * That would have broken exactly the machine-sleep recovery this service promises
     * (BDD-005, BDD-014).
     */
    const prior = this.#db
      .prepare(`SELECT MAX(attempt_no) AS n FROM attempts WHERE call_id = ?`)
      .get(call.id);
    let attemptNo = prior?.n ?? 0;
    let lastError = null;

    for (const provider of eligible) {
      attemptNo += 1;
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), provider.timeoutMs);

      try {
        // num_ctx is sized to the client's declared window, capped by what this provider can
        // actually do. Explicit per call -- never the provider default, which is the bug.
        const numCtx = Math.min(
          Math.max(minWindow, required),
          provider.effectiveContextWindow,
        );

        const result = await callProvider({
          provider,
          prompt: call.prompt,
          systemPrompt: call.system_prompt,
          params: call.params,
          numCtx,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const completedAt = Date.now();
        this.#recordAttempt(call.id, attemptNo, {
          providerId: provider.id,
          model: provider.model,
          providerVersion: result.providerVersion,
          startedAt,
          completedAt,
          latencyMs: completedAt - startedAt,
          status: "succeeded",
          requestPayload: redact(result.requestPayload),
          responseText: result.text,
          sentTokensEstimate,
          evaluatedTokens: result.evaluatedTokens,
          completionTokens: result.completionTokens,
          requestedNumCtx: result.requestedNumCtx,
          truncationDetected: false,
          doneReason: result.doneReason,
          outputTruncated: result.outputTruncated,
          costUsd: this.#cost(provider, result.evaluatedTokens, result.completionTokens),
        });

        return {
          status: "succeeded",
          output: result.text,
          providerId: provider.id,
          model: provider.model,
        };
      } catch (err) {
        clearTimeout(timer);
        const completedAt = Date.now();
        const failureKind = classifyFailure(err);

        this.#recordAttempt(call.id, attemptNo, {
          providerId: provider.id,
          model: provider.model,
          startedAt,
          completedAt,
          latencyMs: completedAt - startedAt,
          status: "failed",
          failureKind,
          errorMessage: err.message,
          sentTokensEstimate,
          evaluatedTokens: err.evaluatedTokens ?? null,
          requestedNumCtx: err.requestedNumCtx ?? null,
          truncationDetected: Boolean(err.truncationDetected),
        });

        lastError = err;

        // A harness fault (truncation) is Cortex's bug, not the provider's. Trying the next
        // provider would hide it behind a lucky success and teach the operator nothing.
        if (failureKind === FAILURE_HARNESS) {
          return {
            status: "failed",
            errorCode: "prompt_truncated",
            errorMessage: err.message,
            providerId: provider.id,
            model: provider.model,
          };
        }

        // A reachable model that answered badly is a quality signal about the prompt.
        // Falling through would launder that into "the provider was unavailable". BDD-013.
        if (!shouldFallBack(failureKind)) {
          return {
            status: "failed",
            errorCode: "content_failure",
            errorMessage: err.message,
            providerId: provider.id,
            model: provider.model,
          };
        }
        // Availability failure: move to the next provider in the chain.
      }
    }

    return {
      status: "exhausted",
      errorCode: "providers_exhausted",
      errorMessage:
        `All ${eligible.length} eligible provider(s) failed with availability errors. ` +
        `Last: ${lastError?.message ?? "unknown"}`,
      providerId: null,
      model: null,
    };
  }
}
