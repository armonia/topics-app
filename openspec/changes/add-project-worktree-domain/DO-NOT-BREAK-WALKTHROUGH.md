# Phase A — Do-Not-Break Walkthrough

> One paragraph per item from `/tmp/omnara-analysis/reports/05-topics-current-state.md` §10. Each entry: where the capability lives, what could regress, and the receipt confirming Phase A leaves it intact.

| # | Capability | Verdict | Receipt |
|---|---|---|---|
| 1 | Per-topic provider+model selection (`topics.provider`, `topics.model`) | ✅ untouched | Migrations 016–018 only `CREATE TABLE` and `ADD COLUMN ... NULL`; the existing columns and the picker are not modified. `pragma table_info('topics')` after applying mig 018 still shows `provider`/`model` at the same column positions. |
| 2 | Multi-provider runtime + CLI auto-detection | ✅ untouched | `server/providers/index.ts` has zero diff in this phase. `Bun.which` calls and env-var contracts unchanged. |
| 3 | Stateless vs stateful providers (`history` capability) | ✅ untouched | `server/providers/types.ts` not edited. The `resolveTopicCwd` change in `routes/topics.ts` is pure cwd-resolution; it does not touch the `options.history` plumbing. |
| 4 | JSONL sub-agent completion polling | ✅ untouched | `routes/topics.ts:127-220` polling block is preserved verbatim; only later sites in the same file were edited (browser auto-navigate, template auto-loading, project-awareness). |
| 5 | Cross-tab/device pane-store sync (`payload_version=2` + `server_seq`) | ✅ untouched | `server/state/pane/middleware/*` and `routes/ui-state.ts` are not edited. The new `purgeWorktreeFromUiState` (`server/services/ui-state-purge.ts`) is a *parallel* helper that uses the same `BEGIN IMMEDIATE` + `MAX(server_seq)+1` pattern; it never decreases a `server_seq`. Integration test `deleting a worktree NULLs topics.worktree_id` exercises this. |
| 6 | `purgeTopicFromUiState` ghost-topic fix | ✅ untouched | `routes/topics.ts:23-94` is not edited. The worktree-purge helper is a sibling, not a rewrite. |
| 7 | WS catch-up on connect for active streams | ✅ untouched | `server.ts:402-414` activeStreams replay block has zero diff. |
| 8 | Tray menu + dock badge (Electron) | ✅ untouched | `electron-app/main.ts` is not edited in this phase. The new WS broadcast types (`project:*`, `worktree:*`) are folded into the union but the tray bridge subscribes only to its existing types. |
| 9 | Detached topic windows (`?topic=...`) | ✅ untouched | `App.tsx:127-129` detection logic and `setWindowOpenHandler` matcher are not edited. |
| 10 | Web-Push notifications (VAPID) | ✅ untouched | `server/push-service.ts`, `push-triggers.ts`, `vapid-keys.json` not edited. |
| 11 | Terminal session persistence + dormant/revive | ✅ untouched | `server/routes/terminal.ts`, `pty-bridge.mjs` not edited. `disconnectBridge()` graceful-shutdown block in `server.ts:475` unchanged. |
| 12 | CDP control on port 19333 | ✅ untouched | `electron-app/main.ts:135` not edited. |
| 13 | TLS auto-detect (`server.ts:213-227`) | ✅ untouched | `Bun.serve({…, tls: optional})` block has zero diff. |
| 14 | Dev-mode Vite proxy via `?dev=true` cookie | ✅ untouched | `server.ts:252-271` not edited. |
| 15 | OpenClaw context inspector (conditionally mounted) | ✅ untouched | `routes/openclaw-context.ts` and the conditional registration in `server.ts:356` not edited. |
| 16 | Chronological `blocks` content timeline | ✅ untouched | `MessageContent.tsx`, `MessageParts.tsx` not edited. The renderer continues to fall back to legacy bucket rendering for null `blocks`. |
| 17 | Branching messages (`active_branches`, `loadActiveThread`) | ✅ untouched | `server/utils.ts` branching helpers (`createBranchMessage`, `switchActiveBranch`, `getSiblingMessages`, `loadActiveThread`) not edited. The new spec TOPIC-WT-02 explicitly distinguishes message-level branching from worktree-level branching to prevent future confusion. |
| 18 | Per-message footer meta (`latency_ms`, `usage_*_tokens`, `cost_cents`) | ✅ untouched | `MessageMetaFooter.tsx` and the persistence path in `utils.ts:rowToMessage` not edited. |
| 19 | Manual checkpoints | ✅ untouched | `routes/checkpoints.ts`, `components/Chat/CheckpointTimeline.tsx`, the on-disk `checkpoints/` directory are not edited or migrated. |
| 20 | Activity feed (real-time tail) | ✅ untouched | `server/activity-monitor.ts`, `routes/activity.ts`, the SSE endpoint, and the 14 categories are not edited. |
| 21 | Journal collector + LLM digest | ✅ untouched | `server/journal-collector.ts`, `routes/journal.ts` not edited. |
| 22 | Slash commands in chat (`/api/command`) | ✅ untouched | `routes/topics.ts:2840` slash-command handler not edited. The cwd-resolution change uses `resolveTopicCwd` which falls back to `projectPath` for legacy topics, so commands still target the project directory exactly as before. |
| 23 | STT/TTS endpoints (ELEVENLABS_API_KEY) | ✅ untouched | `routes/topics.ts:1168, 1193` not edited; env-loading in `server.ts` not touched. |
| 24 | Plan Mode parsing + approval | ✅ untouched | `PlanView.tsx` not edited; `messages.plan_status` column not migrated. |
| 25 | Mention-based agent routing | ✅ untouched | `server/mention-parser.ts`, the `mentions` table, and `agent_profiles.name` lookup not edited. |

---

## Cross-cutting verifications

- **`bun run check:any` clean** after every commit in the chain (7 files clean).
- **18/18 migrations applied in numeric order** on a fresh `/tmp` DB (verified in the integration test `schema migrations applied`).
- **No FK from `tasks.project_id` to `projects.id`** — string column kept as-is, board APIs untouched.
- **`assertUiStateMigrationApplied(db)`** still passes at server boot (mig 012 is the gate, untouched).
- **WS message union extended, not narrowed** — `WSProjectMessage` and `WSWorktreeMessage` are added to the union; existing handlers see no behaviour change (the catch-all `WSUnknownMessage` keeps forward-compat).

If any of these regress in a future change, search for the spec ID in `openspec/specs/` and reopen this walkthrough.
