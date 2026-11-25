import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The CPU-sample rule of the native shell lives in Rust, and the coverage gate
 * does not walk `desktop-tauri/`: this file is the channel that declares it.
 * What it pins is the SHAPE of the rule in the source, so the Rust proof
 * (`webview_cpu_comes_from_the_sample`, a busy child read at 500 ms) cannot be
 * deleted or bypassed silently.
 *
 * @covers BROWSER-HEAVY-01
 */
const SRC = readFileSync(new URL("../../desktop-tauri/src-tauri/src/perf_metrics.rs", import.meta.url), "utf8");

describe("perf_metrics reads each process CPU counter once per sample (BROWSER-HEAVY-01)", () => {
  test("the Rust proof of the rule is still there", () => {
    expect(SRC).toContain("fn webview_cpu_comes_from_the_sample");
  });

  test("the per-webview rows are built from the sample map, not from a second read", () => {
    const start = SRC.indexOf("pub(crate) fn collect_webview_usage(");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n}\n", start));
    expect(body).toContain("cpu_by_pid: &std::collections::HashMap<i32, f32>");
    expect(body).toContain("cpu_by_pid.get(&pid)");
    expect(body).not.toContain("proc_cpu_percent(");
  });
});
