/**
 * Every e2e clip is as wide and tall as the viewport it was recorded at.
 *
 * Left without `video.size`, Playwright scales the recording to fit 800x800:
 * the 1280x800 desktop came out as an 800x500 .webm, and the UI text did not
 * read. The size lives in one module (tests/e2e/video-evidence.ts) and the
 * config uses it for the top level and for every project with its own
 * viewport. This reads the effective values of each project, the same ones
 * Playwright hands to the browser context, and checks clip against viewport.
 *
 * Same child-process shape as evidence-trace-attachments.test.ts: the config
 * reads the environment at import time, so each case imports it in a fresh `bun`.
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

type Size = { width: number; height: number };
type Video = { mode: string; size?: Size } | string | undefined;
type Probe = {
  topViewport: Size;
  projects: { name: string; viewport: Size | undefined; video: Video }[];
  topVideo: Video;
};

/** Imports playwright.config.ts in a fresh process and reports the effective values per project. */
function readConfig(env: Record<string, string>): Probe {
  const script = [
    "const m = await import('./playwright.config.ts');",
    "const top = m.default.use;",
    "const projects = (m.default.projects ?? []).map((p) => ({",
    "  name: p.name, viewport: (p.use && p.use.viewport) ?? top.viewport, video: (p.use && p.use.video) ?? top.video }));",
    "console.log(JSON.stringify({ topViewport: top.viewport, topVideo: top.video, projects }));",
  ].join(" ");
  const r = Bun.spawnSync(["bun", "-e", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_PORT: "", TOPICS_E2E_LIST_ONLY: "1", E2E_EVIDENCE: "", E2E_VIDEO: "", E2E_NO_VIDEO: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  if (r.exitCode !== 0 || !out) {
    throw new Error(`config not readable (exit ${r.exitCode}): ${r.stderr.toString().slice(-400)}`);
  }
  return JSON.parse(out) as Probe;
}

describe("e2e clip size", () => {
  it("under E2E_EVIDENCE=1 every project records a .webm as wide and tall as its viewport", () => {
    const probe = readConfig({ E2E_EVIDENCE: "1" });
    expect(probe.topVideo).toMatchObject({ mode: "on", size: probe.topViewport });
    for (const p of probe.projects) {
      const video = p.video as { mode: string; size?: Size };
      expect({ project: p.name, mode: video.mode, size: video.size }).toEqual({
        project: p.name,
        mode: "on",
        size: p.viewport,
      });
    }
  }, 60_000);

  it("the desktop clip is the desktop viewport, not Playwright's scaled 800x500", () => {
    const probe = readConfig({ E2E_EVIDENCE: "1" });
    expect(probe.topViewport).toEqual({ width: 1280, height: 800 });
    expect(probe.topVideo).toMatchObject({ size: { width: 1280, height: 800 } });
  }, 60_000);

  it("without evidence the clip is kept only on failure, still at the viewport's size", () => {
    const probe = readConfig({});
    expect(probe.topVideo).toMatchObject({ mode: "retain-on-failure", size: probe.topViewport });
  }, 60_000);
});
