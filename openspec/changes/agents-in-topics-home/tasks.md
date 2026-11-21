# Tracks

Each track has its bar; its state is given by git and by the bar, not by a box.

1. **Topics code** (this repo): one app data root, `agents/<id>` rule, generic
   rewrite script with board rekey, tests. Bar: acceptance 1 and 2.
2. **Move** (live, same disk): Topics-owned parts to `~/.topics`, Visione's home
   to `~/.topics/agents/gtm`, the rest to `~/.topics/agents/jarvis`; transition
   link at the old path while 3 to 6 run. Bar: both `AGENTS.md` readable.
3. **Topics DB and UI state**: open chats re-pointed through the API, then
   `rewrite-root-paths.ts` with the same map and the former link as alias; tabs
   and pins through the UI-state API. Bar: no old value, no old board id.
4. **Channel service**: `engine.json` workspaces, `jobs.json` (and its last-good
   copy), `config.json`, cached prompts, guest wall policy; new binary without
   the old-name guard; restart. Bar: health exits 0 and a local turn answers.
5. **Machine config**: launchd jobs (rewritten and reloaded), `~/bin` links,
   hub service (rebuilt), scripts, hooks, docs, `~/.claude.json`, Codex config,
   harness sync, private/public sync and their mirror folder names, Claude Code
   folders keyed by path, git worktrees, Keychain names, dead leftovers of the
   old gateway retired. Bar: the live check's config scan finds nothing.
6. **Cut the links**: remove the transition link and the old root's link, then
   the full live check. Bar: acceptance 3 and 4.
