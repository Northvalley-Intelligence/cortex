/**
 * Provider chain and service configuration.
 *
 * The chain is configurable (MISSION.md:32). The default order mirrors the Command Center's
 * live config (Gemini -> OpenRouter -> local), which is also the order MISSION.md:32 names.
 * MISSION.md:45's "local-first" is honoured in the sense that local is the always-available
 * floor: it needs no quota and no network, so the chain never dead-ends on a cloud outage.
 * See OQ-1 in .mde/mission-clarification.md — Ferosh owns the default-order decision.
 *
 * effectiveContextWindow is the *effective* window, never the advertised one. Generation 0
 * proved Ollama advertises 131072 for llama3.2:3b while silently truncating at 4096 by
 * default (.mde/evidence/GEN-000-ollama-silent-truncation.md). For the ollama provider this
 * value is what Cortex will actually request via num_ctx, so it is true by construction.
 */

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Local model KV-cache cost is real: num_ctx is allocated per request. 32768 on a 3B model
 * is comfortable on this machine; raising the ceiling raises memory use, so it is a knob
 * rather than a constant.
 */
export const LOCAL_MAX_CONTEXT = envInt("CORTEX_LOCAL_MAX_CONTEXT", 32768);

export const DEFAULT_PROVIDERS = [
  {
    id: "gemini",
    kind: "openai_compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    timeoutMs: 30_000,
    // Gemini 2.5 Flash advertises ~1M. Cortex only needs a conservative true lower bound:
    // the value is used to decide eligibility, and understating it can never cause overflow.
    effectiveContextWindow: 1_000_000,
    costPer1kInputUsd: 0.0003,
    costPer1kOutputUsd: 0.0025,
    // Cloud providers safely serve parallel requests, so calls routed here need not queue
    // behind one another (MISSION.md:30 allows bounded concurrency where a provider supports
    // it). The local model, by contrast, is one-at-a-time (below).
    maxConcurrency: envInt("CORTEX_CLOUD_CONCURRENCY", 4),
  },
  {
    id: "openrouter",
    kind: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "poolside/laguna-xs-2.1:free",
    apiKeyEnv: "OPENROUTER_API_KEY",
    timeoutMs: 30_000,
    effectiveContextWindow: 32_768,
    costPer1kInputUsd: 0,
    costPer1kOutputUsd: 0,
    maxConcurrency: envInt("CORTEX_CLOUD_CONCURRENCY", 4),
  },
  {
    id: "local",
    kind: "ollama",
    // Cortex talks to Ollama directly rather than through the local_llm wrapper on :8000.
    // The wrapper pins a fixed global num_ctx=16384 and its OpenAI-compatible surface does
    // not expose prompt_eval_count -- Cortex needs both per call to size the window to the
    // client's declared floor and to prove no truncation occurred (BDD-008, BDD-012).
    baseUrl: process.env.CORTEX_OLLAMA_URL || "http://localhost:11434",
    model: process.env.CORTEX_LOCAL_MODEL || "llama3.2:3b",
    apiKeyEnv: "",
    timeoutMs: 180_000,
    effectiveContextWindow: LOCAL_MAX_CONTEXT,
    costPer1kInputUsd: 0,
    costPer1kOutputUsd: 0,
    // The local model handles exactly one call at a time (MISSION.md:30). This is the whole
    // reason concurrency is PER PROVIDER and not global: a cloud-bound call must not have to
    // wait behind a local call, but two local calls must still serialize.
    maxConcurrency: envInt("CORTEX_LOCAL_CONCURRENCY", 1),
  },
];

export function loadConfig(overrides = {}) {
  const chainEnv = process.env.CORTEX_PROVIDER_CHAIN;
  let providers = DEFAULT_PROVIDERS;
  if (chainEnv) {
    const wanted = chainEnv.split(",").map((s) => s.trim()).filter(Boolean);
    providers = wanted
      .map((id) => DEFAULT_PROVIDERS.find((p) => p.id === id))
      .filter(Boolean);
  }
  return {
    providers,
    port: envInt("CORTEX_PORT", 7077),
    dbPath: process.env.CORTEX_DB || "data/cortex.db",
    /** How long a call may be leased before it is considered abandoned and requeued. */
    leaseMs: envInt("CORTEX_LEASE_MS", 300_000),
    /**
     * Fairness floor (OQ-4, unanswered): guarantee a queued job-call is dispatched at least
     * every Nth dispatch, even under continuous call load. Default 4 => jobs get >=25% of
     * dispatch slots and cannot starve. Ferosh owns this number.
     */
    fairnessEveryNDispatches: envInt("CORTEX_FAIRNESS_EVERY_N", 4),
    defaultMinContextWindow: envInt("CORTEX_DEFAULT_MIN_CONTEXT", 8192),
    ...overrides,
  };
}

export function providerAvailable(provider) {
  if (!provider.apiKeyEnv) return true;
  return Boolean(process.env[provider.apiKeyEnv]);
}
