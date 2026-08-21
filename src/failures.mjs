/**
 * Availability failures vs content failures.
 *
 * This distinction is the single most load-bearing rule in the fallback chain, and it is not
 * obvious. It is carried over deliberately from the Command Center, whose code comments the
 * reasoning: "a reachable model's bad answer is a quality signal, not an availability one."
 *
 * Two things break if content failures trigger fallback:
 *   1. One bad prompt burns the entire provider chain, turning a cheap local failure into
 *      three paid attempts.
 *   2. Worse -- and this is the mission-level harm -- a prompt defect gets laundered into an
 *      availability event. The dashboard would show "Gemini unreliable" when the truth is
 *      "this prompt is bad", which is the exact inverse of "blame the prompt, not the model"
 *      (MISSION.md:11). The trace would actively mislead.
 *
 * So: only failures that mean "this provider cannot answer right now" fall through.
 * BDD-013.
 */

export const FAILURE_AVAILABILITY = "availability";
export const FAILURE_CONTENT = "content";
/** Cortex's own guard tripped (e.g. truncation). Never a provider's fault, never falls through. */
export const FAILURE_HARNESS = "harness";

const AVAILABILITY_PATTERNS =
  /(429|quota|rate.?limit|exhaust|overload|unavailable|not ready|busy|50\d\b|timeout|timed out|fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|401|403|api key|permission denied|free-models-per-day)/i;

/**
 * Classify a provider failure.
 *
 * Errors already tagged by a provider adapter (which knows its own protocol) are trusted.
 * Everything else is matched against the shapes actually observed in production -- including
 * OpenRouter's "Rate limit exceeded: free-models-per-day" and Gemini's 429/quota responses,
 * both seen live in the Command Center's llm-usage.jsonl.
 */
export function classifyFailure(error) {
  if (error?.failureKind) return error.failureKind;
  const text = `${error?.status ?? ""} ${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  return AVAILABILITY_PATTERNS.test(text) ? FAILURE_AVAILABILITY : FAILURE_CONTENT;
}

export function shouldFallBack(failureKind) {
  return failureKind === FAILURE_AVAILABILITY;
}

/**
 * A quota / rate-limit exhaustion specifically (a subset of availability failures).
 *
 * The mission asks the dashboard to show "quota status" (MISSION.md:34). There is no provider
 * API that reports remaining quota, so quota status is derived from the exhaustion signals the
 * providers actually emit -- the same shapes seen live: Gemini's 429 RESOURCE_EXHAUSTED and
 * OpenRouter's "Rate limit exceeded: free-models-per-day". A transport error or a 500 is an
 * availability failure but NOT a quota signal, so those are excluded.
 */
const QUOTA_PATTERNS =
  /(429|quota|rate.?limit|exhaust|RESOURCE_EXHAUSTED|free-models-per-day|too many requests)/i;

export function isQuotaExhaustion(text) {
  return QUOTA_PATTERNS.test(String(text ?? ""));
}

export class ProviderError extends Error {
  constructor(message, { failureKind, status, code, provider } = {}) {
    super(message);
    this.name = "ProviderError";
    this.failureKind = failureKind;
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

/**
 * Cortex detected that the model silently truncated the prompt.
 *
 * This is a harness fault, not a prompt fault and not a provider outage. It gets its own
 * class so the trace can never confuse it with either. See BDD-018.
 */
export class TruncationError extends ProviderError {
  constructor(message, detail = {}) {
    super(message, { failureKind: FAILURE_HARNESS });
    this.name = "TruncationError";
    Object.assign(this, detail);
  }
}

/** The declared context window cannot be satisfied. Fails clearly; never truncates. MISSION.md:33 */
export class ContextFloorError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ContextFloorError";
    this.code = "context_window_exceeded";
    Object.assign(this, detail);
  }
}
