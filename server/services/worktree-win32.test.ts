/**
 * The Windows rules of the worktree code, run on any machine: every helper takes
 * the platform as a parameter, so a POSIX runner exercises the Windows answer
 * instead of skipping it.
 *
 * @covers WORKTREE-STD-10
 */
import { describe, expect, test } from "bun:test";
import { anyInsideDir, isInsideDir } from "../lib/path-containment";
import { adminDirFromDotGit, canonicalPath, pathKey } from "./worktree-owner";
import { removalMeansAlive, worktreeGitArgs } from "./worktree-platform";
import { createWorktreesRouter } from "../routes/worktrees";
import type { AppContext } from "../types";
import { rowAtPath } from "./worktree-register";
import type { Worktree } from "../types";

const W = "win32" as const;

describe("containment with the Windows separator", () => {
  test("a cwd under the folder is inside, with either slash and either case", () => {
    expect(isInsideDir("C:\\wt\\repo\\x\\src", "C:\\wt\\repo\\x", W)).toBe(true);
    expect(isInsideDir("C:/wt/repo/x/src", "C:\\wt\\repo\\x", W)).toBe(true);
    expect(isInsideDir("c:\\WT\\repo\\x", "C:\\wt\\repo\\x", W)).toBe(true);
  });

  test("a sibling with the same prefix, or another drive, is not", () => {
    expect(isInsideDir("C:\\wt\\repo\\x-2", "C:\\wt\\repo\\x", W)).toBe(false);
    expect(isInsideDir("D:\\wt\\repo\\x", "C:\\wt\\repo\\x", W)).toBe(false);
  });

  test("the live-cwd guard sees a Windows cwd under the folder (the `+ \"/\"` it replaced never did)", () => {
    const cwds = ["C:\\Users\\u\\.topics\\worktrees\\repo\\x\\packages\\a", ""];
    expect(anyInsideDir(cwds, "C:\\Users\\u\\.topics\\worktrees\\repo\\x", W)).toBe(true);
    const handAppended = "C:\\Users\\u\\.topics\\worktrees\\repo\\x" + "/";
    expect(cwds[0]!.startsWith(handAppended)).toBe(false);
    expect(anyInsideDir(cwds, "C:\\Users\\u\\.topics\\worktrees\\repo\\y", W)).toBe(false);
  });
});

describe("one folder, one key", () => {
  // A fake NTFS: case-insensitive, answering with the spelling it stores.
  const stored = new Map([["c:\\users\\u\\wt\\repo\\x", "C:\\Users\\u\\wt\\repo\\x"]]);
  const windowsLinks = (p: string) => {
    const hit = stored.get(p.toLowerCase());
    if (!hit) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return hit;
  };

  test("two spellings of an existing path canonicalise to the stored one", () => {
    expect(canonicalPath("c:\\users\\u\\wt\\repo\\x", { platform: W, realpath: windowsLinks })).toBe("C:\\Users\\u\\wt\\repo\\x");
    expect(canonicalPath("C:/Users/U/wt/repo/x", { platform: W, realpath: windowsLinks })).toBe("C:\\Users\\u\\wt\\repo\\x");
  });

  test("a path that is gone keeps its tail, and the key ignores case", () => {
    expect(canonicalPath("c:\\users\\u\\wt\\repo\\x\\gone", { platform: W, realpath: windowsLinks })).toBe("C:\\Users\\u\\wt\\repo\\x\\gone");
    expect(pathKey("C:\\Nowhere\\A", { platform: W, realpath: windowsLinks })).toBe(pathKey("c:\\nowhere\\a", { platform: W, realpath: windowsLinks }));
  });

  test("two spellings of the same path find ONE row", () => {
    const row = { id: "w1", absPath: "C:\\Users\\u\\wt\\repo\\x" } as Worktree;
    const store = { getByAbsPath: (p: string) => (p === row.absPath ? row : null), list: () => [row] };
    const deps = { store, platform: W, canonical: (p: string) => canonicalPath(p, { platform: W, realpath: windowsLinks }) } as unknown as Parameters<typeof rowAtPath>[0];
    expect(rowAtPath(deps, "C:\\USERS\\U\\WT\\REPO\\X")?.id).toBe("w1");
    expect(rowAtPath({ ...deps, platform: "darwin" } as typeof deps, "C:\\USERS\\U\\WT\\REPO\\X")).toBeNull();
  });

  test("a `.git` file written by Git for Windows (forward slashes) names the admin folder", () => {
    expect(adminDirFromDotGit("E:\\wt\\repo\\x", "gitdir: E:/repo/.git/worktrees/x\n", W)).toBe("E:\\repo\\.git\\worktrees\\x");
  });
});

describe("git and removal on Windows", () => {
  test("`core.longpaths=true` rides every worktree add on win32, and only there", () => {
    expect(worktreeGitArgs(["worktree", "add", "-b", "b", "E:\\wt\\r\\x", "main"], W))
      .toEqual(["-c", "core.longpaths=true", "worktree", "add", "-b", "b", "E:\\wt\\r\\x", "main"]);
    expect(worktreeGitArgs(["worktree", "add", "/r/x"], "darwin")).toEqual(["worktree", "add", "/r/x"]);
  });

  test("EBUSY and EPERM mean somebody is inside: alive, not a failure to escalate", () => {
    expect(removalMeansAlive(Object.assign(new Error("x"), { code: "EBUSY" }), W)).toBe(true);
    expect(removalMeansAlive(Object.assign(new Error("x"), { code: "EPERM" }), W)).toBe(true);
    expect(removalMeansAlive({ stderr: "error: failed to delete 'E:/wt/x': Permission denied" }, W)).toBe(true);
    expect(removalMeansAlive({ stderr: "The process cannot access the file because it is being used by another process." }, W)).toBe(true);
    expect(removalMeansAlive(Object.assign(new Error("x"), { code: "ENOENT" }), W)).toBe(false);
    // On POSIX a busy folder still unlinks: the rule does not apply.
    expect(removalMeansAlive(Object.assign(new Error("x"), { code: "EBUSY" }), "linux")).toBe(false);
  });
});

describe("the relocate route takes a Windows path", () => {
  test("`C:\\x` reaches the relocation with platform win32; a drive-relative path does not", async () => {
    const calls: string[] = [];
    const ctx = {
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
      readJSON: async (req: Request) => req.json(),
      errorResponse: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }),
    } as unknown as AppContext;
    const router = createWorktreesRouter(ctx, {
      platform: W,
      relocate: {
        check: async (a, p) => { calls.push(`${a}:${p}`); return { action: a, from: p, to: null, projectId: null, projectName: null, rowId: null, ok: true, refusals: [], warnings: [] } as never; },
        run: async () => ({ ok: false }) as never,
      },
    });
    const post = (path: string) => {
      const url = new URL("https://127.0.0.1/api/worktrees/relocate");
      return router(new Request(url, { method: "POST", body: JSON.stringify({ path, action: "adopt", dryRun: true }) }), url, url.pathname, "POST");
    };
    expect((await post("C:\\Users\\u\\wt"))!.status).toBe(200);
    expect(calls).toEqual(["adopt:C:\\Users\\u\\wt"]);
    expect((await post("C:repo"))!.status).toBe(400);
  });
});
