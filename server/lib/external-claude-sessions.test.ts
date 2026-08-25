/**
 * @covers EXTSESS-01, EXTSESS-02, EXTSESS-03
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseTranscriptFacts,
  resolveOwningProject,
  isTopicsOwnedSession,
  scanExternalClaudeSessions,
  clearExternalSessionCache,
} from "./external-claude-sessions";

const line = (o: object) => JSON.stringify(o);

describe("parseTranscriptFacts", () => {
  test("takes cwd from the LAST entry (a session can cd) and back-fills branch/entrypoint", () => {
    const text = [
      line({ type: "user", cwd: "/repo", entrypoint: "cli", gitBranch: "main" }),
      line({ type: "assistant", cwd: "/repo/packages/api" }),
      "",
    ].join("\n");
    const facts = parseTranscriptFacts(text);
    expect(facts.cwd).toBe("/repo/packages/api");
    expect(facts.entrypoint).toBe("cli");
    expect(facts.branch).toBe("main");
  });

  test("survives a truncated first line (tail reads land mid-object)", () => {
    const text = ['ontent":"chopped"}', line({ type: "user", cwd: "/repo", entrypoint: "cli" })].join("\n");
    expect(parseTranscriptFacts(text).cwd).toBe("/repo");
  });

  test("flags a sub-agent sidechain so it isn't counted as its own session", () => {
    const text = line({ type: "user", cwd: "/repo", isSidechain: true });
    expect(parseTranscriptFacts(text).sidechain).toBe(true);
  });

  test("no cwd anywhere → nulls, never throws", () => {
    expect(parseTranscriptFacts('{"type":"queue-operation"}\nnot json\n')).toEqual({
      cwd: null, branch: null, entrypoint: null, sidechain: false,
    });
  });
});

describe("resolveOwningProject", () => {
  const candidates = ["/Users/me/Projects/repo", "/Users/me/Projects/repo/packages/api", "/Users/me/Other"];

  test("longest prefix wins (a monorepo package beats the repo root)", () => {
    expect(resolveOwningProject("/Users/me/Projects/repo/packages/api/src", candidates))
      .toBe("/Users/me/Projects/repo/packages/api");
  });

  test("exact match", () => {
    expect(resolveOwningProject("/Users/me/Other", candidates)).toBe("/Users/me/Other");
  });

  test("a sibling that merely shares a name prefix is NOT a match", () => {
    expect(resolveOwningProject("/Users/me/Projects/repo-old", candidates)).toBeNull();
  });

  test("unknown cwd → null (still reported, just unattributed)", () => {
    expect(resolveOwningProject("/tmp/scratch", candidates)).toBeNull();
  });
});

describe("isTopicsOwnedSession", () => {
  const worktreeRoot = "/Users/me/.topics/worktrees";

  test("session id in the tracker roster is ours", () => {
    expect(isTopicsOwnedSession({
      sessionId: "s1", cwd: "/repo", knownSessionIds: new Set(["s1"]), worktreeRoot,
    })).toBe(true);
  });

  test("anything under the worktree root is ours even if the roster lost the row", () => {
    expect(isTopicsOwnedSession({
      sessionId: "s2", cwd: `${worktreeRoot}/repo/witty-otter`, knownSessionIds: new Set(), worktreeRoot,
    })).toBe(true);
  });

  test("a bare terminal session on the real repo is NOT ours", () => {
    expect(isTopicsOwnedSession({
      sessionId: "s3", cwd: "/Users/me/Projects/repo", knownSessionIds: new Set(["s1"]), worktreeRoot,
    })).toBe(false);
  });
});

describe("scanExternalClaudeSessions", () => {
  const NOW = 1_700_000_000_000;
  const worktreeRoot = "/Users/me/.topics/worktrees";

  interface FakeFile { mtimeMs: number; text: string }
  function fakeFs(tree: Record<string, Record<string, FakeFile>>) {
    return {
      readdir: (dir: string) => {
        if (dir === "/projects") return Object.keys(tree);
        const name = dir.slice("/projects/".length);
        return Object.keys(tree[name] ?? {});
      },
      stat: (path: string) => {
        const [, , enc, file] = path.split("/");
        const f = tree[enc!]?.[file!];
        return f ? { mtimeMs: f.mtimeMs, size: f.text.length } : null;
      },
      readTail: (path: string, _bytes: number) => {
        const [, , enc, file] = path.split("/");
        return tree[enc!]?.[file!]?.text ?? "";
      },
    };
  }

  const base = {
    projectsDir: "/projects",
    candidatePaths: ["/Users/me/Projects/repo", "/Users/me/Projects/other"],
    projectIdFor: (p: string) => `id:${p}`,
    worktreeRoot,
    nowMs: NOW,
  };

  beforeEach(() => clearExternalSessionCache());

  test("reports a bare terminal session with project, branch and last activity", () => {
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(),
      fs: fakeFs({
        "-Users-me-Projects-repo": {
          "aaa.jsonl": {
            mtimeMs: NOW - 30_000,
            text: line({ type: "user", cwd: "/Users/me/Projects/repo", gitBranch: "main", entrypoint: "cli" }),
          },
        },
      }),
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "aaa",
      cwd: "/Users/me/Projects/repo",
      projectPath: "/Users/me/Projects/repo",
      projectId: "id:/Users/me/Projects/repo",
      branch: "main",
      entrypoint: "cli",
      state: "active",
    });
  });

  test("excludes Topics' own sessions: roster ids and agent worktrees", () => {
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(["mine"]),
      fs: fakeFs({
        "-Users-me-Projects-repo": {
          "mine.jsonl": { mtimeMs: NOW - 1000, text: line({ cwd: "/Users/me/Projects/repo" }) },
        },
        "-Users-me--topics-worktrees-repo-witty-otter": {
          "agent.jsonl": { mtimeMs: NOW - 1000, text: line({ cwd: `${worktreeRoot}/repo/witty-otter` }) },
        },
      }),
    });
    expect(sessions).toEqual([]);
  });

  test("mtime older than the window is skipped without reading the file", () => {
    let reads = 0;
    const fs = fakeFs({
      "-Users-me-Projects-repo": {
        "old.jsonl": { mtimeMs: NOW - 9 * 60 * 60_000, text: line({ cwd: "/Users/me/Projects/repo" }) },
      },
    });
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(),
      fs: { ...fs, readTail: (p: string, n: number) => { reads++; return fs.readTail(p, n); } },
    });
    expect(sessions).toEqual([]);
    expect(reads).toBe(0);
  });

  test("classifies idle vs active and sorts newest first", () => {
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(),
      fs: fakeFs({
        "-Users-me-Projects-repo": {
          "idle.jsonl": { mtimeMs: NOW - 60 * 60_000, text: line({ cwd: "/Users/me/Projects/repo" }) },
        },
        "-Users-me-Projects-other": {
          "hot.jsonl": { mtimeMs: NOW - 5_000, text: line({ cwd: "/Users/me/Projects/other" }) },
        },
      }),
    });
    expect(sessions.map((s) => [s.sessionId, s.state])).toEqual([["hot", "active"], ["idle", "idle"]]);
  });

  test("a session outside every known project is still reported, unattributed", () => {
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(),
      fs: fakeFs({
        "-tmp-scratch": { "x.jsonl": { mtimeMs: NOW - 1000, text: line({ cwd: "/tmp/scratch" }) } },
      }),
    });
    expect(sessions[0]).toMatchObject({ cwd: "/tmp/scratch", projectPath: null, projectId: null });
  });

  test("sub-agent sidechain transcripts are not counted as sessions", () => {
    const sessions = scanExternalClaudeSessions({
      ...base,
      knownSessionIds: new Set(),
      fs: fakeFs({
        "-Users-me-Projects-repo": {
          "sub.jsonl": { mtimeMs: NOW - 1000, text: line({ cwd: "/Users/me/Projects/repo", isSidechain: true }) },
        },
      }),
    });
    expect(sessions).toEqual([]);
  });
});
