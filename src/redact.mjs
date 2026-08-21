/**
 * Secret redaction for persisted traces.
 *
 * Cortex is the first component in this portfolio to durably persist full LLM inputs
 * (MISSION.md:5). That is the point of the service -- and it is also a new risk that did not
 * exist before: the trace store is a large, long-lived, plain-text record of everything sent
 * to a model. If a credential ever reaches it, the trace store silently becomes a credential
 * store.
 *
 * Two rules follow, and both are structural rather than best-effort:
 *
 *   1. Cortex records the payload it SENT TO THE PROVIDER, never the caller's raw state.
 *      Callers redact their own context before submission (the Command Center already does
 *      this), so Cortex must not reach behind that boundary. See OQ-3.
 *   2. Cortex's own auth material must never be written. Provider API keys travel in HTTP
 *      headers and are never part of the recorded payload -- but this pass is a backstop for
 *      keys that appear in prompt text, which is exactly the accident worth catching.
 *
 * This is a safety net, not a licence to send secrets through. VS-TRACE scans the store
 * independently.
 */

const SECRET_PATTERNS = [
  // Provider key formats
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-<redacted>"],
  [/\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, "sk-or-v1-<redacted>"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza<redacted>"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_<redacted>"],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer <redacted>"],
  // key=value / "key": "value" shapes
  [
    /\b((?:api[_-]?key|apikey|secret|token|password|passwd|authorization)\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
    "$1<redacted>",
  ],
];

function redactString(value) {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Backstop: if a live key from this process's own environment somehow appears verbatim,
  // remove it regardless of shape.
  for (const name of ["GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join(`<${name}>`);
    }
  }
  return out;
}

/** Deep-redact a payload before it is persisted. Returns a copy; never mutates the input. */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Never persist an auth header even if an adapter someday includes one.
      if (/^(authorization|api[_-]?key|x-api-key)$/i.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

/** Used by the trace-integrity validation to assert the store holds no credential-shaped strings. */
export function findSecrets(text) {
  const hits = [];
  for (const [pattern] of SECRET_PATTERNS) {
    const matches = String(text).match(pattern);
    if (matches) hits.push(...matches);
  }
  return hits;
}
