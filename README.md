# Cortex

The shared LLM execution service for Northvalley Intelligence projects. Projects submit work
— latency-sensitive **calls** and batched **jobs** — and Cortex queues it, runs it against a
local model or a paid provider, records the full input and output of every call under a trace
ID, and makes results retrievable by that ID.

Cortex exists so language-model capability becomes durable shared infrastructure rather than
logic re-implemented in each project, and so every call is traceable enough to answer the one
question that matters: when an answer is wrong, was it the prompt or the model?

## Run

```bash
npm start      # http://127.0.0.1:7077  (dashboard at /)
npm test       # full BDD scenario suite
npm run validate  # the two-pass Validation Gate (requires real Ollama)
```

Provider credentials live in `.env.local` (gitignored). See `.env.local.example`.

The npm scripts also load the shared OpenRouter key file `~/code/.northvalley/openrouter.env` (if present) before `.env.local`. Later files override earlier ones, so a repo-local `.env.local` wins over the shared file, and a variable already set in the real environment wins over both.

## API

See `HANDOFF.md` for the full contract and per-caller retrofit guidance. Core endpoints:
`POST /v1/calls`, `POST /v1/jobs`, `POST /v1/relevance`, `GET /v1/traces/:id`,
`GET /v1/capabilities`, `GET /v1/metrics`, `GET /v1/health`.

### `POST /v1/search-eval` (listwise search evaluation)

Grades one search term against its whole ranked result list in a single model call (lists over
`params.window`, default 20, are split into overlapping windows of 5). `GET /v1/search-eval/:id`
returns the per-search scorecard (per-item grades aligned by id, `first_useful_position`,
`coverage`, `head_complete`, `score_0_100`) and the job's `findability_score` plus
`counts {works, failures, mixed, unresolved, failed}`.

Body: `client`, `provider` (REQUIRED: a provider id; the call is pinned to it, no fall-through),
`rubric` (REQUIRED, non-empty, max 20000 chars; no default is applied), `searches[]`
(`search_id`, `query`, optional `task`, `interpretations`, `applicable_ids`, and `results[]` of
`{id, position, type, title, description, attributes, image_url, event_date}`), optional
`params` (`window`, `maxTokens`, `temperature`), `min_context_window`, `fresh`.
`provider` may also be `claude-haiku` or `claude-sonnet` (needs `ANTHROPIC_API_KEY`; these are
pinned-only and never join the fallback chain). The score weights are a draft in `SCORE_WEIGHTS`
(`src/search-eval.mjs`).

## How it's built

Zero runtime dependencies — Node's built-in `node:sqlite` and `node:http`. Durable queue and
trace store in SQLite (leases survive machine sleep). Provider chain configurable via
`CORTEX_PROVIDER_CHAIN`. MDE project state is in `.mde/`.

## Experiments

- [`experiments/relevancy-replacement/`](experiments/relevancy-replacement/) — **CPU vs GPU
  Battle, Round 1**: can a laptop grade e-commerce search relevance on a 0–3 scale, and when is
  the GPU worth it? Four arms (BM25, a prompted local LLM, a fine-tuned bge cross-encoder, and a
  LoRA-tuned generative model) with an honest, reproducible scorecard. Written up in the
  [CPU vs GPU Battle](https://feroshjacob.github.io/series/cpu-vs-gpu-battle/) series.
