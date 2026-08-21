# Evidence: Ollama silently truncates prompts at num_ctx=4096

- Generation: GEN-000
- Date: 2026-07-16
- Category: Technical Validation / Mission Coverage
- Severity: Critical
- Issue signature candidate: `LOCAL_MODEL_SILENT_PROMPT_TRUNCATION`

## Why this was probed

MISSION.md requires Cortex to enforce a client-declared context-window floor and to
fail clearly "rather than silently truncating" (MISSION.md:33, :47, :70). That guarantee
depends on knowing each provider's *effective* context window. This probe tested whether
the locally advertised capability is trustworthy.

## Advertised capability

`ollama show` reports for the installed local models:

| model         | advertised context length | num_ctx parameter set |
|---------------|---------------------------|-----------------------|
| qwen3:4b      | 262144                    | no                    |
| llama3.2:3b   | 131072                    | no                    |
| llama3.1:8b   | 131072                    | no                    |
| gemma4:latest | 131072                    | no                    |

No model sets `num_ctx`, so the Ollama server default applies.

## Probe

Needle-at-start test against `llama3.2:3b` via `POST http://localhost:11434/api/generate`:
a passphrase was placed in the first line, followed by ~10,500 tokens of filler, then a
question asking for the passphrase.

## Result

```
prompt_eval_count: 4096
response: "Nothing, it's just a repetition of the original text."
```

- ~10,500 tokens were sent; the model evaluated exactly **4096**.
- The prompt was truncated to the Ollama default `num_ctx` (4096).
- The needle was dropped, and the model returned a **plausible-but-wrong** answer.
- **No error, no warning. HTTP 200. Status: success.**

## Implications for Cortex

1. **Advertised context length is unusable as the floor input.** The effective local window
   is 4096 by default, 32x smaller than the advertised 131072. A floor computed from
   `ollama show` would be wrong by design and would let overflowing prompts through.
2. **The mission's "fail clearly, never truncate" guarantee is violated by the default
   local runtime**, not by Cortex logic. Cortex must set `num_ctx` explicitly per call and
   verify it, rather than trusting the provider default.
3. **Traceability as currently specified would be misleading in exactly the case that
   matters most.** A trace that records the prompt Cortex *sent* plus a success status
   would look healthy, while the model actually saw only the last 4096 tokens. Debugging
   that trace would wrongly "blame the prompt" for a harness failure.
   -> The trace schema must record what the model *actually consumed*
   (`prompt_eval_count` / effective `num_ctx`) alongside what was sent, and Cortex must
   treat `sent_tokens > evaluated_tokens` as a hard failure, not a success.
4. Ollama truncation drops the **beginning** of the prompt, which is typically where system
   instructions and output-format contracts live. Truncated calls therefore fail in a
   format-violating, hard-to-attribute way.

## Confirmed mitigation

The same probe re-run with an explicit `options.num_ctx` recovers the full window:

| call                     | tokens evaluated | needle recalled | answer                                  |
|--------------------------|------------------|-----------------|-----------------------------------------|
| default (no `num_ctx`)   | 4096             | no              | "Nothing, it's just a bunch of repeated text." |
| `options.num_ctx=16384`  | 12052            | yes             | `BLUE-HERON-42`                         |

So the local provider *can* honour a large window, but only when Cortex sets `num_ctx`
explicitly per call. This makes the required behaviour concrete:

- Cortex must send an explicit `num_ctx` on every local call, sized to the client's
  declared context-window requirement — never rely on the provider default.
- Cortex must assert `prompt_eval_count` equals the token count it intended to send, and
  fail the call loudly when it does not. This is the enforcement point for the mission's
  "fail clearly instead of truncating" guarantee.
- `num_ctx` costs memory (KV cache) at the requested size, so the declared context window
  has a real resource cost on the local machine. Sizing it per call from the client's
  declared floor — rather than globally maxing it — is both the correct and the cheap
  choice.

## Reproduction

`.mde/evidence/probes/ollama-context-probe.py`

Expected output on an unpatched default Ollama:

```
num_ctx=default: evaluated=4096 recalled_needle=False
num_ctx=16384:   evaluated=12052 recalled_needle=True
```
