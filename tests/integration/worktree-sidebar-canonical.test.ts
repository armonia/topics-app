/**
 * Where a worktree of a repository ends up in the sidebar: under the repository's project, as a
 * section of its own, and never as a project of its own. The two halves live in different layers
 * (the server decides which project a folder belongs to, the sidebar decides how a project's
 * topics are drawn), and each is proved alone elsewhere; this file runs them one after the other on
 * real git, which is the meeting that `**Intersects:**` declares.
 *
 * @covers WORKTREE-STD-05+TOPIC-WT-02
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProjectFor } from "../../server/services/project-path-resolver";
import { groupProjectChildrenByWorktree, type WorktreeLabel } from "../../client/src/lib/sidebarWorktrees";
import type { SidebarItem } from "../../client/src/lib/buildSidebarItems";
import type { Topic } from "../../client/src/types";
import { gitEnv } from "../setup/bun-test-preload";

describe("a worktree of a repository in the sidebar", () => {
  let base: string;
  let repo: string;
  const worktrees: Record<string, string> = {};
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore", env: gitEnv() });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "wt-sidebar-")));
    repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    git(base, "init", "-q", repo);
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    for (const name of ["alpha", "beta"]) {
      worktrees[name] = join(base, "wt", name);
      git(repo, "worktree", "add", "-q", "-b", name, worktrees[name]!);
    }
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const projects = () => [{ id: "p-repo", slug: "repo", path: repo }];

  function chatIn(id: string, projectPath: string, worktreeId: string | null): SidebarItem {
    const topic = { id, name: id, slug: id, parentId: null, links: [], sessionKey: `topic:${id}`, color: "#0066cc", icon: "", createdAt: "", updatedAt: "", archived: false, worktreeId } as Topic;
    return { id, type: "chat", name: id, icon: "", lastActivity: 0, notificationCount: 0, archived: false, projectPath, topic };
  }

  it("two worktrees resolve to ONE project, and its sidebar shows them as two sections", () => {
    const resolved = ["alpha", "beta"].map((name) => canonicalProjectFor(worktrees[name]!, projects()));
    // STD-05: neither folder is a project, both belong to the repository's.
    expect(resolved.map((p) => p?.id)).toEqual(["p-repo", "p-repo"]);

    // TOPIC-WT-02: the topics opened in those folders hang under that one project, split by worktree.
    const children = [
      chatIn("t-alpha", resolved[0]!.path, "w-alpha"),
      chatIn("t-beta", resolved[1]!.path, "w-beta"),
      chatIn("t-main", resolved[0]!.path, null),
    ];
    const labels = new Map<string, WorktreeLabel>([
      ["w-alpha", { id: "w-alpha", name: "alpha", branchName: "alpha" }],
      ["w-beta", { id: "w-beta", name: "beta", branchName: "beta" }],
    ]);
    const grouping = groupProjectChildrenByWorktree(children, labels);
    expect(new Set(children.map((c) => c.projectPath))).toEqual(new Set([repo]));
    expect(grouping.sections.map((s) => [s.worktree?.name, s.items.map((i) => i.id)])).toEqual([
      ["alpha", ["t-alpha"]],
      ["beta", ["t-beta"]],
    ]);
    expect(grouping.base.map((i) => i.id)).toEqual(["t-main"]);
  });

  it("a worktree folder is not found among the projects: with no row for the repository nothing is invented", () => {
    expect(canonicalProjectFor(worktrees.alpha!, [{ id: "p-other", slug: "other", path: join(base, "other") }])).toBeNull();
  });
});
