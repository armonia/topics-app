# Acceptance: agents and app data in the Topics home

## Bar (each line is a command that exits non-zero when it fails)

1. **Code.** `bun test scripts/rewrite-root-paths.test.ts server/lib/app-data-dir.test.ts client/src/lib/agentSessions.test.ts client/src/lib/hubContext.test.ts` and the old-name gate under `tests/unit/` exit 0; the PR's CI is green.
2. **Mutation on the critical point.** Rewriting the moves least-specific-first
   (drop the sort in `parseMoves` and `withAliases`) turns 3 of the 6 tests in
   `scripts/rewrite-root-paths.test.ts` red. Measured 21/11: 3 pass, 3 fail.
3. **Live check** (`verifica-trasloco`, in the migration toolkit next to Jarvis'
   home, not in this repo because it reads one machine) exits 0 when:
   - neither the old root nor its link exists, and both agent homes hold their
     `AGENTS.md`;
   - the Topics DB holds no value under the old folders and no card on an old
     board id;
   - no live config names the old folders: channel service config and jobs,
     loaded launchd jobs, `~/bin` links, `~/.claude.json`, Codex config,
     harness sync, scripts and docs read by agents;
   - `git worktree list` of both agent homes shows no broken entry;
   - Topics serves a task preview from `~/.topics/media` (HTTP 200) and the
     agents' registry reports workspaces under `~/.topics/agents`.
4. **The main agent answers** a local test turn through the channel service
   after its restart.

## Scenario (behaviour)

Given the sidebar's Agents section before the move, when the move, the DB
rewrite and the restart are done, then the same Jarvis and Visione chats are
listed under the same agents, and Jarvis' board shows its cards. Proof: a
screenshot before and after, side by side.
