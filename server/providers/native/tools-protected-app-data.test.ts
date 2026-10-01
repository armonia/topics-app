/**
 * The native agent's `grep` is SERVER code walking a tree: from a workspace at
 * HOME (a topic whose project is the home folder) it must not read other apps'
 * data on the way (`lib/protected-app-data.ts`).
 *
 * `glob` walks in-process (`glob-files.ts`), so it is held to the same rule,
 * even when the pattern names a protected folder outright.
 *
 * The workspace is a temporary tree laid out like a home, never the real one.
 * Every protected file holds `needle`, so a walk that enters one shows it.
 *
 * @covers RT-11
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "./tools";
import { makeFakeHome, PROTECTED_FILES, type FakeHome } from "../../lib/protected-app-data.fixture";

let fake: FakeHome;
beforeAll(() => {
  fake = makeFakeHome();
  // Links a project might hold: one to another app's folders, one to Library.
  symlinkSync(join(fake.home, "Library", "Containers"), join(fake.home, "Projects", "app", "c"));
  symlinkSync(join(fake.home, "Library"), join(fake.home, "Projects", "app", "lib2"));
});

/** A protected file shows up in `content`, whatever folder or link it was reached through. */
const leaks = (content: string) => PROTECTED_FILES.some((rel) => content.includes(rel.split("/").slice(-2).join("/")));
afterAll(() => fake.dispose());

describe("native grep from a workspace at HOME", () => {
  test("grep finds the home's files and nothing under Library or in a photo library", async () => {
    const r = await executeTool("grep", { pattern: "needle" }, { workspace: fake.home });
    expect(r.content).toContain("notes.txt");
    expect(r.content).toContain(join("Projects", "app", "src", "a.ts"));
    for (const rel of PROTECTED_FILES) expect(r.content).not.toContain(rel);
    expect(r.content).not.toContain("Library/Logs");
  });

  test("grep rooted at ~/Library skips the per-app folders and searches Logs", async () => {
    const r = await executeTool("grep", { pattern: "needle", path: join(fake.home, "Library") }, { workspace: fake.home });
    expect(r.content).toContain("Logs/app.log");
    for (const rel of PROTECTED_FILES) expect(r.content).not.toContain(rel);
  });
});

describe("native glob from a workspace at HOME", () => {
  test("`**` lists the home's files and nothing under Library or in a photo library", async () => {
    const r = await executeTool("glob", { pattern: "**/*" }, { workspace: fake.home });
    expect(r.content).toContain("notes.txt");
    expect(r.content).toContain("Projects/app/src/a.ts");
    for (const rel of PROTECTED_FILES) expect(r.content).not.toContain(rel);
    expect(r.content).not.toContain("Library/Logs");
  });

  test("a pattern that names a protected folder is refused, not walked", async () => {
    for (const pattern of ["Library/Containers/**/*", "Library/**/*.txt", "Pictures/Photos Library.photoslibrary/**/*"]) {
      const r = await executeTool("glob", { pattern }, { workspace: fake.home });
      for (const rel of PROTECTED_FILES) expect(r.content).not.toContain(rel);
    }
  });

  test("rooted at ~/Library it lists Logs and skips the per-app folders", async () => {
    const r = await executeTool("glob", { pattern: "**/*", path: join(fake.home, "Library") }, { workspace: fake.home });
    expect(r.content).toContain("Logs/app.log");
    for (const rel of PROTECTED_FILES) expect(r.content).not.toContain(rel.replace(/^Library\//, ""));
  });
});

describe("native search roots inside other apps' data", () => {
  test("`path` inside a protected folder is refused, for glob and for grep", async () => {
    for (const path of [join(fake.home, "Library", "Containers"), "Library/Containers", "Pictures/Photos Library.photoslibrary"]) {
      for (const [tool, pattern] of [["glob", "**/*"], ["grep", "needle"]] as const) {
        const r = await executeTool(tool, { pattern, path }, { workspace: fake.home });
        expect(r.isError).toBe(true);
        expect(leaks(r.content)).toBe(false);
      }
    }
  });

  test("a link to Containers is refused once followed, and a wildcard does not enter it", async () => {
    const app = join(fake.home, "Projects", "app");
    for (const [workspace, input] of [
      [fake.home, { pattern: "**/*", path: "Projects/app/c" }],
      [fake.home, { pattern: "Projects/app/c/**/*" }],
      [app, { pattern: "c/**/*" }],
      [app, { pattern: "**/*", path: "lib2" }],
      [fake.home, { pattern: "**/*" }],
    ] as const) {
      const r = await executeTool("glob", input, { workspace });
      expect(leaks(r.content)).toBe(false);
    }
    const g = await executeTool("grep", { pattern: "needle", path: "Projects/app/c" }, { workspace: fake.home });
    expect(g.isError).toBe(true);
    expect(leaks(g.content)).toBe(false);
  });
});

describe("a protected root is refused before it is touched", () => {
  test("an unreadable container and a missing one answer like a readable one: never opened", async () => {
    // Mode 000 makes any open() fail: a root that answered «cannot read» or «no
    // such folder» here would have been opened before the refusal.
    const locked = join(fake.home, "Library", "Containers", "com.locked.app", "Data");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      for (const path of ["Library/Containers/com.locked.app/Data", "Library/Containers/com.missing.app/Data"]) {
        for (const [tool, pattern] of [["glob", "*"], ["grep", "needle"]] as const) {
          const r = await executeTool(tool, { pattern, path }, { workspace: fake.home });
          expect(r.content).toContain("private data");
        }
      }
      const r = await executeTool("glob", { pattern: "Library/Containers/com.locked.app/Data/*" }, { workspace: fake.home });
      expect(r.content).toContain("private data");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("other spellings of a protected folder", () => {
  // Both exist only on file systems that fold names (APFS, NTFS) and on macOS.
  const folding = process.platform === "darwin" || process.platform === "win32";

  test.if(folding)("`ſ` (long s) is an `s` to the file system, and to the check", async () => {
    for (const path of ["Library/Containerſ/com.other.app", "Pictures/Photos Library.photoſlibrary"]) {
      for (const [tool, pattern] of [["glob", "**/*"], ["grep", "needle"]] as const) {
        const r = await executeTool(tool, { pattern, path }, { workspace: fake.home });
        expect(r.content).toContain("private data");
        expect(leaks(r.content)).toBe(false);
      }
    }
  });

  test.if(process.platform === "darwin")("the data volume's second spelling of HOME is refused before it is touched", async () => {
    const app = join(fake.home, "Projects", "app");
    symlinkSync(`/System/Volumes/Data${realpathSync(fake.home)}`, join(app, "firm"));
    const r = await executeTool("glob", { pattern: "*", path: "firm/Library/Containers/com.other.app" }, { workspace: app });
    expect(r.content).toContain("private data");
  });
});
