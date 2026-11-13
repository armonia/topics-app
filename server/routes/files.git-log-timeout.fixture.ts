/**
 * Body of `files.git-log-timeout.test.ts`, run in a separate process so a fake
 * `git` in PATH is picked up by `Bun.spawn` (which snapshots PATH at process
 * start — same reasoning as `files.git-hung.fixture.ts`).
 */
import { createFilesRouter } from "./files";

const dir = process.argv[2]!;

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function call(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://x${path}`);
  const res = await router(new Request(url, { method }), url, url.pathname, method);
  return { status: res!.status, body: await res!.json() };
}

const out = {
  log: await call("GET", `/api/git/log?path=${encodeURIComponent(dir)}`),
  commitFiles: await call("GET", `/api/git/commit-files?path=${encodeURIComponent(dir)}&hash=abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd`),
};
console.log(JSON.stringify(out));
process.exit(0);
