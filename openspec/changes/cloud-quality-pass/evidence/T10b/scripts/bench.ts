// T10 bench: GET /api/all-boards/tasks on the isolated test server, same task
// corpus as check:route-latency (150 tasks, 1200-char descriptions), then the
// same svc.list in-process on a copy of the seeded DB.
//
// usage: bun run bench.ts <repoRoot> <port> <out.json>
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const [repo, portArg, outPath] = process.argv.slice(2);
const REPO = resolve(repo!);
const port = Number(portArg);
const TASKS = 150, DESC = 1200, WARMUP = 10, SAMPLES = 200;
const dataDir = `/tmp/t10-bench-${port}`;
rmSync(dataDir, { recursive: true, force: true });

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const r2 = (n: number) => Math.round(n * 100) / 100;

const child = spawn("bash", [resolve(REPO, "scripts/start-test-server.sh")], {
  cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, BUN_PORT: String(port), DATA_DIR: dataDir,
    TOPICS_HOME: `${dataDir}/.topics-home`, OPENCLAW_DIR: `${dataDir}/.openclaw`,
    TOPICS_PTY_SOCKET: `/tmp/t10-pty-${port}.sock`, TOPICS_AI_BRIDGE_SOCKET: `/tmp/t10-ai-${port}.sock`,
    NO_TLS: "1", TOPICS_E2E: "1", SERVER_HOST: "127.0.0.1",
  },
});
let log = "";
child.stdout?.on("data", (d) => { log += d; });
child.stderr?.on("data", (d) => { log += d; });
const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch {} };
process.on("exit", stop);

const base = `http://127.0.0.1:${port}`;
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
  const t = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

for (let i = 0; ; i++) {
  try { await fetch(base + "/api/system/dispatch-capacity"); break; } catch {}
  if (i > 400) { console.error(log.slice(-2000)); process.exit(2); }
  await Bun.sleep(100);
}

// T10b: which Bun binary the SERVER runs (bash execs bun, so the child pid is bun).
const serverBun = (() => { try { return readlinkSync(`/proc/${child.pid}/exe`); } catch (e) { return String(e); } })();
await api("/api/boards/bench-route-latency/settings", { method: "PATCH", body: JSON.stringify({ autoDispatch: false, maxAgents: 1 }) });
for (let i = 0; i < TASKS; i += 8) {
  await Promise.all(Array.from({ length: Math.min(8, TASKS - i) }, (_, j) => api("/api/boards/bench-route-latency/tasks", {
    method: "POST",
    body: JSON.stringify({ text: `Task del banco numero ${i + j}`, description: `Descrizione del task ${i + j}. `.repeat(Math.ceil(DESC / 27)) }),
  })));
}

const routes = ["/api/all-boards/tasks", "/api/system/dispatch-capacity"];
const acc: Record<string, number[]> = Object.fromEntries(routes.map((r) => [r, []]));
let feedText = "";
for (let round = 0; round < WARMUP + SAMPLES; round++) {
  for (const r of routes) {
    const t0 = performance.now();
    const res = await fetch(base + r);
    const text = await res.text();
    const dt = performance.now() - t0;
    if (res.status !== 200) throw new Error(`${r} ${res.status}`);
    if (r === routes[0]) {
      feedText = text;
      if (JSON.parse(text).tasks.length !== TASKS) throw new Error("corpus mismatch");
    }
    if (round >= WARMUP) acc[r]!.push(dt);
  }
}
const raw = Buffer.byteLength(feedText);
const gz: number[] = [];
let gzBytes = 0;
for (let i = 0; i < 30; i++) { const t0 = performance.now(); gzBytes = Bun.gzipSync(Buffer.from(feedText)).byteLength; gz.push(performance.now() - t0); }

stop();
await Bun.sleep(1500);

// In-process: the same list call the route makes, on a copy of the seeded DB.
const copyDir = `${dataDir}-copy`;
rmSync(copyDir, { recursive: true, force: true });
mkdirSync(copyDir);
for (const f of ["topics.db", "topics.db-wal", "topics.db-shm"]) if (existsSync(`${dataDir}/${f}`)) copyFileSync(`${dataDir}/${f}`, `${copyDir}/${f}`);
const db = new Database(`${copyDir}/topics.db`);
const { createTaskService } = await import(resolve(REPO, "server/services/tasks.ts"));
const svc = createTaskService(db, {});
const args = { scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 };
const inproc: number[] = [], inprocJson: number[] = [];
for (let i = 0; i < WARMUP + SAMPLES; i++) {
  const t0 = performance.now();
  const tasks = svc.list(args);
  const t1 = performance.now();
  const s = JSON.stringify({ tasks });
  const t2 = performance.now();
  if (i >= WARMUP) { inproc.push(t1 - t0); inprocJson.push(t2 - t0); }
  if (s.length < 10) throw new Error("empty");
}

const out = {
  uptime: (await Bun.$`uptime`.text()).trim(),
  benchBun: Bun.version,
  serverBun,
  http: Object.fromEntries(routes.map((r) => [r, { p50: r2(q(acc[r]!, 0.5)), p95: r2(q(acc[r]!, 0.95)) }])),
  inProcess: { list_p50: r2(q(inproc, 0.5)), list_p95: r2(q(inproc, 0.95)), listJson_p50: r2(q(inprocJson, 0.5)), listJson_p95: r2(q(inprocJson, 0.95)) },
  bytes: { raw, gzip: gzBytes, gzip_ms_p50: r2(q(gz, 0.5)) },
  keysPerTask: Object.keys(JSON.parse(feedText).tasks[0]).length,
};
console.log(JSON.stringify(out, null, 2));
writeFileSync(outPath!, JSON.stringify(out, null, 2));
writeFileSync(outPath!.replace(/\.json$/, ".feed.json"), feedText);
rmSync(dataDir, { recursive: true, force: true });
if (!process.env.KEEP_DB) rmSync(copyDir, { recursive: true, force: true });
process.exit(0);
