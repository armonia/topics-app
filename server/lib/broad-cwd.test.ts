/**
 * One predicate for "this cwd is not a project", shared by the port detector
 * and by the file-route allowlist, plus the rule the terminal route applies to
 * a cwd sent by a paired device.
 *
 * @covers PROJECT-11
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBroadCwd, isClientCwdAccepted } from "./broad-cwd";

describe("isBroadCwd", () => {
  const home = "/Users/me";

  it("HOME, its ancestors, the root and the empty string are broad", () => {
    for (const cwd of ["", "/", "/Users", "/Users/me"]) {
      expect(`${cwd}:${isBroadCwd(cwd, home)}`).toBe(`${cwd}:true`);
    }
  });

  it("a directory under HOME, or elsewhere, is not", () => {
    for (const cwd of ["/Users/me/Projects/app", "/Users/me/.ssh", "/Users/meow", "/private/tmp"]) {
      expect(`${cwd}:${isBroadCwd(cwd, home)}`).toBe(`${cwd}:false`);
    }
  });

  it("without a HOME only the root is broad", () => {
    expect(isBroadCwd("/", "")).toBe(true);
    expect(isBroadCwd("/Users", "")).toBe(false);
  });
});

describe("isClientCwdAccepted — what a paired device may open a terminal in", () => {
  let root: string;
  let home: string;
  let project: string;
  // The boundary the file routes use: the project and what is under it.
  const inProject = (p: string) => (p === project || p.startsWith(project + "/") ? p : null);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "broad-cwd-")));
    home = join(root, "home");
    project = join(home, "Projects", "app");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("the broad default passes: it is what a missing cwd would give anyway", () => {
    for (const cwd of [home, root, "/", "~"]) {
      expect(`${cwd}:${isClientCwdAccepted(cwd, inProject, home)}`).toBe(`${cwd}:true`);
    }
  });

  it("a known project and its subfolders pass", () => {
    expect(isClientCwdAccepted(project, inProject, home)).toBe(true);
    expect(isClientCwdAccepted(join(project, "src"), inProject, home)).toBe(true);
  });

  it("~/.ssh is refused: neither broad nor a project", () => {
    // This is the cwd that, stored on the session row, became a root of the
    // file-route allowlist and made `/api/files/content?path=~/.ssh/...`
    // answer 200 to the device that opened the terminal.
    expect(isClientCwdAccepted(join(home, ".ssh"), inProject, home)).toBe(false);
    expect(isClientCwdAccepted("~/.ssh", inProject, home)).toBe(false);
    expect(isClientCwdAccepted("/private/etc", inProject, home)).toBe(false);
  });

  it("a trailing slash or a symlink does not change the verdict", () => {
    expect(isClientCwdAccepted(home + "/", inProject, home)).toBe(true);
    expect(isClientCwdAccepted(join(home, ".ssh") + "/", inProject, home)).toBe(false);
  });
});
