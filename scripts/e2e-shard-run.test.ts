/** @covers E2E-GATE-05
 * @covers E2E-GATE-09 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");

function fixture(expected = 1) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-shard-run-test-"));
  mkdirSync(join(dir, "bin"));
  const lease = join(dir, "run.lock");
  const rows: { port: string; report: string; output: string }[] = [];
  const responses: ((response: Response) => void)[] = [];
  let ready: () => void = () => {};
  const started = new Promise<void>((done) => { ready = done; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      rows.push(await request.json());
      return new Promise<Response>((done) => {
        responses.push(done);
        if (rows.length === expected) ready();
      });
    },
  });
  writeFileSync(join(dir, "bin/npx"), `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.env.FIXTURE_STOPPED, "stopped");
  process.exit(143);
});
console.log("stub started");
const response = await fetch(process.env.FIXTURE_READY, {
  method: "POST", body: JSON.stringify({port: process.env.E2E_PORT, report: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, output: process.argv.find(arg => arg.startsWith("--output="))}),
});
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, "{}");
console.log("1 passed");
process.exit(Number(await response.text()));
`, { mode: 0o755 });
  const env = {
    ...process.env, TOPICS_GATE_SLOTS: "0", TOPICS_GATE_HELD: "fixture",
    TOPICS_E2E_SHARD_CHILD: "", TOPICS_E2E_SHARD_LOCK_PATH: lease,
    TMPDIR: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    E2E_SHARD_OUT_DIR: "", E2E_SHARD_BASE_PORT: "13910",
    FIXTURE_READY: `http://127.0.0.1:${server.port}`, FIXTURE_STOPPED: join(dir, "stopped"),
  };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  function run(extra: Record<string, string> = {}, count = expected, args = ["fixture.spec.ts"]) {
    const child = Bun.spawn(["bash", join(root, "scripts/e2e-shards.sh"), String(count), ...args], {
      cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    return child;
  }
  return {
    dir, lease, rows, started, run,
    finish(code = 0) { for (const respond of responses) respond(new Response(String(code))); },
    async close() {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
      }
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("E2E shard invocation ownership", () => {
  test.each(["--output", "--output=shared"])("%s cannot override the isolated artifact directories", async (flag) => {
    const f = fixture();
    try {
      const child = f.run({}, 2, [flag, ...(flag === "--output" ? [join(f.dir, "shared")] : [])]);
      expect(await child.exited).toBe(2);
      expect(await new Response(child.stderr).text()).toContain("E2E_SHARD_OUT_DIR");
      expect(existsSync(f.lease)).toBe(false);
      expect(f.rows).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("SIGTERM while queued for a CPU slot cannot leave an E2E run lease", async () => {
    const f = fixture();
    try {
      const slots = join(f.dir, "slots");
      mkdirSync(slots);
      writeFileSync(join(slots, "0.pid"), String(process.pid));
      const child = f.run({ TOPICS_GATE_SLOTS: "1", TOPICS_GATE_HELD: "", TOPICS_GATE_SLOT_DIR: slots });
      const reader = child.stderr.getReader();
      let error = "";
      while (!error.includes("gate slots are busy")) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Runner exited before queueing: ${error}`);
        error += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      child.kill("SIGTERM");
      expect(await child.exited).not.toBe(0);
      expect(existsSync(f.lease)).toBe(false);
      expect(readFileSync(join(slots, "0.pid"), "utf8")).toBe(String(process.pid));
      expect(f.rows).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("a concurrent invocation refuses before touching the active run's logs or ports", async () => {
    const f = fixture();
    try {
      const first = f.run();
      await f.started;
      const out = dirname(f.rows[0]!.report);
      const marker = join(out, "evidence.txt");
      writeFileSync(marker, "first run");
      const second = f.run();
      expect(await second.exited).toBe(1);
      const error = await new Response(second.stderr).text();
      expect(error).toContain("Cannot acquire run lease");
      expect(error).toContain("ps -axo pid,ppid,command");
      expect(readFileSync(marker, "utf8")).toBe("first run");
      expect(f.rows).toHaveLength(1);
      expect(first.exitCode).toBeNull();
      f.finish();
      expect(await first.exited).toBe(0);
      expect(existsSync(f.lease)).toBe(false);
    } finally { await f.close(); }
  });

  test.each([0, 1])("exit %i releases the lease and preserves reports from both isolated shards", async (code) => {
    const f = fixture(2);
    try {
      const child = f.run();
      await f.started;
      expect(f.rows.map((row) => row.port).sort()).toEqual(["13910", "13911"]);
      expect(new Set(f.rows.map((row) => row.report)).size).toBe(2);
      f.finish(code);
      expect(await child.exited).toBe(code);
      expect(existsSync(f.lease)).toBe(false);
      for (const row of f.rows) {
        expect(row.output).toBe(`--output=${join(dirname(row.report), `artifacts-${Number(row.port) - 13909}`)}`);
        expect(readFileSync(row.report, "utf8")).toBe("{}");
        expect(readFileSync(join(dirname(row.report), `shard-${Number(row.port) - 13909}.log`), "utf8")).toContain("1 passed");
      }
    } finally { await f.close(); }
  });

  test.each(["SIGTERM", "SIGHUP"] as const)("%s stops owned shards, releases the lease, and leaves their log available", async (signal) => {
    const f = fixture();
    try {
      const child = f.run();
      await f.started;
      child.kill(signal);
      expect(await child.exited).toBe(signal === "SIGHUP" ? 129 : 143);
      expect(existsSync(f.lease)).toBe(false);
      expect(readFileSync(join(f.dir, "stopped"), "utf8")).toBe("stopped");
      expect(readFileSync(join(dirname(f.rows[0]!.report), "shard-1.log"), "utf8")).toContain("stub started");
    } finally { await f.close(); }
  });

  test("an existing output directory is preserved and an abandoned lease is diagnosed", async () => {
    const f = fixture();
    try {
      const out = join(f.dir, "existing");
      mkdirSync(out);
      writeFileSync(join(out, "evidence"), "keep");
      const result = f.run({ E2E_SHARD_OUT_DIR: out });
      expect(await result.exited).toBe(1);
      expect(readFileSync(join(out, "evidence"), "utf8")).toBe("keep");
      expect(existsSync(f.lease)).toBe(false);
      writeFileSync(f.lease, JSON.stringify({ pid: 99999999 }));
      const abandoned = f.run();
      expect(await abandoned.exited).toBe(1);
      expect(await new Response(abandoned.stderr).text()).toContain("shards may still be alive");
      expect(readFileSync(f.lease, "utf8")).toContain("99999999");
      expect(f.rows).toHaveLength(0);
    } finally { await f.close(); }
  });
});
