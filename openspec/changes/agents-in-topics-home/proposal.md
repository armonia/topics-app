# Agents and app data in the Topics home

## Deciso da me

21/11 02:20, one yes for the whole package: move the folders, rewrite every saved
path (Topics DB, channel service, launchd, scripts, Claude Code folders, git
worktrees, private and public sync), restart the channel service, the hub
service and Topics, retire the old root, every transition link and the old
gateway's leftovers, rename the Keychain items, and fix the lines of CLAUDE.md.
Cutover only on a clean dry run; rollback if the main agent does not answer.

## Perché

One folder was two homes at once: the always-on agents' home (Jarvis, Visione)
and Topics' app data root, reached through a link under the product's older
name. Topics followed that link whenever it existed, so the app wrote previews,
task sheets and waiting items into the agents' folder, agents were recognised by
two hard-coded path suffixes (one of them a personal path in public code), and
a daily job was about to delete the link and silently move the app data root.

## Cosa cambia

- **One home.** The app data root is `APP_DATA_DIR` or the Topics home
  (`~/.topics`), nothing else. The legacy branch and its constant are gone.
- **Agents live in Topics.** Every agent's home is `~/.topics/agents/<id>`, and
  the folder name is the agent: `jarvis`, `gtm` (Visione). One rule in
  `shared/agent-home.ts`, used by the sidebar, the cards and the hub view.
- **Owner split.** What Topics writes (`media/task-previews`, `media/task-sheets`,
  `media/browser/downloads`, `cache/`, `waiting-items.json`, `orchestrator-cwd/`,
  `workspace/{generale,tasks,topics-app}`) goes to `~/.topics`; the rest of the
  old folder is Jarvis' home; its `workspace-gtm` is Visione's.
- **Saved paths follow.** `scripts/rewrite-root-paths.ts --map OLD=NEW [--alias]`
  rewrites every text column and rekeys the boards (a board id is a hash of its
  folder): 44 cards of Jarvis' board and 52 of a board orphaned by the earlier
  rewrite come back. Each rekeyed board leaves a `board_aliases` row (old id ->
  new id), so a link or a message that still names the old id lands on the
  moved board, not on an empty one.

Outside this repo, same night, same map (tracks in `tasks.md`): channel service
config and jobs, guest wall policy, launchd jobs, scripts and docs, the 62
Claude Code folders keyed by the old path, git worktrees, Keychain names.

## Scelte tecniche (le ho prese io)

- `agents/<id>` under the Topics home rather than `~/Agents`: a dot folder stays
  out of the public presence (`PUBLIC_PROJECT_SQL`) and out of the project
  picker (`NON_PROJECT_DOTDIR`), exactly as before.
- Ids stay `jarvis` and `gtm`: renaming `gtm` touches session keys and bindings
  in the channel service for no gain.
- A same-disk rename, not a copy: instant, nothing duplicated, reversible with
  the inverse rename. A link stands at the old path only while configs are
  rewritten, then it goes.
- A machine with data under an older root migrates with the same script; the
  server no longer looks for it.

## Barra

`acceptance.md`. In short: the touched tests exit 0, a live check exits 0
(no old path in the DB, configs, plists or links; agent homes in place; boards
rekeyed; services healthy), the main agent answers a local turn.

## Fuori

History is not rewritten: git history, transcripts' contents, archived jobs,
applied SQL migrations, CHANGELOG. Test fixtures with fake users stay.
The legacy JSONL session fallback (`agents/main/sessions`) is untouched.

## Non ancora specificato

- Whether guests' sandbox should deny the whole Topics home or only the agents'
  homes: tonight it denies both, the finer rule needs a case first.
