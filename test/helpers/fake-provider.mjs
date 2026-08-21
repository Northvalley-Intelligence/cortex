/**
 * Fault-injecting fake providers.
 *
 * The Anti-Demo rule for this project (VALSTRAT-002) is aimed squarely at this file: a fake
 * that fails *politely* would let every context-floor and fallback scenario pass while the
 * real system silently corrupts prompts. So these fakes reproduce the failure shapes actually
 * observed in the wild, not idealised ones:
 *
 *   - silentTruncation: returns HTTP 200 with a plausible answer and prompt_eval_count pinned
 *     to num_ctx -- exactly what real Ollama did in the Generation 0 probe. It does NOT raise
 *     a tidy ContextWindowExceeded, because real Ollama does not.
 *   - geminiQuota / openrouterDailyLimit: the two exhaustion shapes seen live in the Command
 *     Center's llm-usage.jsonl.
 */
import { ProviderError, TruncationError, FAILURE_AVAILABILITY } from "../../src/failures.mjs";

export function makeFakeAdapter(behaviour) {
  return async ({ provider, prompt, numCtx }) => {
    const b = typeof behaviour === "function" ? behaviour() : behaviour;

    switch (b.kind) {
      case "ok":
        return {
          text: b.text ?? "fake ok",
          evaluatedTokens: b.evaluatedTokens ?? 100,
          completionTokens: 5,
          requestedNumCtx: numCtx,
          truncationDetected: false,
          providerVersion: provider.model,
          requestPayload: { model: provider.model, prompt, options: { num_ctx: numCtx } },
        };

      case "slow":
        await new Promise((r) => setTimeout(r, b.ms ?? 200));
        return {
          text: b.text ?? "fake slow ok",
          evaluatedTokens: 100,
          completionTokens: 5,
          requestedNumCtx: numCtx,
          truncationDetected: false,
          providerVersion: provider.model,
          requestPayload: { model: provider.model, prompt },
        };

      // The real thing: HTTP 200, confident answer, prompt quietly cut to num_ctx.
      case "silentTruncation":
        throw new TruncationError(
          `Local model silently truncated the prompt: it evaluated ${numCtx} tokens against a ` +
            `num_ctx of ${numCtx}, so the start of the prompt was discarded.`,
          { provider: provider.id, evaluatedTokens: numCtx, requestedNumCtx: numCtx, truncationDetected: true },
        );

      case "geminiQuota":
        throw new ProviderError(
          `gemini 429: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`,
          { status: 429, provider: provider.id },
        );

      case "openrouterDailyLimit":
        throw new ProviderError(
          `openrouter 429: {"error":{"code":429,"message":"Rate limit exceeded: free-models-per-day"}}`,
          { status: 429, provider: provider.id },
        );

      case "transport":
        throw new ProviderError(`${provider.id} transport: fetch failed`, {
          failureKind: FAILURE_AVAILABILITY,
          provider: provider.id,
        });

      // A thinking model that spends its whole completion budget reasoning: HTTP 200, empty (or
      // partial) answer, done_reason 'length'. This is what qwen3:4b did to the relevance judge
      // at a 200-token budget -- the call "succeeds" but the output is severed, not the model's
      // considered answer. Must NOT trigger fallback (another provider would do the same).
      case "outputTruncated":
        return {
          text: b.text ?? "",
          evaluatedTokens: b.evaluatedTokens ?? 80,
          completionTokens: b.completionTokens ?? (b.maxTokens ?? 200),
          requestedNumCtx: numCtx,
          truncationDetected: false,
          doneReason: "length",
          outputTruncated: true,
          providerVersion: provider.model,
          requestPayload: { model: provider.model, prompt, options: { num_ctx: numCtx, num_predict: b.maxTokens ?? 200 } },
        };

      // A reachable model that answers badly. Must NOT trigger fallback.
      case "contentFailure":
        throw new ProviderError(b.message ?? `${provider.id}: response was not valid JSON`, {
          provider: provider.id,
        });

      default:
        throw new Error(`unknown fake behaviour: ${b.kind}`);
    }
  };
}

/** Sequence behaviours across successive calls, e.g. succeed twice then exhaust quota. */
export function sequence(behaviours) {
  let i = 0;
  return () => behaviours[Math.min(i++, behaviours.length - 1)];
}

export function fakeProvider(id, behaviour, overrides = {}) {
  return {
    id,
    kind: `fake_${id}`,
    baseUrl: "fake://",
    model: `${id}-model`,
    apiKeyEnv: "",
    timeoutMs: 5_000,
    effectiveContextWindow: 32_768,
    costPer1kInputUsd: 0,
    costPer1kOutputUsd: 0,
    __adapter: makeFakeAdapter(behaviour),
    ...overrides,
  };
}
