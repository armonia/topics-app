// V3 B2 · T5: p50/p95 of the two routes T5 changed, on a seeded isolated test server.
// Same corpus as check:route-latency (150 topics, 3000 messages on the first, 150 tasks),
// then 200 samples per route, round robin, 10 warm-up rounds thrown away.
// Usage: bun bench-routes.ts <repo-dir> <label> [port]
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";

const [repo, label, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 13471);
const dataDir = `/tmp/v3-bench-routes-${port}`;
rmSync(dataDir, { recursive: true, force: true });
const child = spawn("bash", [resolve(repo!, "scripts/start-test-server.sh")], {
  cwd: repo, detached: true, stdio: ["ignore", "ignore", "ignore"],
  env: {
    ...process.env, BUN_PORT: String(port), DATA_DIR: dataDir, TOPICS_HOME: `${dataDir}/.topics-home`,
    OPENCLAW_DIR: `${dataDir}/.openclaw`, TOPICS_PTY_SOCKET: `/tmp/v3-pty-${port}.sock`,
    TOPICS_AI_BRIDGE_SOCKET: `/tmp/v3-ai-${port}.sock`, NO_TLS: "1", TOPICS_E2E: "1", SERVER_HOST: "127.0.0.1",
  },
});
const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);
const base = `http://127.0.0.1:${port}`;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function batches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
for (let i = 0; i < 160; i++) {
  try { await fetch(`${base}/api/version`); break; } catch { await Bun.sleep(250); }
}
await api("/api/boards/bench-v3/settings", { method: "PATCH", body: JSON.stringify({ autoDispatch: false, maxAgents: 1 }) });
await batches([...Array(150).keys()], 8, async (i) => { await api("/api/topics", { method: "POST", body: JSON.stringify({ name: `Route bench ${String(i).padStart(3, "0")}` }) }); });
const all = await api("/api/topics");
const target = Object.values(all.topics as Record<string, any>).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))[0] as any;
await batches([...Array(3000).keys()], 16, async (i) => {
  await api("/api/test/seed-message", { method: "POST", body: JSON.stringify({ sessionKey: target.sessionKey, role: i % 2 ? "assistant" : "user", content: `Messaggio ${i} del banco. `.repeat(12), sortOrder: i }) });
});
await batches([...Array(150).keys()], 8, async (i) => {
  await api("/api/boards/bench-v3/tasks", { method: "POST", body: JSON.stringify({ text: `Task ${i}`, description: `Descrizione del task ${i}. `.repeat(45) }) });
});
const routes = {
  topic_messages: `/api/topics/${target.id}/messages?limit=200`,
  history_40: `/api/history/${encodeURIComponent(target.sessionKey)}?limit=40`,
};
const check = await api(routes.topic_messages);
if (check.total !== 3000 || check.messages.length !== 200) throw new Error(`corpus: total ${check.total}`);
const acc: Record<string, number[]> = { topic_messages: [], history_40: [] };
for (let round = 0; round < 210; round++) {
  for (const [k, p] of Object.entries(routes)) {
    const t0 = performance.now();
    const res = await fetch(`${base}${p}`);
    await res.text();
    const dt = performance.now() - t0;
    if (round >= 10) acc[k]!.push(dt);
  }
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100; };
const out: Record<string, unknown> = { label, load1: Math.round(loadavg()[0]! * 100) / 100 };
for (const [k, a] of Object.entries(acc)) out[k] = { p50: q(a, 0.5), p95: q(a, 0.95) };
console.log(JSON.stringify(out));
stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
