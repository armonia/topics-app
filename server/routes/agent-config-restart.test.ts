/**
 * `reload()` (server/routes/agent-config.ts): whether a config write restarts
 * jarvis-channels now, defers it ("pending"), or — in tests only, via
 * `AGENT_CONFIG_NO_RESTART` — reports "skipped" instead of ever shelling out
 * to `launchctl`.
 *
 * Regression: the catch around reading `inflight.json` used to be blanket —
 * `try { inflight = readJson(...) } catch {}` — so a MISSING file (fine, no
 * turn in flight) and an UNREADABLE or MALFORMED one (unknown — must NOT be
 * treated as "no turn in flight") produced the exact same outcome. A stray
 * kickstart from a malformed `inflight.json` would SIGKILL a live reply.
 *
 * These tests use `AGENT_CONFIG_NO_RESTART` (already read by `reload()`
 * precisely so tests never shell out to the real `launchctl`) instead of
 * mocking a module — nothing here needs restoring, so there is nothing for
 * `check:module-mock-restore` to flag.
 *
 * @covers AGCFG-02
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAgentConfigRouter, type Paths } from "./agent-config";
import type { AppContext } from "../types";

let dirs: string[] = [];
const previousNoRestart = process.env.AGENT_CONFIG_NO_RESTART;

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  if (previousNoRestart === undefined) delete process.env.AGENT_CONFIG_NO_RESTART;
  else process.env.AGENT_CONFIG_NO_RESTART = previousNoRestart;
});

function fixture(): Paths {
  const home = mkdtempSync(join(tmpdir(), "agent-config-restart-"));
  dirs.push(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    channels: {},
    rules: { groups: [{ channel: "discord", chat: "1", active: true, mention: true }] },
  }));
  return { home, expand: (p) => p };
}

async function restartServiceFor(paths: Paths): Promise<string> {
  const ctx: Pick<AppContext, "json"> = { json: (data, status = 200) => new Response(JSON.stringify(data), { status }) };
  const router = createAgentConfigRouter(ctx, () => paths);
  const req = new Request("http://local/api/agent-config/chat", {
    method: "POST",
    body: JSON.stringify({ channel: "discord", chat: "1", mention: false }),
  });
  const res = await router(req, new URL(req.url), "/api/agent-config/chat", "POST");
  const body = await res!.json();
  expect(res!.status).toBe(200);
  return body.service;
}

describe("reload() — inflight.json read failures must not look like 'no turn in flight'", () => {
  test("inflight.json absent: unchanged behavior, proceeds as if no turn is in flight", async () => {
    process.env.AGENT_CONFIG_NO_RESTART = "1";
    const p = fixture();
    expect(await restartServiceFor(p)).toBe("skipped");
  });

  test("inflight.json non-empty: pending, no restart attempted (unchanged behavior)", async () => {
    process.env.AGENT_CONFIG_NO_RESTART = "1";
    const p = fixture();
    writeFileSync(join(p.home, "inflight.json"), JSON.stringify({ "topic:abc": true }));
    expect(await restartServiceFor(p)).toBe("pending");
  });

  test("inflight.json malformed JSON: pending, NOT treated as 'no turn in flight'", async () => {
    process.env.AGENT_CONFIG_NO_RESTART = "1";
    const p = fixture();
    writeFileSync(join(p.home, "inflight.json"), "{not json");
    // Pre-fix this returned "skipped": the blanket catch swallowed the parse
    // error, leaving `inflight` at its `{}` default.
    expect(await restartServiceFor(p)).toBe("pending");
  });

  test("inflight.json unreadable (EACCES): pending, NOT treated as 'no turn in flight'", async () => {
    process.env.AGENT_CONFIG_NO_RESTART = "1";
    const p = fixture();
    const inflightPath = join(p.home, "inflight.json");
    writeFileSync(inflightPath, JSON.stringify({}));
    chmodSync(inflightPath, 0o000);
    try {
      expect(await restartServiceFor(p)).toBe("pending");
    } finally {
      chmodSync(inflightPath, 0o644);
    }
  });
});
