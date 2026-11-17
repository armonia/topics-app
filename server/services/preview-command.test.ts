/**
 * @covers KANBAN-23
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PREVIEW_CONTRACT_READY_MS, resolvePreviewCommand } from "./preview-command";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "preview-command-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const pkg = (body: object) => writeFileSync(join(dir, "package.json"), JSON.stringify(body));

describe("resolvePreviewCommand", () => {
  it("returns null without a package.json or without a matching script", () => {
    expect(resolvePreviewCommand(dir, {})).toBeNull();
    pkg({ scripts: { build: "x" } });
    expect(resolvePreviewCommand(dir, {})).toBeNull();
  });

  it("prefers preview:worktree, then preview, dev, start", () => {
    pkg({ scripts: { start: "s", dev: "d", "preview:worktree": "p" } });
    expect(resolvePreviewCommand(dir, {})?.cmd.at(-1)).toBe("preview:worktree");
    pkg({ scripts: { start: "s", dev: "d" } });
    expect(resolvePreviewCommand(dir, {})?.cmd.at(-1)).toBe("dev");
  });

  it("gives the contract script a wide wait cap and the others the default", () => {
    pkg({ scripts: { "preview:worktree": "p" } });
    expect(resolvePreviewCommand(dir, {})?.readyTimeoutMs).toBe(PREVIEW_CONTRACT_READY_MS);
    pkg({ scripts: { dev: "d" } });
    expect(resolvePreviewCommand(dir, {})?.readyTimeoutMs).toBeUndefined();
  });

  it("announces a deep-link file only for the contract script", () => {
    pkg({ scripts: { "preview:worktree": "p" } });
    expect(resolvePreviewCommand(dir, {})?.deepLinkFile).toContain("{port}");
    pkg({ scripts: { dev: "d" } });
    expect(resolvePreviewCommand(dir, {})?.deepLinkFile).toBeUndefined();
  });

  it("installs dependencies only when the package declares some and node_modules is missing", () => {
    pkg({ scripts: { dev: "d" } });
    expect(resolvePreviewCommand(dir, {})?.prepare).toEqual([]);
    pkg({ scripts: { dev: "d" }, dependencies: { left: "1" } });
    expect(resolvePreviewCommand(dir, {})?.prepare?.length).toBe(1);
    mkdirSync(join(dir, "node_modules"));
    expect(resolvePreviewCommand(dir, {})?.prepare).toEqual([]);
  });

  it("lets the env override win, with the deep-link path", () => {
    pkg({ scripts: { dev: "d" } });
    const res = resolvePreviewCommand(dir, { TOPICS_PREVIEW_CMD: "serve --port {port}", TOPICS_PREVIEW_PATH: "/x" });
    expect(res).toEqual({ cmd: ["serve", "--port", "{port}"], deepLinkPath: "/x" });
  });
});
