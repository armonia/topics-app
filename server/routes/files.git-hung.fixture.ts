/**
 * Body of `files.git-hung.test.ts`, run in a separate process: `Bun.spawn`
 * without `env` uses the PATH SNAPSHOT taken when the process started, so a fake
 * `git` is only seen if it is in the PATH the process starts with. Prints the
 * timings as JSON.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFilesRouter } from "./files";

const dir = process.argv[2]!;

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function timed(method: string, path: string, body?: unknown): Promise<{ ms: number; status: number }> {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const t0 = performance.now();
  const res = await router(req, url, url.pathname, method);
  await res!.text();
  return { ms: Math.round(performance.now() - t0), status: res!.status };
}

const src = join(dir, "src");
mkdirSync(src);
writeFileSync(join(src, "a.txt"), "a");
const target = join(dir, "target");

const out = {
  diff: await timed("GET", `/api/git/diff?path=${encodeURIComponent(dir)}&file=x.txt`),
  log: await timed("GET", `/api/git/log?path=${encodeURIComponent(dir)}`),
  stageAll: await timed("POST", "/api/git/stage-all", { path: dir }),
  pull: await timed("POST", "/api/git/pull", { path: dir }),
  copy: await timed("POST", "/api/files/copy", { from: src, to: target }),
  duplicate: await timed("POST", "/api/files/duplicate", { path: src }),
  leftovers: { target: existsSync(target), srcCopy: existsSync(join(dir, "src copy")) },
};
console.log(JSON.stringify(out));
process.exit(0);
