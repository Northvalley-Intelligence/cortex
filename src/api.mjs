/**
 * HTTP API.
 *
 * Submit-and-retrieve for every caller (MISSION.md:44): submission returns an ID immediately
 * and never blocks on the model. The optional bounded `wait` on submit-call is a convenience
 * for callers migrating off a synchronous path (the Command Center's routing call blocks its
 * operator UI today) -- it is sugar over polling, it never changes the queue's semantics, and
 * it always returns the trace ID whether or not the answer arrived in time. See OQ-2.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Queue, normalizeCallInput } from "./queue.mjs";
import { getTrace, listTraces, traceFacets } from "./trace.mjs";
import { summary } from "./metrics.mjs";
import { eligibleProviders, contextFloor } from "./executor.mjs";
import { providerHealth } from "./providers/index.mjs";
import { providerAvailable } from "./config.mjs";
import { buildRelevanceJob, buildJudgePrompt, parseJudgment, ndcgForJudgments, buildJudgeSystemPrompt, rubricHash } from "./relevance.mjs";
import { computeJudgmentKey, lookupJudgment, storeJudgment, judgeModelScope, judgmentCacheStats, clearJudgmentCache } from "./cache.mjs";
import { storageStats, prune, prunablePreview } from "./maintenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 50_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });

/**
 * Reject unknown top-level fields at the HTTP boundary.
 *
 * This closes the exact hole a third-person review found: the handlers used to pre-pick
 * `body.system_prompt` before normalizeCallInput ran, so a typo like `sytsem_prompt` was
 * silently dropped at the only boundary real callers use -- reintroducing the very bug the
 * codebase claims to have fixed. An unknown field is far more often a misspelling of a real
 * one than a deliberate extra, and silently dropping it is how a system prompt goes missing
 * and a harness fault gets misread as a bad prompt.
 */
function rejectUnknownFields(body, allowed, res) {
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    json(res, 400, {
      error: `unrecognised field(s): ${unknown.join(", ")}. ` +
        `Allowed: ${[...allowed].join(", ")}. A misspelled field is silently ignored otherwise, ` +
        `so Cortex rejects it instead.`,
    });
    return false;
  }
  return true;
}

async function waitForTerminal(db, callId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare(`SELECT status FROM calls WHERE id = ?`).get(callId);
    if (row && ["succeeded", "failed", "exhausted"].includes(row.status)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function createApi(db, config) {
  const queue = new Queue(db, config);

  const routes = {
    "POST /v1/calls": async (req, res) => {
      const body = await readBody(req);
      const allowed = new Set([
        "client", "purpose", "prompt", "system_prompt", "params", "min_context_window", "wait_ms",
      ]);
      if (!rejectUnknownFields(body, allowed, res)) return;
      if (!body.client) return json(res, 400, { error: "client is required" });

      let normalized;
      try {
        // Single validation gate: catches a missing prompt AND any unknown call field.
        normalized = normalizeCallInput({
          prompt: body.prompt,
          system_prompt: body.system_prompt,
          params: body.params,
          min_context_window: body.min_context_window,
          purpose: body.purpose,
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }

      const id = queue.submitCall({
        client: body.client,
        purpose: normalized.purpose,
        prompt: normalized.prompt,
        systemPrompt: normalized.systemPrompt,
        params: normalized.params,
        minContextWindow: normalized.minContextWindow,
        priorityClass: "call",
      });

      // Bounded convenience wait. Sugar over polling; the queue is unchanged.
      const waitMs = Math.min(Number(body.wait_ms) || 0, 120_000);
      if (waitMs > 0) {
        const done = await waitForTerminal(db, id, waitMs);
        if (done) {
          const trace = getTrace(db, id);
          return json(res, 200, {
            call_id: id,
            trace_id: id,
            status: trace.status,
            output: trace.output,
            error: trace.error,
            resolved_by: trace.resolved_by,
          });
        }
        return json(res, 202, {
          call_id: id,
          trace_id: id,
          status: "pending",
          note: `Not finished within ${waitMs}ms. Poll GET /v1/calls/${id}. The work is queued and will complete.`,
        });
      }

      return json(res, 202, { call_id: id, trace_id: id, status: "queued" });
    },

    "POST /v1/jobs": async (req, res) => {
      const body = await readBody(req);
      const allowed = new Set(["client", "purpose", "calls", "params", "min_context_window", "metadata"]);
      if (!rejectUnknownFields(body, allowed, res)) return;
      if (!Array.isArray(body.calls) || body.calls.length === 0) {
        return json(res, 400, { error: "calls must be a non-empty array" });
      }
      if (!body.client) return json(res, 400, { error: "client is required" });

      // Pass the raw per-call objects straight to submitJob, which runs each through
      // normalizeCallInput -- the single validation gate. Pre-picking fields here (the old
      // code) is exactly what let a typo'd system_prompt slip through undetected. Job-level
      // params / min_context_window act as defaults a call may override.
      let calls;
      try {
        calls = body.calls.map((c, i) => {
          if (c == null || typeof c !== "object") throw new Error(`calls[${i}] must be an object`);
          const merged = { params: body.params, min_context_window: body.min_context_window, ...c };
          normalizeCallInput(merged); // validate now so a bad call fails the whole submit loudly
          return merged;
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }

      const { jobId, callIds } = queue.submitJob({
        client: body.client,
        purpose: body.purpose,
        calls,
        metadata: body.metadata ?? {},
      });
      return json(res, 202, { job_id: jobId, call_ids: callIds, trace_ids: callIds, status: "queued" });
    },

    "GET /v1/calls/:id": async (req, res, { id }) => {
      const trace = getTrace(db, id);
      if (!trace) return json(res, 404, { error: "unknown call id" });
      return json(res, 200, {
        call_id: trace.trace_id,
        trace_id: trace.trace_id,
        status: trace.status,
        output: trace.output,
        error: trace.error,
        resolved_by: trace.resolved_by,
      });
    },

    // The mission's core workflow: an ID in, the whole story out. MISSION.md:35
    "GET /v1/traces/:id": async (req, res, { id }) => {
      const trace = getTrace(db, id);
      if (!trace) return json(res, 404, { error: "unknown trace id" });
      return json(res, 200, trace);
    },

    // Distinct clients/purposes for the dashboard grid's filter dropdowns.
    "GET /v1/facets": async (req, res) => {
      return json(res, 200, traceFacets(db));
    },

    "GET /v1/traces": async (req, res, _p, url) => {
      const p = url.searchParams;
      // Returns { total, limit, offset, traces } so a grid can paginate and filter.
      return json(res, 200, listTraces(db, {
        limit: Number(p.get("limit")) || 50,
        offset: Number(p.get("offset")) || 0,
        status: p.get("status") ?? undefined,
        client: p.get("client") ?? undefined,
        provider: p.get("provider") ?? undefined,
        job: p.get("job") ?? undefined,
        purpose: p.get("purpose") ?? undefined,
        priorityClass: p.get("type") ?? undefined,
        q: p.get("q") ?? undefined,
      }));
    },

    // Paginated jobs list, straight from the jobs table so it is never crowded out by live-call
    // volume (the reason a submitted eval batch could look missing). Newest-first; supports
    // limit/offset paging and an optional client filter.
    "GET /v1/jobs": async (req, res, _p, url) => {
      return json(res, 200, queue.listJobs({
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
        client: url.searchParams.get("client") ?? undefined,
      }));
    },

    "GET /v1/jobs/:id": async (req, res, { id }) => {
      const job = queue.getJob(id);
      if (!job) return json(res, 404, { error: "unknown job id" });
      return json(res, 200, job);
    },

    "GET /v1/jobs/:id/results": async (req, res, { id }) => {
      const job = queue.getJob(id);
      if (!job) return json(res, 404, { error: "unknown job id" });
      const results = job.call_ids.map((cid) => {
        const t = getTrace(db, cid);
        return {
          call_id: cid,
          trace_id: cid,
          status: t.status,
          output: t.output,
          error: t.error,
          resolved_by: t.resolved_by,
        };
      });
      return json(res, 200, { job_id: id, status: job.status, counts: job.counts, results });
    },

    /**
     * Relevance evaluation: submit queries + ranked candidates, get graded judgments and NDCG.
     * The first live use case (MISSION.md:37). Each (query, product) pair becomes its own
     * traceable call, so every grade feeding the metric can be audited back to its prompt.
     */
    "POST /v1/relevance": async (req, res) => {
      const body = await readBody(req);
      if (!body.client) return json(res, 400, { error: "client is required" });
      if (!Array.isArray(body.queries) || body.queries.length === 0) {
        return json(res, 400, { error: "queries must be a non-empty array" });
      }
      // query_id is REQUIRED and must be unique. It is the NDCG join key: every judgment,
      // ranking, and per-query score is bucketed by it. A third-person review proved that
      // omitting it silently pools distinct queries into one bucket keyed on `undefined` and
      // emits a single plausible-but-meaningless mean_ndcg -- the exact "confident number from
      // missing data" the mission names as its top risk (MISSION.md:93). It must be as strict
      // as the product-id check, not looser.
      const seenQueryIds = new Set();
      for (const [i, q] of body.queries.entries()) {
        if (!q.query_id || typeof q.query_id !== "string") {
          return json(res, 400, {
            error: `queries[${i}] needs a stable string query_id. It is the NDCG join key; ` +
              `without it, distinct queries are silently merged into one fabricated score.`,
          });
        }
        if (seenQueryIds.has(q.query_id)) {
          return json(res, 400, { error: `duplicate query_id "${q.query_id}": query_ids must be unique to keep scores separate` });
        }
        seenQueryIds.add(q.query_id);
        if (!q.query || !Array.isArray(q.products) || q.products.length === 0) {
          return json(res, 400, { error: `queries[${i}] needs { query_id, query, products[] }` });
        }
        const seenProductIds = new Set();
        for (const [j, p] of q.products.entries()) {
          if (!p?.id || !p?.title) {
            return json(res, 400, {
              error: `queries[${i}].products[${j}] needs a stable { id, title }. ` +
                `Ranking metrics are keyed on id -- titles are not a safe join key.`,
            });
          }
          if (seenProductIds.has(p.id)) {
            return json(res, 400, { error: `queries[${i}] has a duplicate product id "${p.id}"` });
          }
          seenProductIds.add(p.id);
        }
      }

      // Optional caller-supplied domain rubric. Cortex wraps it in the fixed frame (scale +
      // JSON contract); the caller cannot override that. Reject a non-string or empty rubric
      // rather than silently ignoring it -- a dropped instruction is the exact silent-contract
      // break this service exists to prevent.
      if (body.rubric !== undefined) {
        if (typeof body.rubric !== "string" || !body.rubric.trim()) {
          return json(res, 400, { error: "rubric, if provided, must be a non-empty string of judging criteria" });
        }
        if (body.rubric.length > 20_000) {
          return json(res, 400, { error: "rubric too large (max 20000 chars)" });
        }
      }
      const usingDefaultRubric = body.rubric === undefined;
      const systemPrompt = buildJudgeSystemPrompt(body.rubric ?? null);
      const rubric_hash = rubricHash(systemPrompt);
      const effectiveParams = { temperature: 0, maxTokens: 120, ...(body.params ?? {}) };
      const modelScope = judgeModelScope(config);
      const bypassCache = body.fresh === true;

      // Read-through cache: judgments are deterministic (temp 0), so a repeat of the same
      // (prompt, system prompt, params, model) request is the SAME grade, not an approximation.
      // Partition each pair -- only misses become 60s+ model calls; hits are served from the
      // trace that first produced them. `fresh: true` forces a re-judge (still written through).
      const cached = [];
      const freshPairs = []; // aligned to the fresh calls, carries the key for write-through
      const missQueries = [];
      for (const q of body.queries) {
        const missProducts = [];
        for (const p of q.products) {
          const prompt = buildJudgePrompt({ query: q.query, product: p });
          const cache_key = computeJudgmentKey({ prompt, systemPrompt, params: effectiveParams, modelScope });
          const hit = bypassCache ? null : lookupJudgment(db, cache_key);
          if (hit) {
            cached.push({ query_id: q.query_id, product_id: p.id, grade: hit.grade, reason: hit.reason, source_trace_id: hit.source_trace_id, model: hit.model });
          } else {
            missProducts.push(p);
            freshPairs.push({ query_id: q.query_id, product_id: p.id, cache_key });
          }
        }
        if (missProducts.length) missQueries.push({ query_id: q.query_id, query: q.query, products: missProducts });
      }

      const calls = missQueries.length
        ? buildRelevanceJob({ queries: missQueries, params: body.params, minContextWindow: body.min_context_window, rubric: body.rubric ?? null })
        : [];
      const cacheSummary = { hits: cached.length, misses: freshPairs.length, bypassed: bypassCache };
      const { jobId, callIds } = queue.submitJob({
        client: body.client,
        purpose: "relevance_judgment",
        calls: calls.map(({ _meta, ...c }) => c),
        metadata: {
          kind: "relevance",
          k: body.k ?? null,
          pairs: freshPairs,
          cached,
          rubric_hash,
          using_default_rubric: usingDefaultRubric,
          cache: cacheSummary,
          rankings: Object.fromEntries(
            body.queries.map((q) => [q.query_id, q.products.map((p) => p.id)]),
          ),
        },
      });
      return json(res, 202, {
        job_id: jobId,
        call_ids: callIds,
        trace_ids: callIds,
        // A fully-cached batch has no calls to run and is already complete.
        status: calls.length ? "queued" : "complete",
        // Echoed so the caller can group grades by the exact instructions that produced them,
        // confirm whether their rubric was applied, and see how much the cache saved.
        rubric_hash,
        using_default_rubric: usingDefaultRubric,
        cache: cacheSummary,
        note: calls.length
          ? `Poll GET /v1/relevance/${jobId} for judgments and NDCG. ${cached.length} of ${cached.length + freshPairs.length} served from cache.`
          : `All ${cached.length} judgments served from cache. GET /v1/relevance/${jobId} for judgments and NDCG.`,
      });
    },

    "GET /v1/relevance/:id": async (req, res, { id }) => {
      const job = queue.getJob(id);
      if (!job) return json(res, 404, { error: "unknown job id" });
      if (job.metadata?.kind !== "relevance") {
        return json(res, 400, { error: "job is not a relevance job" });
      }

      const pairs = job.metadata.pairs ?? [];
      const byQuery = new Map();
      const failures = [];
      const ensure = (qid) => { if (!byQuery.has(qid)) byQuery.set(qid, []); return byQuery.get(qid); };

      // Seed judgments that were served from cache at submit time. Each carries the trace_id it
      // originally came from, so a cached grade is still auditable in the viewer, not anonymous.
      for (const cj of job.metadata.cached ?? []) {
        ensure(cj.query_id).push({ product_id: cj.product_id, trace_id: cj.source_trace_id, grade: cj.grade, reason: cj.reason, from_cache: true });
      }

      job.call_ids.forEach((cid, i) => {
        const pair = pairs[i];
        if (!pair) return;
        const t = getTrace(db, cid);
        if (t.status !== "succeeded") {
          failures.push({ trace_id: cid, query_id: pair.query_id, product_id: pair.product_id, status: t.status, error: t.error });
          return;
        }
        try {
          const j = parseJudgment(t.output);
          ensure(pair.query_id).push({ product_id: pair.product_id, trace_id: cid, ...j, from_cache: false });
          // Write-through: persist this fresh, parseable grade so a future identical request is
          // served from cache. INSERT OR IGNORE, so repeated polls neither clobber nor double-count.
          if (pair.cache_key) {
            storeJudgment(db, { key: pair.cache_key, grade: j.grade, reason: j.reason, sourceTraceId: cid, model: t.resolved_by?.model ?? null, now: Date.now() });
          }
        } catch (err) {
          // A grade we cannot parse is recorded as a failure, never coerced to 0. Coercing
          // would feed a fabricated judgment into NDCG and produce a confident wrong number.
          failures.push({ trace_id: cid, query_id: pair.query_id, product_id: pair.product_id, status: "unparseable", error: { message: err.message } });
        }
      });

      const results = [...byQuery.entries()].map(([queryId, judgments]) => ({
        query_id: queryId,
        judgments,
        metrics: ndcgForJudgments({
          ranking: job.metadata.rankings?.[queryId] ?? judgments.map((j) => j.product_id),
          judgments,
          k: job.metadata.k ?? null,
        }),
      }));

      const scored = results.filter((r) => r.metrics.ndcg != null);
      return json(res, 200, {
        job_id: id,
        status: job.status,
        counts: job.counts,
        rubric_hash: job.metadata.rubric_hash ?? null,
        using_default_rubric: job.metadata.using_default_rubric ?? null,
        cache: job.metadata.cache ?? null,
        queries: results,
        mean_ndcg: scored.length
          ? scored.reduce((s, r) => s + r.metrics.ndcg, 0) / scored.length
          : null,
        scored_queries: scored.length,
        unscored_queries: results.length - scored.length,
        failures,
      });
    },

    "GET /v1/metrics": async (req, res, _p, url) => {
      const sinceParam = url.searchParams.get("since_ms");
      return json(res, 200, summary(db, sinceParam ? Number(sinceParam) : null));
    },

    /**
     * The capability contract (MISSION.md:33). Lets a client discover, before submitting,
     * which providers can honour a given window and what the resulting prompt budget is --
     * rather than finding out via a failure.
     */
    "GET /v1/capabilities": async (req, res, _p, url) => {
      const requested = Number(url.searchParams.get("min_context_window")) || config.defaultMinContextWindow;
      const eligible = eligibleProviders(config.providers, requested);
      return json(res, 200, {
        requested_min_context_window: requested,
        effective_prompt_budget: contextFloor(eligible),
        satisfiable: eligible.length > 0,
        eligible_providers: eligible.map((p) => ({
          id: p.id,
          model: p.model,
          effective_context_window: p.effectiveContextWindow,
        })),
        ineligible_providers: config.providers
          .filter((p) => !eligible.includes(p))
          .map((p) => ({
            id: p.id,
            model: p.model,
            effective_context_window: p.effectiveContextWindow,
            reason: !providerAvailable(p)
              ? `missing ${p.apiKeyEnv}`
              : `effective context window ${p.effectiveContextWindow} < requested ${requested}`,
          })),
        note:
          "effective_prompt_budget is the smallest effective window among eligible providers. " +
          "Prompts must fit it regardless of which provider ends up handling the work.",
      });
    },

    // Storage use + a prune preview, so the operator sees impact before deleting anything.
    "GET /v1/admin/storage": async (req, res, _p, url) => {
      const stats = storageStats(db, config.dbPath);
      const previews = {};
      for (const [k, days] of [["7d", 7], ["30d", 30]]) {
        previews[k] = prunablePreview(db, { olderThanMs: days * 86_400_000 });
      }
      previews.all = prunablePreview(db, { all: true });
      return json(res, 200, { ...stats, judgment_cache: judgmentCacheStats(db), prunable: previews });
    },

    // Prune terminal TRACES to reclaim space. Requires an explicit target — no implicit
    // delete-all. In-flight work is never touched. This does not affect the judgment cache,
    // which is a separate resource cleared via POST /v1/admin/cache/clear.
    "POST /v1/admin/prune": async (req, res) => {
      const body = await readBody(req);
      const days = Number(body.older_than_days);
      if (body.all === true) return json(res, 200, prune(db, { all: true, dbPath: config.dbPath }));
      if (Number.isFinite(days) && days > 0) return json(res, 200, prune(db, { olderThanMs: days * 86_400_000, dbPath: config.dbPath }));
      return json(res, 400, { error: "provide older_than_days (>0) or all:true. To clear the judgment cache, use POST /v1/admin/cache/clear." });
    },

    // The judgment cache is its own resource. Clearing it deletes no traces; it only forces
    // deterministic judgments to re-run next time (the escape hatch after an in-place model
    // update the cache key cannot detect).
    "POST /v1/admin/cache/clear": async (req, res) => {
      return json(res, 200, { cleared_cache_entries: clearJudgmentCache(db) });
    },

    "GET /v1/health": async (req, res) => {
      const providers = await Promise.all(
        config.providers.map(async (p) => ({
          id: p.id,
          model: p.model,
          ...(await providerHealth(p).catch((e) => ({ ok: false, reason: e.message }))),
        })),
      );
      return json(res, 200, { ok: true, queue: queue.depth(), providers });
    },
  };

  const matchRoute = (method, pathname) => {
    for (const [key, handler] of Object.entries(routes)) {
      const [rm, rp] = key.split(" ");
      if (rm !== method) continue;
      const rParts = rp.split("/").filter(Boolean);
      const pParts = pathname.split("/").filter(Boolean);
      if (rParts.length !== pParts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < rParts.length; i += 1) {
        if (rParts[i].startsWith(":")) params[rParts[i].slice(1)] = decodeURIComponent(pParts[i]);
        else if (rParts[i] !== pParts[i]) { ok = false; break; }
      }
      if (ok) return { handler, params };
    }
    return null;
  };

  // Static pages. The dashboard and the trace viewer share the same data endpoints below;
  // the viewer is the formatted job->call prompt/output reader.
  const PAGES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/viewer": "viewer.html",
    "/viewer.html": "viewer.html",
    "/settings": "settings.html",
    "/settings.html": "settings.html",
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && PAGES[url.pathname]) {
        const html = readFileSync(join(HERE, "..", "public", PAGES[url.pathname]));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      const match = matchRoute(req.method, url.pathname);
      if (!match) return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      await match.handler(req, res, match.params, url);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  return { server, queue };
}
