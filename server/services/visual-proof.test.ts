/**
 * @covers KANBAN-127
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeVisualProof, type VisualProofDeps } from "./visual-proof";

function makeCwd(configOverrides?: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), "visual-proof-"));
  if (configOverrides !== null) {
    writeFileSync(join(cwd, "spec-flow.completeness.json"), JSON.stringify({
      designSystem: {
        uiRoots: ["client/src"],
        uiExtensions: [".tsx"],
        exclude: [".test.", "/test/"],
        designFile: "DESIGN.md",
        ...configOverrides,
      },
    }));
  }
  return cwd;
}

function fakeDeps(opts?: { screenshotOk?: boolean }): VisualProofDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    diffNames: () => [],
    screenshot: async (_url, outPath) => {
      calls.push(outPath);
      if (opts?.screenshotOk === false) return false;
      writeFileSync(outPath, "fake-png");
      return true;
    },
  };
}

describe("writeVisualProof", () => {
  test("writes one entry per touched .tsx with all four widths and a reference", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.tsx", "README.md"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "topics/steadfast-dragon" });

    expect(result?.written).toEqual(["client/src/components/Foo.tsx"]);
    const proofPath = join(cwd, result!.dir, "visual-proof.json");
    const entries = JSON.parse(readFileSync(proofPath, "utf8"));
    expect(entries).toHaveLength(1);
    expect(entries[0].component).toBe("client/src/components/Foo.tsx");
    expect(Object.keys(entries[0].widths).sort()).toEqual(["1440", "3440", "375", "768"]);
    expect(entries[0].reference).toBe("DESIGN.md");
    for (const img of Object.values(entries[0].widths) as string[]) {
      expect(existsSync(join(cwd, result!.dir, img))).toBe(true);
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reuses an openspec change folder already touched by the same diff", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.tsx", "openspec/changes/my-change/proposal.md"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });

    expect(result?.dir).toBe("openspec/changes/my-change");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("falls back to a generic branch folder with no openspec change in the diff", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.tsx"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "topics/steadfast-dragon" });

    expect(result?.dir).toBe("openspec/changes/_visual-proof-auto/topics-steadfast-dragon");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("no UI file touched: nothing written", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["server/services/other.ts"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });

    expect(result).toBeNull();
    expect(existsSync(join(cwd, "openspec"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("an excluded file under the UI root is not proven", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.test.tsx"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });

    expect(result).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("no designSystem configured: leaves no trace", async () => {
    const cwd = makeCwd(null as unknown as Record<string, unknown>);
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.tsx"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });

    expect(result).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a failed capture at one width abandons the whole round", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps({ screenshotOk: false });
    deps.diffNames = () => ["client/src/components/Foo.tsx"];

    const result = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });

    expect(result).toBeNull();
    expect(existsSync(join(cwd, "openspec"))).toBe(true); // dir created, but no half-proof json
    expect(existsSync(join(cwd, "openspec/changes/_visual-proof-auto/any/visual-proof.json"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("re-running updates the entry for the same component instead of duplicating it", async () => {
    const cwd = makeCwd();
    const deps = fakeDeps();
    deps.diffNames = () => ["client/src/components/Foo.tsx"];

    const first = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3400", branchName: "any" });
    const second = await writeVisualProof(deps, { cwd, baseRef: "origin/main", url: "http://127.0.0.1:3401", branchName: "any" });

    const entries = JSON.parse(readFileSync(join(cwd, second!.dir, "visual-proof.json"), "utf8"));
    expect(entries).toHaveLength(1);
    rmSync(cwd, { recursive: true, force: true });
  });
});
