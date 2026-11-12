/**
 * `reload()` must never kickstart `com.jarvis.channels` while a turn might be
 * in flight: that SIGKILLs a live reply. `inflight.json` says so — but only
 * when it can be read. A truncated/corrupt file used to be swallowed by a
 * bare `catch {}` and fall through to "nobody is working", kickstarting a
 * live turn out from under it.
 *
 * @covers AGCFG-02
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const spawnCalls: string[][] = [];
mock.module("../lib/bounded-spawn", () => ({
  runBounded: async (argv: string[]) => {
    spawnCalls.push(argv);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, spawnFailed: false };
  },
}));

const { createAgentConfigRouter } = await import("./agent-config");

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; spawnCalls.length = 0; });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agent-config-restart-"));
  dirs.push(home);
  const ws = join(home, "ws"); const visionWs = join(ws, "gtm");
  mkdirSync(visionWs, { recursive: true });
  writeFileSync(join(home, "engine.json"), JSON.stringify({ model: "claude-sonnet-5-5", agents: { main: { workspace: ws }, gtm: { workspace: visionWs } } }));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    channels: { discord: { default: { token: "keychain:d/j" } } },
    rules: { groups: [{ channel: "discord", chat: "42", active: true, mention: true }] },
  }));
  writeFileSync(join(home, "jobs.json"), JSON.stringify([]));
  return { home, expand: (p: string) => p };
}

async function postChatEdit(home: string) {
  const ctx = { json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }) };
  const router = createAgentConfigRouter(ctx as never, () => ({ home, expand: (p: string) => p }));
  const req = new Request("http://x/api/agent-config/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "discord", chat: "42", mention: false }),
  });
  const res = await router(req, new URL(req.url), "/api/agent-config/chat", "POST");
  return { status: res!.status, body: await res!.json() };
}

describe("reload() reading inflight.json", () => {
  test("a truncated inflight.json answers pending and never reaches launchctl", async () => {
    const p = fixture();
    writeFileSync(join(p.home, "inflight.json"), "{not json");
    const r = await postChatEdit(p.home);
    expect(r.status).toBe(200);
    expect(r.body.service).toBe("pending");
    expect(spawnCalls).toHaveLength(0);
  });

  test("no inflight.json at all reaches the restart attempt", async () => {
    const p = fixture();
    const r = await postChatEdit(p.home);
    expect(r.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(expect.arrayContaining(["launchctl", "kickstart", "-k"]));
  });

  test("a non-empty inflight.json (a turn really is running) answers pending too, no kickstart", async () => {
    const p = fixture();
    writeFileSync(join(p.home, "inflight.json"), JSON.stringify({ "topic:x": true }));
    const r = await postChatEdit(p.home);
    expect(r.status).toBe(200);
    expect(r.body.service).toBe("pending");
    expect(spawnCalls).toHaveLength(0);
  });
});
