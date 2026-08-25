/**
 * The bridge between the E2E videos and spec-flow.
 *
 * The one rule worth pinning: WITHOUT a Playwright report, an outcome is never
 * declared green. A `.webm` on disk proves a video was recorded, not that the
 * test passed - and `retain-on-failure` (the default) saves videos precisely
 * for the RED ones. A page of evidence that calls those green would be worse
 * than no page at all.
 *
 * @covers E2E-UAT-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomesFromReport, outcomeOf, titleFromFolder } from "./build-uat-index";

describe("titleFromFolder", () => {
  test("strips the project suffix and the hash, leaving something readable", () => {
    const t = titleFromFolder("sidebar-usage-summary-riep-8f2a4-ingue-il-renderer-condiviso-chromium");
    expect(t).not.toContain("chromium");
    expect(t).not.toContain("8f2a4");
    expect(t).toContain("renderer");
  });

  test("a retry directory does not become a different title", () => {
    const a = titleFromFolder("some-spec-abcde-a-test-chromium");
    const b = titleFromFolder("some-spec-abcde-a-test-chromium-retry1");
    expect(a).toBe(b);
  });
});

describe("outcomesFromReport", () => {
  function reportWith(status: string, videoPath: string): string {
    const dir = mkdtempSync(join(tmpdir(), "uat-report-"));
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify({
      suites: [{
        title: "spec.ts",
        specs: [{
          title: "does the thing",
          tests: [{ results: [{ status, duration: 1234, attachments: [{ name: "video", path: videoPath }] }] }],
        }],
        suites: [],
      }],
    }));
    return file;
  }

  test("reads status, duration and the artifact directory from a real-shaped report", () => {
    const m = outcomesFromReport(reportWith("passed", "/x/test-results/artifacts/my-test-chromium/video.webm"));
    expect(m.get("my-test-chromium")).toMatchObject({ outcome: "pass", durationMs: 1234 });
    expect(m.get("my-test-chromium")?.title).toContain("does the thing");
  });

  test("a timeout is a failure, not an unknown", () => {
    const m = outcomesFromReport(reportWith("timedOut", "/x/artifacts/t-chromium/video.webm"));
    expect(m.get("t-chromium")?.outcome).toBe("fail");
  });

  test("a report that is not JSON yields nothing instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "uat-bad-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "this is not json {");
    expect(outcomesFromReport(file).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a run with no video attachment contributes no entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "uat-novideo-"));
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify({
      suites: [{ title: "s", specs: [{ title: "t", tests: [{ results: [{ status: "passed", attachments: [{ name: "trace", path: "/x/y/trace.zip" }] }] }] }], suites: [] }],
    }));
    expect(outcomesFromReport(file).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("outcomeOf - the rule this script exists to hold", () => {
  test("no report line means UNKNOWN, never green", () => {
    // The whole point. `retain-on-failure` saves videos for the RED runs, so
    // "there is a video" must never be read as "it passed".
    expect(outcomeOf(undefined)).toBe("unknown");
  });

  test("a known outcome passes through untouched", () => {
    expect(outcomeOf("pass")).toBe("pass");
    expect(outcomeOf("fail")).toBe("fail");
  });
});
