/**
 * A fake of the Claude Code cloud sessions API (`/v1/sessions`), enough for a
 * card that runs on the «Cloud Claude» machine to go from todo to review.
 *
 * The real VM clones the repo from GitHub, works, pushes its branch and ends
 * with a `result` event. Here the "VM" is a clone of the spec's local bare
 * origin: same push, same events, so everything after the API (the remote
 * lane, the bundle, the planted branch, the review) is the production path.
 *
 * The test server is pointed at it with `POST /api/test/claude-cloud`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCloudSession {
  id: string;
  branch: string;
  model: string;
  prompt: string;
  events: Array<Record<string, unknown>>;
}

export interface FakeClaudeCloud {
  baseUrl: string;
  sessions: FakeCloudSession[];
  close(): Promise<void>;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "cloud@e2e.test",
  GIT_COMMITTER_NAME: "Claude", GIT_COMMITTER_EMAIL: "cloud@e2e.test",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString().trim();

/**
 * @param originPath the bare repo the project's `origin` points at: the fake
 *        clones it, commits `file` on the branch the session was asked for and
 *        pushes it back, like the VM does with GitHub.
 * @param workMs how long the session "works" before it pushes and ends.
 */
export async function startFakeClaudeCloud(opts: {
  originPath: string;
  file: { path: string; content: string };
  summary: string;
  workMs?: number;
}): Promise<FakeClaudeCloud> {
  const sessions: FakeCloudSession[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "fake-cloud-"));
  let seq = 0;
  const ev = (s: FakeCloudSession, body: Record<string, unknown>) => {
    s.events.push({ uuid: `${s.id}-e${++seq}`, ...body });
  };

  function work(s: FakeCloudSession) {
    const dir = join(scratch, s.id);
    git(["clone", "-q", opts.originPath, dir]);
    git(["switch", "-q", "-c", s.branch], dir);
    writeFileSync(join(dir, opts.file.path), opts.file.content);
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "Lavoro della sessione cloud"], dir);
    git(["push", "-q", "origin", s.branch], dir);
    ev(s, { type: "assistant", message: { content: [{ type: "text", text: opts.summary }] } });
    ev(s, { type: "result", subtype: "success", result: opts.summary });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (url.pathname === "/v1/environment_providers") {
        return send(200, { environments: [{ environment_id: "env_e2e", kind: "anthropic_cloud", state: "active" }] });
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        const body = JSON.parse(raw) as {
          events: Array<{ data: { message: { content: string } } }>;
          session_context: { model: string; outcomes: Array<{ git_info: { branches: string[] } }> };
        };
        const s: FakeCloudSession = {
          id: `session_e2e${sessions.length + 1}`,
          branch: body.session_context.outcomes[0]!.git_info.branches[0]!,
          model: body.session_context.model,
          prompt: body.events[0]?.data.message.content ?? "",
          events: [],
        };
        sessions.push(s);
        ev(s, { type: "system", subtype: "init" });
        setTimeout(() => {
          try { work(s); } catch (err) { ev(s, { type: "result", subtype: "error_during_execution", result: String(err) }); }
        }, opts.workMs ?? 2500);
        return send(200, { id: s.id });
      }
      const m = /^\/v1\/sessions\/([^/]+)(\/events)?$/.exec(url.pathname);
      const s = m ? sessions.find((x) => x.id === m[1]) : undefined;
      if (!s) return send(404, { error: "unknown session" });
      if (!m![2]) return send(200, { id: s.id, session_status: "running" });
      if (req.method === "POST") return send(200, {});
      const after = url.searchParams.get("after_id");
      const from = after ? s.events.findIndex((e) => e.uuid === after) + 1 : 0;
      const data = s.events.slice(from);
      return send(200, { data, has_more: false, ...(data.length ? { last_id: data.at(-1)!.uuid } : {}) });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessions,
    close: () => new Promise<void>((r) => server.close(() => { rmSync(scratch, { recursive: true, force: true }); r(); })),
  };
}
