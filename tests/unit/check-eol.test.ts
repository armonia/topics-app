/**
 * A branch that turns a file from LF into CRLF is refused; with the repo's
 * `.gitattributes` cure the same commit lands as LF and passes.
 * @covers GATE-08
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findCrlfRewrites } from "../../scripts/check-eol";

const REPO_ROOT = join(import.meta.dir, "../..");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe" }).toString();

describe("check-eol", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eol-"));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const commitCrlf = () => {
    writeFileSync(join(dir, "a.ts"), "one\r\ntwo\r\nthree\r\n");
    writeFileSync(join(dir, "new.ts"), "x\r\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "crlf");
  };

  it("refuses a commit that brings a file to CRLF (no cure)", () => {
    commitCrlf();
    expect(findCrlfRewrites(dir, "HEAD~1").sort()).toEqual(["a.ts", "new.ts"]);
  });

  it("passes the same commit once the repo's .gitattributes is in place", () => {
    writeFileSync(join(dir, ".gitattributes"), readFileSync(join(REPO_ROOT, ".gitattributes")));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "cure");
    commitCrlf();
    expect(findCrlfRewrites(dir, "HEAD~1")).toEqual([]);
  });

  it("lets an LF edit through", () => {
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
    git(dir, "commit", "-qam", "lf");
    expect(findCrlfRewrites(dir, "HEAD~1")).toEqual([]);
  });

  it("the repo itself carries the cure", () => {
    expect(readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8")).toContain("* text=auto eol=lf");
  });
});
