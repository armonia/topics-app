/**
 * The bloat gate is a ratchet: the baseline only goes down.
 * @covers BLOAT-RATCHET-01
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../setup/bun-test-preload";

const SCRIPT = join(import.meta.dir, "../../scripts/check-bloat.ts");

let root: string;
let baselinePath: string;

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
}

function git(...args: string[]) {
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv() });
}

function gate(...args: string[]) {
  const r = spawnSync("bun", ["run", SCRIPT, `--root=${root}`, `--baseline=${baselinePath}`, ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function addFile(name: string, n: number) {
  writeFileSync(join(root, "src", name), lines(n));
  git("add", "-A");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bloat-ratchet-"));
  baselinePath = join(root, "scripts", "bloat-baseline.json");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "scripts"));
  git("init", "-q");
  addFile("big.ts", 900);
  addFile("small.ts", 10);
  expect(gate("--update-baseline").code).toBe(0); // first freeze: nothing is new yet
  git("add", "-A");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeBaseline(patch: (b: Record<string, unknown>) => void) {
  const b = readBaseline();
  patch(b);
  writeFileSync(baselinePath, JSON.stringify(b, null, 2));
}

describe("check-bloat ratchet", () => {
  test("a new 801-line file cannot be recorded without an exception", () => {
    addFile("new.ts", 801);
    expect(gate().code).toBe(1);
    const r = gate("--update-baseline");
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/new.ts");
    expect(readBaseline().files["src/new.ts"]).toBeUndefined();
  });

  test("with a written exception the entry is recorded and keeps reason and expiry", () => {
    addFile("new.ts", 801);
    writeBaseline((b) => {
      b.exceptions = { "src/new.ts": { why: "generated shape, split tracked elsewhere", expires: "2999-01-01" } };
    });
    expect(gate("--update-baseline").code).toBe(0);
    const b = readBaseline();
    expect(b.files["src/new.ts"]).toBe(801);
    expect(b.exceptions["src/new.ts"]).toEqual({ why: "generated shape, split tracked elsewhere", expires: "2999-01-01" });
    expect(gate().code).toBe(0);
  });

  test("an expired exception is refused", () => {
    addFile("new.ts", 801);
    writeBaseline((b) => {
      b.exceptions = { "src/new.ts": { why: "old", expires: "2020-01-01" } };
    });
    expect(gate("--update-baseline").code).toBe(1);
  });

  test("a recorded file that grows past its size needs an exception too", () => {
    addFile("big.ts", 1000);
    expect(gate("--update-baseline").code).toBe(1);
  });

  test("hand-editing a new file into `files` is still caught by the total", () => {
    addFile("new.ts", 801);
    writeBaseline((b) => {
      (b.files as Record<string, number>)["src/new.ts"] = 801;
    });
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.out).toContain("TOTAL rose");
  });

  test("shrinking is recorded and lowers the ceiling", () => {
    addFile("big.ts", 801);
    expect(gate("--update-baseline").code).toBe(0);
    expect(readBaseline().files["src/big.ts"]).toBe(801);
  });
});
