// GET /api/git/branches on a clone with 40 local branches tracking an upstream.
// Usage: bun bench-branches.ts <repo-dir> <label> [samples=40]
// Prints one JSON line (p50/p95/mean ms over the samples) and writes the answer to golden-branches-<label>.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [repo, label, samplesArg] = process.argv.slice(2);
const SAMPLES = Number(samplesArg ?? 40);
const { createFilesRouter } = await import(join(repo!, "server/routes/files.ts"));

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
}

const root = mkdtempSync(join(tmpdir(), "bench-branches-"));
const origin = join(root, "origin.git"), seed = join(root, "seed"), work = join(root, "work");
git(root, "init", "-q", "--bare", origin);
git(root, "init", "-q", seed);
for (let i = 0; i < 30; i++) commit(seed, `base${i}`);
git(seed, "remote", "add", "origin", origin);
const names = Array.from({ length: 40 }, (_, i) => `feature/b${String(i).padStart(2, "0")}`);
for (const b of names) git(seed, "branch", b);
git(seed, "push", "-q", "origin", "--all");
git(root, "clone", "-q", origin, work);
for (const b of names) git(work, "branch", "-q", "--track", b, `origin/${b}`);
// A deterministic mix: every 3rd branch is 2 behind, every 4th is 1 ahead.
for (const [i, b] of names.entries()) {
  if (i % 3 === 0) { git(seed, "checkout", "-q", b); commit(seed, `r${i}a`); commit(seed, `r${i}b`); }
}
git(seed, "push", "-q", "origin", "--all");
git(work, "fetch", "-q", "origin");
for (const [i, b] of names.entries()) {
  if (i % 4 === 0) { git(work, "checkout", "-q", b); commit(work, `l${i}`); }
}
git(work, "checkout", "-q", "main");

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function once(): Promise<{ ms: number; body: string }> {
  const url = new URL(`http://x/api/git/branches?path=${encodeURIComponent(work)}`);
  const t0 = performance.now();
  const res = await router(new Request(url), url, url.pathname, "GET");
  const body = await res!.text();
  return { ms: performance.now() - t0, body };
}

for (let i = 0; i < 5; i++) await once();
const times: number[] = [];
let body = "";
for (let i = 0; i < SAMPLES; i++) { const r = await once(); times.push(r.ms); body = r.body; }
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!;
writeFileSync(join(import.meta.dir, `golden-branches-${label}.json`), JSON.stringify(JSON.parse(body), null, 1));
const round = (n: number) => Math.round(n * 100) / 100;
console.log(JSON.stringify({ label, samples: SAMPLES, branches: (JSON.parse(body) as unknown[]).length, p50: round(pct(50)), p95: round(pct(95)), mean: round(times.reduce((a, b) => a + b, 0) / times.length) }));
rmSync(root, { recursive: true, force: true });
process.exit(0);
