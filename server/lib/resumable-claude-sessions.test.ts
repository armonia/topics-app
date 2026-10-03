/**
 * `/resume`'s own reading of the transcripts (CMDUI-03), on a fake file system
 * that counts what is read, the same seam `external-claude-sessions.test.ts`
 * uses for the census.
 *
 * @covers CMDUI-03
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearResumableCache, listResumableClaudeSessions, parseTranscriptTitle, type ResumableFs } from "./resumable-claude-sessions";
import { clearExternalSessionCache, scanExternalClaudeSessions } from "./external-claude-sessions";
import { claudeProjectDirName } from "./claude-transcript-path";

const ROOT = "/fake/.claude/projects";
const PROJECT = "/Users/someone/Projects/topics-app";
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

interface FakeFile { mtimeMs: number; text: string }

/** A fake store: folder name -> file name -> file. Counts every tail read. */
function fakeFs(tree: Record<string, Record<string, FakeFile>>) {
  const tails: string[] = [];
  const fs: ResumableFs = {
    async readdir(dir) {
      if (dir === ROOT) return Object.keys(tree);
      const folder = tree[dir.slice(ROOT.length + 1)];
      return folder ? Object.keys(folder) : [];
    },
    async stat(path) {
      const f = lookup(path);
      return f ? { mtimeMs: f.mtimeMs, size: f.text.length } : null;
    },
    async readTail(path) {
      tails.push(path);
      return lookup(path)?.text ?? "";
    },
  };
  function lookup(path: string): FakeFile | undefined {
    const rel = path.slice(ROOT.length + 1);
    const at = rel.indexOf("/");
    return tree[rel.slice(0, at)]?.[rel.slice(at + 1)];
  }
  /** The same store, as the census's synchronous seam. */
  const syncFs = {
    readdir: (dir: string) => (dir === ROOT ? Object.keys(tree) : Object.keys(tree[dir.slice(ROOT.length + 1)] ?? {})),
    stat: (path: string) => { const f = lookup(path); return f ? { mtimeMs: f.mtimeMs, size: f.text.length } : null; },
    readTail: (path: string) => { tails.push(path); return lookup(path)?.text ?? ""; },
  };
  return { fs, syncFs, tails };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o);
function transcript(cwd: string, extra: Array<Record<string, unknown>> = [], branch = "main"): string {
  return [
    line({ type: "user", cwd, gitBranch: branch, entrypoint: "cli", message: { role: "user", content: "ciao" } }),
    ...extra.map(line),
  ].join("\n") + "\n";
}

const DIR = claudeProjectDirName(PROJECT);

beforeEach(() => {
  clearResumableCache();
  clearExternalSessionCache();
});

describe("parseTranscriptTitle", () => {
  test("the name given with /rename wins, then the CLI's title, then the last question", () => {
    const all = [
      line({ type: "last-prompt", lastPrompt: "sistema il menu" }),
      line({ type: "ai-title", aiTitle: "Menu del composer" }),
      line({ type: "custom-title", customTitle: "Menu utente" }),
    ].join("\n");
    expect(parseTranscriptTitle(all)).toEqual({ title: "Menu utente", source: "custom" });
    expect(parseTranscriptTitle([line({ type: "ai-title", aiTitle: "Menu del composer" }), line({ type: "last-prompt", lastPrompt: "x" })].join("\n")))
      .toEqual({ title: "Menu del composer", source: "ai" });
    const long = "a".repeat(200);
    const p = parseTranscriptTitle(line({ type: "last-prompt", lastPrompt: long }));
    expect(p.source).toBe("prompt");
    expect(p.title!.length).toBe(80);
    expect(parseTranscriptTitle("not json\n")).toEqual({ title: null, source: null });
  });
});

describe("listResumableClaudeSessions", () => {
  test("the title comes from custom-title, then ai-title, then last-prompt, newest first", async () => {
    const { fs } = fakeFs({
      [DIR]: {
        "s-old.jsonl": { mtimeMs: NOW - 60 * 60_000, text: transcript(PROJECT, [{ type: "last-prompt", lastPrompt: "rifai i test" }]) },
        "s-new.jsonl": { mtimeMs: NOW - 30 * 60_000, text: transcript(PROJECT, [{ type: "custom-title", customTitle: "Menu utente" }], "feat/menu") },
      },
    });
    const page = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(page.sessions.map((s) => [s.sessionId, s.title, s.titleSource, s.branch])).toEqual([
      ["s-new", "Menu utente", "custom", "feat/menu"],
      ["s-old", "rifai i test", "prompt", "main"],
    ]);
    expect(page.more).toBe(false);
  });

  test("only the project's folders are opened, and a cwd outside the project is dropped even with the prefix (topics-app2)", async () => {
    const other = "/Users/someone/Projects/topics-app2";
    const { fs, tails } = fakeFs({
      [DIR]: { "mine.jsonl": { mtimeMs: NOW - 1000, text: transcript(PROJECT) } },
      [claudeProjectDirName(`${PROJECT}/client`)]: { "sub.jsonl": { mtimeMs: NOW - 2000, text: transcript(`${PROJECT}/client`) } },
      [claudeProjectDirName(other)]: { "twin.jsonl": { mtimeMs: NOW - 500, text: transcript(other) } },
      [claudeProjectDirName("/Users/someone/Projects/elsewhere")]: { "far.jsonl": { mtimeMs: NOW, text: transcript("/Users/someone/Projects/elsewhere") } },
    });
    const page = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["mine", "sub"]);
    // The other project's folder is never read; the twin's is (prefix), and its cwd drops it.
    expect(tails.some((t) => t.includes("elsewhere"))).toBe(false);
  });

  test("a session a chat already holds is dropped without reading its tail", async () => {
    const { fs, tails } = fakeFs({
      [DIR]: {
        "owned.jsonl": { mtimeMs: NOW - 1000, text: transcript(PROJECT) },
        "free.jsonl": { mtimeMs: NOW - 2000, text: transcript(PROJECT) },
      },
    });
    const page = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(["owned"]), projectsDir: ROOT, nowMs: NOW, fs });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["free"]);
    expect(tails.some((t) => t.endsWith("owned.jsonl"))).toBe(false);
  });

  test("25 transcripts: 20 rows, 20 tails read, more; the next page has the other 5", async () => {
    const files: Record<string, FakeFile> = {};
    for (let i = 0; i < 25; i++) files[`s${String(i).padStart(2, "0")}.jsonl`] = { mtimeMs: NOW - i * 60_000, text: transcript(PROJECT) };
    const { fs, tails } = fakeFs({ [DIR]: files });
    const first = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(first.sessions).toHaveLength(20);
    expect(first.more).toBe(true);
    expect(tails).toHaveLength(20);
    const second = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), before: first.cursor, projectsDir: ROOT, nowMs: NOW, fs });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["s20", "s21", "s22", "s23", "s24"]);
    expect(second.more).toBe(false);
    expect(tails).toHaveLength(25);
  });

  test("touched in the last 15 minutes is active", async () => {
    const { fs } = fakeFs({
      [DIR]: {
        "live.jsonl": { mtimeMs: NOW - 2 * 60_000, text: transcript(PROJECT) },
        "cold.jsonl": { mtimeMs: NOW - 60 * 60_000, text: transcript(PROJECT) },
      },
    });
    const page = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(page.sessions.map((s) => [s.sessionId, s.active])).toEqual([["live", true], ["cold", false]]);
  });

  test("a second /resume on unchanged files reads no tail; a changed file is read again", async () => {
    const tree = { [DIR]: { "a.jsonl": { mtimeMs: NOW - 1000, text: transcript(PROJECT) }, "b.jsonl": { mtimeMs: NOW - 2000, text: transcript(PROJECT) } } };
    const { fs, tails } = fakeFs(tree);
    await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(tails).toHaveLength(2);
    await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(tails).toHaveLength(2);
    tree[DIR]["a.jsonl"] = { mtimeMs: NOW - 10, text: transcript(PROJECT, [{ type: "ai-title", aiTitle: "nuovo" }]) };
    const again = await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    expect(tails).toHaveLength(3);
    expect(again.sessions[0]).toMatchObject({ sessionId: "a", title: "nuovo" });
  });

  test("after a /resume the census, with the same files, reads no tail again", async () => {
    const tree = { [DIR]: { "a.jsonl": { mtimeMs: NOW - 1000, text: transcript(PROJECT) } } };
    const { fs, syncFs, tails } = fakeFs(tree);
    const census = () => scanExternalClaudeSessions({ projectsDir: ROOT, knownSessionIds: new Set(), candidatePaths: [PROJECT], projectIdFor: () => "p", worktreeRoot: "/nowhere", nowMs: NOW, fs: syncFs });
    census();
    const afterCensus = tails.length;
    expect(afterCensus).toBe(1);
    await listResumableClaudeSessions({ projectPath: PROJECT, ownedSessionIds: new Set(), projectsDir: ROOT, nowMs: NOW, fs });
    const afterResume = tails.length;
    census();
    expect(tails.length).toBe(afterResume);
    expect(join(ROOT, DIR, "a.jsonl")).toBe(tails[0]!);
  });
});
