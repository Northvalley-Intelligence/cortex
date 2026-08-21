/**
 * Cloud providers speaking the OpenAI chat-completions protocol (Gemini, OpenRouter).
 *
 * Unlike the local runtime, these providers reject an oversized prompt explicitly rather than
 * truncating it silently, so Cortex does not need a post-hoc truncation check here -- the
 * context floor is enforced before dispatch (executor.mjs) and the provider's own error is
 * trustworthy if it slips through.
 *
 * Quota exhaustion is the failure that actually matters for these two. Both shapes below were
 * observed live in the Command Center's llm-usage.jsonl: Gemini returns 429/quota, OpenRouter
 * returns "Rate limit exceeded: free-models-per-day". Both must classify as availability
 * failures so the chain moves on (BDD-006).
 */
import { ProviderError, FAILURE_AVAILABILITY } from "../failures.mjs";

export async function callOpenAiCompatible({ provider, prompt, systemPrompt, params, signal }) {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "";
  if (provider.apiKeyEnv && !apiKey) {
    throw new ProviderError(`${provider.id}: missing ${provider.apiKeyEnv}`, {
      failureKind: FAILURE_AVAILABILITY,
      provider: provider.id,
    });
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = {
    model: provider.model,
    messages,
    temperature: params.temperature ?? 0.1,
    max_tokens: params.maxTokens ?? 1200,
  };
  // Pass through the knobs a caller genuinely depends on rather than dropping them silently.
  // The Command Center sets reasoning_effort specifically so a reasoning model does not spend
  // its output budget thinking, and needs JSON mode for strict-JSON routing output. A dropped
  // param that changes output shape is a silent contract break, so these are forwarded when
  // the caller provides them (and the provider ignores any it does not support).
  if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
  if (params.responseFormat) body.response_format = params.responseFormat;

  let res;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
    // Let classifyFailure read the status and body text; both carry the quota signal.
    throw new ProviderError(`${provider.id} ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      provider: provider.id,
    });
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) {
    throw new ProviderError(`${provider.id}: response contained no choices`, {
      provider: provider.id,
    });
  }

  const usage = data.usage ?? {};
  // finish_reason 'length' is the OpenAI-protocol equivalent of Ollama's done_reason 'length':
  // the completion was cut off at max_tokens. Normalised to the same fields so the trace and
  // diagnosis are provider-agnostic.
  const doneReason = choice.finish_reason ?? null;
  return {
    text: choice.message?.content ?? "",
    evaluatedTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    requestedNumCtx: null,
    truncationDetected: false,
    doneReason,
    outputTruncated: doneReason === "length",
    providerVersion: data.model ?? provider.model,
    requestPayload: body,
  };
}

export async function openAiCompatibleHealth(provider) {
  if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
    return { ok: false, reason: `missing ${provider.apiKeyEnv}` };
  }
  return { ok: true, reason: null };
}
