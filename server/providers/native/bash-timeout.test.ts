/**
 * The native `bash` honours the `timeout` the model asks for, up to ten minutes.
 *
 * Measured on 2026-10-04 over three days: 186 native `bash` calls passed a
 * `timeout`, 45 of them above 120 s (400000, 600000, 900000...), and the schema
 * had no such field, so every one of them died at the fixed 120 s. Four were
 * killed that way after asking for 230, 260, 260 and 900 s. Times are scaled
 * down here: the context's default plays the 120 s, a command a little longer
 * than it plays the long build.
 *
 * @covers CHAT-NTOOL-07
 */
import { describe, expect, test } from "bun:test";
import { CODING_TOOLS, executeTool } from "./tools";
import { MAX_BASH_TIMEOUT_MS, resolveBashTimeoutMs } from "./bash-timeout";

const workspace = process.cwd();

describe("the native bash timeout", () => {
  test("the model's value wins over the default, capped at ten minutes", () => {
    expect(MAX_BASH_TIMEOUT_MS).toBe(600_000);
    expect(resolveBashTimeoutMs(230_000, 120_000)).toBe(230_000);
    expect(resolveBashTimeoutMs(900_000, 120_000)).toBe(600_000);
    expect(resolveBashTimeoutMs(undefined, 120_000)).toBe(120_000);
    expect(resolveBashTimeoutMs(0, 120_000)).toBe(120_000);
    expect(resolveBashTimeoutMs(-5, 120_000)).toBe(120_000);
    expect(resolveBashTimeoutMs(Number.NaN, 120_000)).toBe(120_000);
    expect(resolveBashTimeoutMs("230000", 120_000)).toBe(120_000);
  });

  test("a timeout longer than the default lets a command outlive the default", async () => {
    const out = await executeTool(
      "bash",
      { command: "sleep 1.2; echo done", timeout: 4_000 },
      { workspace, bashTimeoutMs: 500 },
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toBe("done");
  });

  test("without a timeout the default still applies, and the kill says how to go further", async () => {
    const out = await executeTool("bash", { command: "sleep 3; echo late" }, { workspace, bashTimeoutMs: 400 });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("[comando ucciso dopo 400ms]");
    expect(String(out.content)).toContain('"timeout"');
    expect(String(out.content)).toContain("run_command");
    expect(String(out.content)).toContain("wait_for_process");
    expect(String(out.content)).not.toContain("late");
  });

  test("the schema offers the field and the description states default and maximum", () => {
    const bash = CODING_TOOLS.find((t) => t.name === "bash")!;
    expect(Object.keys(bash.input_schema.properties)).toContain("timeout");
    expect(bash.description).toContain("120000");
    expect(bash.description).toContain("600000");
    expect(bash.description).toContain("run_command");
  });
});
