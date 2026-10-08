// Profile svc.list on a seeded DB copy. usage: bun run prof.ts <repo> <dbPath> [iters]
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
const [repo, dbPath, it] = process.argv.slice(2);
const db = new Database(dbPath!);
const { createTaskService } = await import(resolve(repo!, "server/services/tasks.ts"));
const svc = createTaskService(db, {});
const args = { scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 };
const N = Number(it ?? 2000);
const xs: number[] = [];
for (let i = 0; i < N; i++) { const t0 = performance.now(); svc.list(args); xs.push(performance.now() - t0); }
xs.sort((a, b) => a - b);
console.log("list p50", xs[N >> 1]!.toFixed(2), "p95", xs[Math.floor(N * 0.95)]!.toFixed(2));
