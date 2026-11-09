# Claude Code hooks to jcode events (card ce3a398e)

jcode (v0.99) exposes six events: `session_start`, `session_end`, `turn_start`,
`turn_end`, `pre_tool`, `post_tool`. Env: `JCODE_HOOK_EVENT`, `JCODE_HOOK_SESSION_ID`,
`JCODE_HOOK_CWD`, `JCODE_HOOK_PAYLOAD` (JSON), tool name and input on `pre_tool`.
`[hooks]` in `~/.jcode/config.toml` already wires `pre_tool` to `offload-guard.sh`.

| Claude Code hook | What it does | jcode event | Loss |
|---|---|---|---|
| PreToolUse Bash: block-coauthor, offload-guard | blocks trailers, routes heavy work | `pre_tool` (exit non-zero blocks) | none. offload-guard is already wired. block-coauthor is not yet: add it |
| PreToolUse (no matcher): ai-memory | memory capture | `pre_tool` | none, but one `pre_tool` command only: needs a dispatcher script |
| SessionStart startup/resume: session-neighbours, jcode setup-hotkey | neighbour sessions, hotkey notice | `session_start` (has source field) | hotkey hook is moot under jcode |
| Stop: finish-time, notify.sh, POST :3335/api/session-stop, ai-memory | end-of-turn notices and Topics/hub signal | `turn_end` | none. Claude "Stop" = turn end, not session end |
| UserPromptSubmit: quota-reserve, POST :3335/api/session-start, memory-recall, ai-memory | quota reservation, recall injection | `turn_start` | PARTIAL: turn_start observes but cannot inject context into the prompt. memory-recall must become a tool or skill. quota-reserve cannot veto the prompt |
| PostToolUse Agent/Task/Workflow: delegate-guard | warns on bad delegation | `post_tool` (output is fed back as `[post_tool_feedback]`) | none, but jcode has no Agent/Task tool: matcher becomes the swarm/spawn tool names |
| PreCompact: ai-memory | snapshot before compaction | none | LOST. Workaround: snapshot on every `turn_end` |
| SessionEnd: ai-memory | final capture | `session_end` | none |
| SubagentStart / SubagentStop: ai-memory | subagent capture | none | LOST. Workaround: swarm members are sessions, so they fire their own `session_start`/`session_end` |

Other bridges (not hooks): jcode does not import Claude Code transcripts
(`~/.claude/projects/*.jsonl`), and about 70 files under jarvis scripts and usage-hub
read them or run `claude -p`. Topics already ships a jcode ACP provider
(`server/providers/acp/agents.ts`, `jcode acp`, one process for all sessions).
