/**
 * @covers RUNTIME-06
 *
 * AN I/O ERROR MUST NOT TAKE THE SERVER DOWN, A BUG MUST.
 *
 * `server.ts` had no `uncaughtException` handler at all, and on 2026-09-17 that
 * cost a CI run: the test server died with exit 1 on `write EPIPE` one line
 * after `[AI Bridge] socket closed`, and Playwright reported it as 68 failed
 * plus 235 never run (run 35269750073, job 105366102078). Those reds were
 * charged to the card under review. A crash wearing a red suite's costume costs
 * the rerun AND a wrong diagnosis.
 *
 * That specific hole was closed at the source (PR #93). This is the net for the
 * ones nobody has found yet, and the whole design question is what it must NOT
 * catch: a `TypeError` swallowed here would leave the process alive in a state
 * nobody designed, and the next symptom would surface somewhere unrelated hours
 * later. So the rule is narrow on purpose, and these tests are mostly about the
 * refusals.
 *
 * The behaviour is verified by RUNNING a child process, not by inspecting the
 * predicate: a handler that re-throws is exactly the kind of code that reads
 * correct and loops forever, and only an exit code proves it does not.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), "uncaught-"));

/**
 * The handler exactly as `server.ts` installs it, in a child that then throws
 * `code`. Returns the exit code and what it printed.
 *
 * The handler is LIFTED from `server.ts` (see `handlerSource`), not retyped:
 * importing the module would boot an entire server, and pasting a copy was
 * measured to be worthless - a mutation of the real condition left all nine
 * tests green.
 */
function runChild(code: string | null, message = "boom"): { status: number | null; out: string } {
  const file = join(dir, `child-${code ?? "nocode"}.ts`);
  writeFileSync(
    file,
    `${handlerSource()}
process.nextTick(() => {
  const e = new Error(${JSON.stringify(message)});
  ${code === null ? "" : `e.code = ${JSON.stringify(code)};`}
  throw e;
});
// If the throw above was absorbed we reach this tick and say so.
setTimeout(() => { console.error("STILL ALIVE"); process.exit(0); }, 120);
`,
  );
  const p = Bun.spawnSync(["bun", file], { stderr: "pipe", stdout: "pipe" });
  return { status: p.exitCode, out: new TextDecoder().decode(p.stderr) };
}

/**
 * The handler LIFTED OUT OF `server.ts`, not retyped here.
 *
 * The first version of this file pasted a copy, and a mutation proved the copy
 * worthless: `if (!SURVIVABLE_IO.has(code))` changed to `if (false)` in the
 * real file - the net turning into a blindfold, the exact regression these
 * tests exist to catch - and all nine stayed green, because they were
 * exercising the paste. A test that cannot see the code it guards is
 * decoration.
 *
 * So the two statements are read out of the file and injected verbatim. Only
 * `console.error` is kept so the child can report which branch it took.
 */
function handlerSource(): string {
  const src = readFileSync(join(import.meta.dir, "..", "..", "server.ts"), "utf8");
  const setLine = src.split("\n").find((l) => l.includes("const SURVIVABLE_IO"));
  if (!setLine) throw new Error("SURVIVABLE_IO not found in server.ts");
  const start = src.indexOf('process.on("uncaughtException"');
  if (start < 0) throw new Error("uncaughtException handler not found in server.ts");
  // The handler ends at the first `});` that closes it, at column zero.
  const end = src.indexOf("\n});", start);
  if (end < 0) throw new Error("could not find the end of the handler in server.ts");
  const handler = src.slice(start, end + 4);
  // `console.error` stays, the child reads it. The two markers the tests look
  // for are added around the real branches without altering the condition.
  return `${setLine}\n${handler
    .replace('console.error("[Shutdown] uncaught exception that is not a socket hang-up - rethrowing:", err);', 'console.error("RETHROWN");')
    .replace(/console\.error\(\s*`\[Shutdown\] uncaught \$\{code\}[\s\S]*?\);/, 'console.error("ABSORBED:" + code);')}`;
}

describe("the server survives a peer hanging up", () => {
  for (const code of ["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
    test(`${code} is absorbed and the process stays up`, () => {
      const r = runChild(code);
      expect(r.out).toContain(`ABSORBED:${code}`);
      expect(r.out).toContain("STILL ALIVE");
      expect(r.status).toBe(0);
    });
  }
});

describe("the server still dies of a real bug", () => {
  test("a TypeError is re-thrown and kills the process", () => {
    // The point of the whole design. If this ever goes green with exit 0, the
    // net has become a blindfold.
    const r = runChild(null, "a real bug");
    expect(r.out).toContain("RETHROWN");
    expect(r.out).not.toContain("STILL ALIVE");
    expect(r.status).not.toBe(0);
  });

  test("an unknown errno is re-thrown too: the list is an allowlist", () => {
    // ENOSPC is an I/O error and is NOT in the set, deliberately: a full disk is
    // not something to carry on through.
    const r = runChild("ENOSPC");
    expect(r.out).toContain("RETHROWN");
    expect(r.status).not.toBe(0);
  });

  test("re-throwing does not loop: the process ends instead of spinning", () => {
    // A handler that throws from inside the handler is the classic way to build
    // an infinite loop, and reading the code does not tell you which way it
    // goes. Measured: it terminates.
    const t0 = Date.now();
    const r = runChild(null);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).not.toBe(0);
  });
});

describe("the copy in this test matches the real handler", () => {
  test("server.ts absorbs exactly these five codes, no more", async () => {
    // The duplication above is a deliberate trade, and this is what keeps it
    // honest: widen the set in server.ts without touching this file and the
    // test goes red.
    const src = await Bun.file(join(import.meta.dir, "..", "..", "server.ts")).text();
    const line = src.split("\n").find((l) => l.includes("const SURVIVABLE_IO"));
    expect(line, "SURVIVABLE_IO not found in server.ts").toBeDefined();
    for (const code of ["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
      expect(line!, `${code} missing from server.ts`).toContain(code);
    }
    // Five and only five: a sixth would need its own reason and its own test.
    expect(line!.match(/"/g)!.length / 2).toBe(5);
  });
});

process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});
