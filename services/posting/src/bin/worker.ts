// Outbox worker process: `tsx services/posting/src/bin/worker.ts`. Config from env (see src/config.ts).
// WORKER_PAUSE_AT=<crash point> makes it print "PAUSED <point>" and hang there (used by the SIGKILL test).
import { connect } from "../db.ts";
import { qboFromEnv } from "../config.ts";
import type { CrashPoint } from "../worker.ts";
import { OutboxWorker } from "../worker.ts";

const db = connect(process.env.DATABASE_URL);
const pauseAt = process.env.WORKER_PAUSE_AT as CrashPoint | undefined;
const worker = new OutboxWorker(db, qboFromEnv(db), {
  workerId: process.env.WORKER_ID,
  requestTimeoutMs: Number(process.env.QBO_TIMEOUT_MS ?? 15_000),
  ...(process.env.WORKER_LEASE_MS ? { leaseMs: Number(process.env.WORKER_LEASE_MS) } : {}),
  hooks: {
    async at(point) {
      if (point === pauseAt) {
        process.stdout.write(`PAUSED ${point}\n`);
        await new Promise(() => {}); // hang until killed
      }
    },
  },
});

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
while (!stopping) {
  const done = await worker.tick();
  if (done.length === 0) await new Promise((r) => setTimeout(r, Number(process.env.WORKER_IDLE_MS ?? 500)));
}
await db.end();
