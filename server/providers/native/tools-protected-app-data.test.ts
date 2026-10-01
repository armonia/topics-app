/**
 * The native agent's `grep` is SERVER code walking a tree: from a workspace at
 * HOME (a topic whose project is the home folder) it must not read other apps'
 * data on the way (`lib/protected-app-data.ts`).
 *
 * `glob` is not covered here on purpose: it is a bash pattern, and the macOS
 * `/bin/bash` (3.2) has no `globstar`, so `**` matches ONE level like `*`. It
 * reaches inside another app's folder only when the pattern itself spells
 * every level out, which is the agent asking, not the server walking.
 *
 * The workspace is a temporary tree laid out like a home, never the real one.
 * Every protected file holds `needle`, so a walk that enters one shows it.
 *
 * @covers RT-11
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { executeTool } from "./tools";
import { makeFakeHome, PROTECTED_FILES, type FakeHome } from "../../lib/protected-app-data.fixture";

let fake: FakeHome;
beforeAll(() => { fake = makeFakeHome(); });
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
