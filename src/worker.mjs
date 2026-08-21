/**
 * The worker loop.
 *
 * Concurrency is PER PROVIDER, not global (MISSION.md:30: "bounded concurrency only where a
 * provider safely supports it"). The local model handles one call at a time, so its limit is
 * 1; cloud providers safely serve parallel requests, so theirs is higher. The consequence
 * that matters: a call bound for Gemini no longer waits behind a local call — it fans out to
 * the cloud while the local model churns through its own one-at-a-time queue.
 *
 * A call is accounted against its PRIMARY provider — the first one eligible for its declared
 * context window. Fallback can still land a cloud-primary call on local, and the local runtime
 * simply queues it (Ollama serialises internally), so accounting by primary is both the useful
 * signal and safe: we never block a fallback waiting for a slot.
 */
import { Executor, eligibleProviders } from "./executor.mjs";

export class Worker {
  #queue;
  #executor;
  #providers;
  #capByProvider = new Map();
  #inFlightByProvider = new Map();
  #globalMax;
  #running = false;
  #inFlightTotal = 0;
  #idleMs;
  #timer = null;

  constructor(db, queue, config) {
    this.#queue = queue;
    this.#executor = new Executor(db, config);
    this.#providers = config.providers;
    this.#idleMs = config.idleMs ?? 250;
    for (const p of config.providers) {
      this.#capByProvider.set(p.id, Math.max(1, p.maxConcurrency ?? 1));
    }
    // The global ceiling is the sum of per-provider limits: every provider can be busy at once,
    // but no provider beyond its own limit.
    this.#globalMax = [...this.#capByProvider.values()].reduce((a, b) => a + b, 0) || 1;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    // Recover anything a previous process left leased when it died. BDD-004.
    this.#queue.reclaimExpiredLeases();
    this.#tick();
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    while (this.#inFlightTotal > 0) await new Promise((r) => setTimeout(r, 50));
  }

  #schedule(ms) {
    if (!this.#running) return;
    this.#timer = setTimeout(() => this.#tick(), ms);
    this.#timer.unref?.();
  }

  /** First eligible provider for a call's declared window — the one it will try first. */
  #primaryProvider(minContextWindow) {
    return eligibleProviders(this.#providers, minContextWindow)[0] ?? null;
  }

  /** True if the call's primary provider still has a free slot (or needs none). */
  #hasCapacity(row) {
    const primary = this.#primaryProvider(row.min_context_window);
    // No eligible provider: the executor fails it fast without touching a provider, so it
    // consumes no slot and is always runnable.
    if (!primary) return true;
    return (this.#inFlightByProvider.get(primary.id) ?? 0) < this.#capByProvider.get(primary.id);
  }

  async #tick() {
    if (!this.#running) return;
    if (this.#inFlightTotal >= this.#globalMax) return this.#schedule(this.#idleMs);

    const call = this.#queue.lease(Date.now(), (row) => this.#hasCapacity(row));
    if (!call) return this.#schedule(this.#idleMs);

    const primary = this.#primaryProvider(call.min_context_window);
    if (primary) this.#inFlightByProvider.set(primary.id, (this.#inFlightByProvider.get(primary.id) ?? 0) + 1);
    this.#inFlightTotal += 1;

    this.#runCall(call).finally(() => {
      if (primary) this.#inFlightByProvider.set(primary.id, this.#inFlightByProvider.get(primary.id) - 1);
      this.#inFlightTotal -= 1;
      this.#schedule(0);
    });

    // Greedily try to fill another slot in the same turn, so multiple cloud calls start
    // together instead of one-per-idle-tick.
    this.#schedule(0);
  }

  async #runCall(call) {
    try {
      const result = await this.#executor.execute(call);
      this.#queue.complete(call.id, result);
    } catch (err) {
      // The executor records its own attempts, so an escape here is a Cortex bug rather than a
      // provider failure. Mark it terminal instead of leaving the call leased forever.
      this.#queue.complete(call.id, {
        status: "failed",
        errorCode: "internal_error",
        errorMessage: `Cortex internal error: ${err.message}`,
      });
    }
  }

  /** Drain the queue and return. Used by tests and batch runs; runs calls to completion. */
  async runUntilIdle({ timeoutMs = 600_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = this.#queue.lease();
      if (!call) {
        const depth = this.#queue.depth();
        if (depth.queued_calls + depth.queued_job_calls === 0) return;
        if (Date.now() > deadline) throw new Error("runUntilIdle timed out");
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      await this.#runCall(call);
      if (Date.now() > deadline) throw new Error("runUntilIdle timed out");
    }
  }
}
