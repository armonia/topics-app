/**
 * `write_file`, `edit_file` and the bash `cwd` may reach `/tmp`, `/private/tmp`
 * and `$TMPDIR` from any workspace (card 7be32c03). Measured 10-12 Nov: 11
 * `write_file` calls to paths like /tmp/hz/meta/meta.mjs and /tmp/sc/launch.sh
 * were refused with "percorso fuori dalla workspace", and 3 bash calls with
 * `cwd: "/tmp"`.
 *
 * Nothing else moves: the workspace and the declared write roots are the only
 * other places a write can go, and reads stay inside the workspace.
 *
 * @covers RT-07
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../../server/providers/native/tools";

let ws: string;
let scratch: string;
let homeDir: string;

beforeAll(() => {
  // A workspace outside every temp root, or "outside the workspace" would be
  // indistinguishable from "inside temp".
  const base = join(homedir(), ".cache");
  mkdirSync(base, { recursive: true });
  homeDir = mkdtempSync(join(base, "topics-tools-temp-test-"));
  ws = join(homeDir, "ws");
  mkdirSync(ws);
  scratch = mkdtempSync(join(tmpdir(), "turni-tmp-"));
});
afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const ctx = () => ({ workspace: ws });

describe("write_file and edit_file under the temp roots", () => {
  test("a new file and an edit, absolute path, nested folders", async () => {
    const target = join(scratch, "hz", "meta", "meta.mjs");
    const w = await executeTool("write_file", { path: target, content: "one\n" }, ctx());
    expect(w.isError).toBeFalsy();
    expect(readFileSync(target, "utf-8")).toBe("one\n");
    const e = await executeTool("edit_file", { path: target, old: "one", new: "two" }, ctx());
    expect(e.isError).toBeFalsy();
    expect(readFileSync(target, "utf-8")).toBe("two\n");
  });

  test("the literal /tmp and /private/tmp spellings", async () => {
    const name = `turni-tmp-${process.pid}-${Date.now()}`;
    try {
      const a = await executeTool("write_file", { path: `/tmp/${name}-a.txt`, content: "a" }, ctx());
      const b = await executeTool("write_file", { path: `/private/tmp/${name}-b.txt`, content: "b" }, ctx());
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
    } finally {
      rmSync(`/tmp/${name}-a.txt`, { force: true });
      rmSync(`/private/tmp/${name}-b.txt`, { force: true });
    }
  });
});

describe("outside the workspace and the temp roots stays refused", () => {
  test("home, a sibling folder, `..`, a lookalike prefix", async () => {
    const targets = [
      join(homedir(), "turni-tmp-must-not-exist.txt"),
      join(homeDir, "sibling.txt"),
      join(scratch, "..", "..", "..", "..", "etc", "turni-tmp-must-not-exist"),
      "/tmpfoo/turni-tmp-must-not-exist.txt",
      "/etc/turni-tmp-must-not-exist",
    ];
    for (const path of targets) {
      const r = await executeTool("write_file", { path, content: "no" }, ctx());
      expect(r.isError, path).toBe(true);
      expect(r.content, path).toContain("fuori dalla workspace");
      expect(existsSync(path), path).toBe(false);
    }
  });

  test("edit_file of an existing file outside is refused too", async () => {
    const target = join(homeDir, "sibling-existing.txt");
    writeFileSync(target, "keep");
    const r = await executeTool("edit_file", { path: target, old: "keep", new: "lost" }, ctx());
    expect(r.isError).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("keep");
  });

  test("reads are untouched: read_file of a temp file is still outside the workspace", async () => {
    const target = join(scratch, "readable.txt");
    writeFileSync(target, "x");
    const r = await executeTool("read_file", { path: target }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fuori dalla workspace");
  });
});

describe("bash cwd", () => {
  test("a temp dir is a valid cwd", async () => {
    const r = await executeTool("bash", { command: "pwd", cwd: scratch }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content.trim().replace(/^\/private/, "")).toBe(scratch.replace(/^\/private/, ""));
  });

  test("home and a sibling folder are not", async () => {
    for (const cwd of [homedir(), homeDir, "/etc"]) {
      const r = await executeTool("bash", { command: "pwd", cwd }, ctx());
      expect(r.isError, cwd).toBe(true);
      expect(r.content, cwd).toContain("fuori dalla workspace");
    }
  });
});
