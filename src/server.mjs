/**
 * Entrypoint: HTTP API + worker loop in one process.
 *
 * Loopback-only by design. MISSION.md:40 puts multi-user access control and off-machine
 * hosting out of scope, so binding to 127.0.0.1 keeps the service's reach matched to its
 * threat model -- the trace store holds every prompt this portfolio has ever sent.
 */
import { openDb } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { createApi } from "./api.mjs";
import { Worker } from "./worker.mjs";

const config = loadConfig();
const db = openDb(config.dbPath);
const { server, queue } = createApi(db, config);
const worker = new Worker(db, queue, config);

const reclaimed = queue.reclaimExpiredLeases();
if (reclaimed > 0) {
  console.log(`[cortex] recovered ${reclaimed} call(s) whose lease expired while the process was down`);
}

worker.start();

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[cortex] listening on http://127.0.0.1:${config.port}`);
  console.log(`[cortex] provider chain: ${config.providers.map((p) => `${p.id}(${p.model})`).join(" -> ")}`);
  console.log(`[cortex] db: ${config.dbPath}`);
});

const shutdown = async (signal) => {
  console.log(`[cortex] ${signal} received, draining in-flight work`);
  server.close();
  await worker.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
