/**
 * The cron routes go through the `jarvis-channels cron` CLI, and a failure never reads as "no jobs".
 *
 * GET /api/cron/jobs once answered 200 `{jobs: [], warning}` on a scheduler
 * error, and the panel (which checks `res.ok` only) showed an empty list: the
 * jobs looked deleted while the scheduler was simply down. Il pianificatore di
 * Jarvis is `jarvis-channels`: the router gets a fake CLI, the wrapper a
 * fake script. No real job is read, run, or changed.
 * @covers CRON-01
 * @covers CRONRPC-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCronRouter, jarvisChannelsCron, readJobList, type CronCliResult } from "./cron";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Same contract as the server's matchRoute: `:name` segments become params.
function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const p = pattern.split("/"), a = pathname.split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

function routerWith(answer: (args: string[]) => CronCliResult) {
  const calls: string[][] = [];
  const broadcasts: unknown[] = [];
  const router = createCronRouter({
    readJSON: async (req: Request) => req.json(),
    json,
    matchRoute,
    broadcastToAll: (msg: unknown) => { broadcasts.push(msg); },
  } as never, async (args) => { calls.push(args); return answer(args); });
  const send = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`);
    const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
    return (await router(new Request(url, init), url, url.pathname, method))!;
  };
  return { calls, broadcasts, send };
}

// The shape of `jarvis-channels cron list --json --all`, measured on 07/11 (placeholder names).
const RAW = {
  jobs: [
    {
      id: "j1", name: "Giornata nel calendario", enabled: true,
      delivery: { mode: "none" }, payload: { kind: "command" },
      schedule: { kind: "every", everyMs: 1_800_000 },
      state: { consecutiveErrors: 0, lastDurationMs: 3990, lastError: null, lastRunAtMs: 1794053260137, lastStatus: "ok", nextRunAtMs: 1794055060137, runningAtMs: null },
    },
    {
      id: "j2", name: "Brief del mattino", enabled: false,
      delivery: { mode: "announce", channel: "whatsapp", to: "x" }, payload: { kind: "agentTurn" },
      schedule: { kind: "cron", expr: "30 7 * * *", tz: "Europe/Rome" },
      state: { lastRunAtMs: null, lastStatus: null, nextRunAtMs: null },
    },
  ],
};
const LIST_OUT = JSON.stringify(RAW);
const VIEW = [
  { id: "j1", name: "Giornata nel calendario", enabled: true, schedule: { kind: "every", everyMs: 1_800_000 }, nextRunAt: new Date(1794055060137).toISOString(), lastRunAt: new Date(1794053260137).toISOString(), lastStatus: "ok" },
  { id: "j2", name: "Brief del mattino", enabled: false, schedule: { kind: "cron", expr: "30 7 * * *", tz: "Europe/Rome" }, nextRunAt: null, lastRunAt: null, lastStatus: null },
];
const ok = (stdout = ""): CronCliResult => ({ ok: true, stdout });
const listOr = (other: CronCliResult) => (args: string[]) => (args[0] === "list" ? ok(LIST_OUT) : other);

describe("readJobList", () => {
  test("the CLI's jobs in the panel's shape, times in ISO", () => {
    expect(readJobList(LIST_OUT)).toEqual(VIEW);
  });

  test("an answer that is not a list is null, never an empty list", () => {
    expect(readJobList('{"jobs":null}')).toBeNull();
    expect(readJobList("avviato")).toBeNull();
  });
});

describe("GET /api/cron/jobs", () => {
  test("lists every job, the switched-off ones included", async () => {
    const { calls, send } = routerWith(() => ok(LIST_OUT));
    const resp = await send("GET", "/api/cron/jobs");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jobs: VIEW });
    // `--all`: without it `--json` leaves the switched-off jobs out.
    expect(calls).toEqual([["list", "--json", "--all"]]);
  });

  test("a scheduler that fails answers as an error, with its reason", async () => {
    const { send } = routerWith(() => ({ ok: false, status: 502, message: "jarvis-channels not found on PATH" }));
    const resp = await send("GET", "/api/cron/jobs");
    expect(resp.status).toBe(502);
    expect(((await resp.json()) as { warning: string }).warning).toContain("not found on PATH");
  });

  test("an answer that is not a job list is a 502, not an empty panel", async () => {
    const { send } = routerWith(() => ok('{"jobs":null}'));
    expect((await send("GET", "/api/cron/jobs")).status).toBe(502);
  });
});

describe("job commands", () => {
  test("PATCH enabled:false disables the job and broadcasts the fresh list", async () => {
    const { calls, broadcasts, send } = routerWith(listOr(ok()));
    const resp = await send("PATCH", "/api/cron/jobs/j1", { enabled: false });
    expect(resp.status).toBe(200);
    expect(calls[0]).toEqual(["disable", "--id", "j1"]);
    expect(broadcasts).toEqual([{ type: "cron:updated", jobs: VIEW }]);
  });

  test("PATCH enabled:true enables it", async () => {
    const { calls, send } = routerWith(listOr(ok()));
    expect((await send("PATCH", "/api/cron/jobs/j2", { enabled: true })).status).toBe(200);
    expect(calls[0]).toEqual(["enable", "--id", "j2"]);
  });

  test("a patch with nothing the CLI can change is a 400 and reaches no CLI", async () => {
    const { calls, send } = routerWith(listOr(ok()));
    expect((await send("PATCH", "/api/cron/jobs/j1", { name: "altro" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("run starts the job by id and asks for the JSON answer", async () => {
    const { calls, send } = routerWith(listOr(ok('{"ok":true,"enqueued":true,"jobId":"j1"}')));
    const resp = await send("POST", "/api/cron/jobs/j1/run");
    expect(resp.status).toBe(200);
    expect(calls[0]).toEqual(["run", "--id", "j1", "--json"]);
  });

  test("a run the scheduler did not confirm is a 409 with its reason, not a stamp", async () => {
    const { broadcasts, send } = routerWith(() => ok('{"ok":false,"reason":"already-running"}'));
    const resp = await send("POST", "/api/cron/jobs/j1/run");
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toContain("already-running");
    expect(broadcasts).toEqual([]);
  });

  test("DELETE removes the job by id", async () => {
    const { calls, send } = routerWith(listOr(ok("rimosso\n")));
    expect((await send("DELETE", "/api/cron/jobs/j1")).status).toBe(200);
    expect(calls[0]).toEqual(["rm", "--id", "j1"]);
  });

  test("an empty id reaches no CLI: there «» is the prefix of every job", async () => {
    const { calls, send } = routerWith(listOr(ok()));
    expect(await send("DELETE", "/api/cron/jobs/")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a refusal keeps the CLI's status and sentence, and broadcasts nothing", async () => {
    const { broadcasts, send } = routerWith(() => ({ ok: false, status: 400, message: "job j9: non trovato" }));
    const resp = await send("PATCH", "/api/cron/jobs/j9", { enabled: true });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toContain("job j9: non trovato");
    expect(broadcasts).toEqual([]);
  });
});

describe("jarvisChannelsCron", () => {
  const dir = mkdtempSync(join(tmpdir(), "topics-test-cron-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fakeCli = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test("passes `cron` and the arguments, and returns stdout", async () => {
    const argsFile = join(dir, "ok.args");
    const bin = fakeCli("ok", `printf '%s\\n' "$@" > '${argsFile}'; echo '{"jobs":[]}'`);
    expect(await jarvisChannelsCron(["list", "--json", "--all"], { bin })).toEqual({ ok: true, stdout: '{"jobs":[]}\n' });
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["cron", "list", "--json", "--all"]);
  });

  test("a job that is not there is a 400 with the CLI's sentence", async () => {
    // Measured: `cron disable --id nope` exits 1 with this line on stderr.
    const bin = fakeCli("missing", `echo 'job nope: non trovato' >&2; exit 1`);
    expect(await jarvisChannelsCron(["disable", "--id", "nope"], { bin })).toEqual({ ok: false, status: 400, message: "job nope: non trovato" });
  });

  test("run --json on a missing job is a 400 too", async () => {
    const bin = fakeCli("runmissing", `echo '{"jobId":"nope","ok":false,"reason":"not-found"}'; echo 'job nope non trovato' >&2; exit 1`);
    expect(await jarvisChannelsCron(["run", "--id", "nope", "--json"], { bin })).toEqual({ ok: false, status: 400, message: "job nope non trovato" });
  });

  test("any other failure is a 502 with the CLI's last line", async () => {
    const bin = fakeCli("broken", `echo 'jobs.json: permission denied' >&2; exit 1`);
    expect(await jarvisChannelsCron(["rm", "--id", "j1"], { bin })).toEqual({ ok: false, status: 502, message: "jobs.json: permission denied" });
  });

  test("no CLI on PATH is a 502 that says so", async () => {
    expect(await jarvisChannelsCron(["list"], { bin: null })).toEqual({ ok: false, status: 502, message: "jarvis-channels not found on PATH" });
  });
});
