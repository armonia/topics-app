/**
 * `bun run primary switch <machine>` against a stand-in server: a switch that
 * stands but comes back with a warning (the replica of the new primary did not
 * start again) must not read as a clean switch on the command line.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const roots: string[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function switchAnswering(report: Record<string, unknown>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(report) });
  servers.push(server);
  const home = mkdtempSync(join(tmpdir(), "primary-cli-"));
  roots.push(home);
  writeFileSync(join(home, "daemon-state.json"), JSON.stringify({
    pid: process.pid, port: server.port, token: "a".repeat(64), startedAt: "2026-01-01T00:00:00.000Z",
  }));
  const proc = Bun.spawn([process.execPath, join(ROOT, "scripts", "primary.ts"), "switch", "server"], {
    env: { ...process.env, TOPICS_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("a switch whose replica did not start again exits non zero and prints the warning", async () => {
  const r = await switchAnswering({ ok: true, outcome: "switched", epoch: 2, warning: "the replica of the DB did not start again (exit 4)" });
  expect(r.stdout).toContain("outcome: switched");
  expect(r.stderr).toContain("WARNING: the replica of the DB did not start again (exit 4)");
  expect(r.code).toBe(3);
}, 30_000);

test("a clean switch exits 0", async () => {
  const r = await switchAnswering({ ok: true, outcome: "switched", epoch: 2 });
  expect(r.stderr).not.toContain("WARNING");
  expect(r.code).toBe(0);
}, 30_000);
