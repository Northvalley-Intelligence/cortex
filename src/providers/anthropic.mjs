/**
 * Anthropic Messages API provider (pinned-only; see PINNED_PROVIDERS in config.mjs).
 *
 * POST {baseUrl}/v1/messages with `x-api-key` from the env var named by provider.apiKeyEnv and
 * `anthropic-version: 2023-06-01`. The key lives only in the request header: it is never put in
 * the recorded request payload, an error message, or a log line.
 *
 * Vision: params.images = [{ id, url }] become `{"type":"image","source":{"type":"url",...}}`
 * blocks after the prompt text, each preceded by a text block naming the item it belongs to.
 *
 * Availability (the call cannot be answered right now): 429, 529, any 5xx, overloaded, rate
 * limit, and an exhausted credit balance. A pinned call has nowhere to fall through to, so these
 * end the call as `exhausted`.
 */
import { ProviderError, FAILURE_AVAILABILITY, FAILURE_CONTENT } from "../failures.mjs";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const ANTHROPIC_VERSION = "2023-06-01";
const AVAILABILITY_BODY = /(overloaded|rate.?limit|credit balance|insufficient|billing|quota)/i;

export function buildAnthropicBody({ provider, prompt, systemPrompt, params }) {
  const content = [{ type: "text", text: prompt }];
  for (const img of params.images ?? []) {
    content.push({ type: "text", text: `Image for item ${img.id}:` });
    content.push({ type: "image", source: { type: "url", url: img.url } });
  }
  return {
    model: provider.model,
    // Current models reject temperature/top_p/top_k (HTTP 400), so none is ever sent. Adaptive
    // thinking spends output tokens, hence the large default budget.
    max_tokens: params.maxTokens ?? 16000,
    output_config: {
      effort: EFFORT_LEVELS.includes(params.effort) ? params.effort : "medium",
      ...(params.output_schema ? { format: { type: "json_schema", schema: params.output_schema } } : {}),
    },
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: "user", content }],
  };
}

export async function callAnthropic({ provider, prompt, systemPrompt, params, signal }) {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "";
  if (!apiKey) {
    throw new ProviderError(`${provider.id}: missing ${provider.apiKeyEnv}`, {
      failureKind: FAILURE_AVAILABILITY,
      provider: provider.id,
    });
  }

  const body = buildAnthropicBody({ provider, prompt, systemPrompt, params });

  let res;
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ProviderError(`${provider.id} transport: ${err.message}`, {
      failureKind: FAILURE_AVAILABILITY,
      provider: provider.id,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const unavailable =
      res.status === 429 || res.status === 529 || res.status >= 500 ||
      res.status === 401 || res.status === 403 || AVAILABILITY_BODY.test(text);
    throw new ProviderError(`${provider.id} ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      provider: provider.id,
      ...(unavailable ? { failureKind: FAILURE_AVAILABILITY } : {}),
    });
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new ProviderError(`${provider.id}: model refused (${data.stop_details?.category ?? "unspecified"})`, {
      failureKind: FAILURE_CONTENT,
      provider: provider.id,
    });
  }
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!Array.isArray(data.content)) {
    throw new ProviderError(`${provider.id}: response contained no content`, { provider: provider.id });
  }
  const usage = data.usage ?? {};
  const doneReason = data.stop_reason ?? null;
  return {
    text,
    evaluatedTokens: usage.input_tokens ?? null,
    completionTokens: usage.output_tokens ?? null,
    requestedNumCtx: null,
    truncationDetected: false,
    doneReason,
    outputTruncated: doneReason === "max_tokens",
    providerVersion: data.model ?? provider.model,
    requestPayload: body,
  };
}

export async function anthropicHealth(provider) {
  if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
    return { ok: false, reason: `missing ${provider.apiKeyEnv}` };
  }
  return { ok: true, reason: null };
}
