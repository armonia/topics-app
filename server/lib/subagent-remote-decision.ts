/**
 * THE DECISION, not the wiring (openspec/changes/sottoagenti-nodo, trace 1).
 *
 * A `spawn_agent` child today always opens on this machine. Before any run
 * can move to a paired node, something has to say whether THIS spawn may:
 * this is that something, a pure function with no fs/db/process access of
 * its own. The caller resolves the inputs (is `cwd` a git working tree? is a
 * mac-only resource alive?) and wires the "yes" branch to an actual remote
 * run in a later trace.
 *
 * THE THREE RULES, in the order they are checked:
 *  1. An explicit `runtime: "claude-code"` always stays here: it opens a PTY
 *     on THIS machine (`childRuntimeFor` in `native-subagents.ts`), and a node
 *     has no CLI road for it yet.
 *  2. A live mac-only resource the child would need — the same reasons a
 *     card's `stayLocal` protects (`task-shapes.ts`: local processes, Jarvis,
 *     sessions, macOS itself), plus the GitHub CLI's login — keeps the child
 *     here too: a node has none of those to hand it.
 *  3. Otherwise: a git working tree (GitHub origin or a plain local repo)
 *     can go remote, because a node can clone and push to it. Anything else
 *     — no `.git` at all — cannot: there is nothing for a node to check out.
 */

/**
 * A live resource only this machine has, the same ones `stayLocal` names on a
 * card, plus `"gh"`: the GitHub CLI's login is a local credential on whatever
 * machine ran `gh auth login`, never carried in the child's bundle (that is
 * git history and the working tree, not `~/.config/gh`), and Topics has no
 * way to ask a node whether its own `gh` is logged in the way it does for a
 * node's coding-model catalog (`nodeModels`). A child that reads CI or a PR
 * through `gh` on a node without that login gets nothing to read and reports
 * back empty, the same shape as the other three (SUBAGENT-28, 19/11: two
 * children of the same chain lost a turn each to this).
 */
export type MacOnlyResource = "macos" | "browser" | "session" | "jarvis" | "gh";

export interface RemoteSpawnRequest {
  /** The runtime the caller asked for (`body.runtime` on `/agents/spawn`); undefined = no preference. */
  runtime?: "topics" | "claude-code" | null;
  /** Whether `cwd` is a git working tree (`.git` present), GitHub-hosted or purely local — both count. */
  isGitRepo: boolean;
  /** A mac-only resource this spawn would need alive, if any; null/undefined = none. */
  macOnlyResource?: MacOnlyResource | null;
}

export interface RemoteSpawnDecision {
  remote: boolean;
  reason: string;
}

const MAC_ONLY_RESOURCE_LABEL: Readonly<Record<MacOnlyResource, string>> = {
  macos: "macOS itself",
  browser: "a live browser pane",
  session: "a live session",
  jarvis: "Jarvis, which only runs here",
  gh: "the GitHub CLI's login, a local credential no node is known to share",
};

/**
 * Whether a `spawn_agent` child may run on a paired node instead of here, and
 * why. See the module doc for the three rules and their order.
 */
export function decideRemoteSpawn(request: RemoteSpawnRequest): RemoteSpawnDecision {
  if (request.runtime === "claude-code") {
    return { remote: false, reason: "runtime \"claude-code\" opens a PTY on this machine: no CLI road on a node yet" };
  }
  if (request.macOnlyResource) {
    return {
      remote: false,
      reason: `needs ${MAC_ONLY_RESOURCE_LABEL[request.macOnlyResource]}, the same reason a card's stayLocal keeps it here`,
    };
  }
  if (!request.isGitRepo) {
    return { remote: false, reason: "cwd is not a git repository: a node has nothing to clone or push" };
  }
  return { remote: true, reason: "cwd is a git repository (GitHub origin or local-only): a node can clone and push to it" };
}
