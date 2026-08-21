import { callOllama, ollamaHealth } from "./ollama.mjs";
import { callOpenAiCompatible, openAiCompatibleHealth } from "./openai-compatible.mjs";

const ADAPTERS = {
  ollama: { call: callOllama, health: ollamaHealth },
  openai_compatible: { call: callOpenAiCompatible, health: openAiCompatibleHealth },
};

/**
 * Resolve a provider's adapter.
 *
 * `__adapter` is the test seam: it lets a scenario inject a provider that reproduces a real
 * failure shape (silent truncation, quota exhaustion) without stubbing the network. The seam
 * sits here rather than at `fetch` so the fakes model provider *behaviour* rather than HTTP
 * bytes -- the behaviour is what the mission's scenarios are about.
 */
export function adapterFor(provider) {
  if (provider.__adapter) return { call: provider.__adapter, health: async () => ({ ok: true }) };
  const adapter = ADAPTERS[provider.kind];
  if (!adapter) throw new Error(`unknown provider kind: ${provider.kind}`);
  return adapter;
}

export async function callProvider(args) {
  return adapterFor(args.provider).call(args);
}

export async function providerHealth(provider, signal) {
  return adapterFor(provider).health(provider, signal);
}
