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

## API

See `HANDOFF.md` for the full contract and per-caller retrofit guidance. Core endpoints:
`POST /v1/calls`, `POST /v1/jobs`, `POST /v1/relevance`, `GET /v1/traces/:id`,
`GET /v1/capabilities`, `GET /v1/metrics`, `GET /v1/health`.

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
