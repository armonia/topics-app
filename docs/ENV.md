# Environment variables

Map of every environment variable Topics reads, produced by the **env-var audit**
(2026-07). It is the reference for which knobs stay in the environment and which
migrate to the in-app **Settings** store (Phase B).

Inventory command (re-run to refresh):

```bash
rg -oN 'process\.env\.([A-Z_][A-Z0-9_]+)' -r '$1' server server.ts scripts client \
  | sort | uniq -c | sort -rn
```

## Categories

| Category | Meaning | Fate |
|----------|---------|------|
| **secret** | Credentials / tokens | **Env only** — never persisted to DB or shown in UI |
| **bootstrap** | Paths, ports, host, data dirs needed before the app can read its own settings | Env only |
| **build** | Packaging / bundle-mode flags and binary paths set by the desktop shell | Env only |
| **test** | Per-process isolation for the test suite | Env only |
| **debug** | Escape hatches / diagnostics | Env only |
| **rollout** | Temporary feature flag | Env only (removed when the feature lands) |
| **toggle** | Behaviour defaults a user might reasonably change | **→ Settings** (Phase B); env stays a fallback |

Resolution for toggles after Phase B: **env → settings → built-in default**. Setting
the env still wins, so nothing changes until a user edits Settings in the UI.

---

## secret — env only (never in DB/UI)

| Var | Purpose | Set by |
|-----|---------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API key (claude provider) | user |
| `OPENAI_API_KEY` | OpenAI API key (openai provider) | user |
| `CODEX_API_KEY` | Codex API key (falls back to `OPENAI_API_KEY`) | user |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS key (enables voice) | user |
| `GATEWAY_TOKEN` | OpenClaw gateway token | user |
| `VAPID_SUBJECT` | Web-push VAPID subject | user/deploy |

## bootstrap — env only

| Var | Purpose | Set by |
|-----|---------|--------|
| `HOME` | User home dir | OS |
| `PATH` | Executable search path | OS |
| `SHELL` | Login shell for PTYs | OS |
| `NODE_ENV` | `production`/`test`/`development` mode switch | runtime |
| `PORT` / `BUN_PORT` | Local server port | user/shell |
| `SERVER_HOST` | Bind host | user/shell |
| `NO_TLS` | Disable TLS (plain HTTP) | user/shell |
| `GATEWAY_URL` | OpenClaw gateway URL | user |
| `DATA_DIR` / `TOPICS_DATA_DIR` / `APP_DATA_DIR` | App data root (conversations, DB) | user/shell |
| `TOPICS_HOME` | Topics home dir (state, backups, watchers) | shell |
| `OPENCLAW_DIR` / `SESSIONS_DIR` | Legacy data/session dirs | runtime |
| `TOPICS_WORKTREES_DIR` | Where git worktrees are created | shell |
| `TOPICS_EXTERNAL_STATES_DIR` / `JARVIS_STATES_DIR` | Browser login-state dirs (`JARVIS_STATES_DIR` is a back-compat alias) | shell |
| `XDG_DATA_HOME` | XDG data root (opencode session) | OS |
| `CODEX_HOME` | Codex config/home dir | user/shell |
| `WHISPER_MODEL_PATH` | Whisper model file for voice transcription | user/shell |

## build — env only (set by the desktop/Tauri shell)

| Var | Purpose | Set by |
|-----|---------|--------|
| `TOPICS_EMBEDDED` | "Self-contained bundle" mode (standalone) | Tauri shell |
| `TOPICS_DISABLE_PTY_BRIDGE` | Force-disable the PTY bridge | Tauri shell |
| `TOPICS_PTY_BRIDGE_BIN` | Path to the shipped Rust PTY-bridge sidecar | Tauri shell |
| `CLAUDE_BIN` / `TOPICS_CLAUDE_CLI_PATH` | Claude CLI binary path | shell/packaging |
| `CODEX_BIN` | Codex CLI binary path | shell/packaging |
| `CHROMIUM_PATH` | Bundled Chromium path | shell/packaging |

## test — env only (isolation)

| Var | Purpose | Set by |
|-----|---------|--------|
| `TOPICS_PTY_SOCKET` | Override PTY-bridge socket path | test |
| `TOPICS_AI_BRIDGE_SOCKET` | Override AI-bridge socket path | test |

## debug — env only (escape hatches)

| Var | Purpose | Set by |
|-----|---------|--------|
| `DEBUG_CLAUDE_CODE` | Verbose claude-code logging | dev |
| `FALLBACK_TO_JSON` | Seed/DB fallback to JSON store | dev |
| `TOPICS_ALLOW_WORKTREE_PROD` | Allow worktree flows in prod | dev |
| `BROWSER_ALLOW_ALL_SCHEMES` | Relax browser URL-scheme allowlist | dev |
| `TOPICS_SESSION_MCP_INHERIT_ALL` | Inherit all MCP servers into sessions | dev |

## rollout — env only (temporary)

| Var | Purpose | Set by |
|-----|---------|--------|
| `TOPICS_AI_BRIDGE` | Route the chat provider through the AI broker. **Temporary** — removed when the broker becomes default. Do **not** promote to Settings. | dev |

## toggle — migrate to Settings (Phase B), env stays fallback

| Var | Purpose | Default |
|-----|---------|---------|
| `AI_PROVIDER` | Default provider (`claude`/`openai`/`openclaw`/…) | auto-detected from keys |
| `CLAUDE_MODEL` | Claude model id (claude **and** claude-code providers) | provider default |
| `CLAUDE_MAX_TOKENS` | Claude max output tokens | provider default |
| `OPENAI_MODEL` | OpenAI model id | provider default |
| `OPENAI_MAX_TOKENS` | OpenAI max output tokens | provider default |
| `CODEX_MODEL` | Codex model id | provider default |
| `TOPICS_CLAUDE_EFFORT` | Default Claude effort tier | `xhigh` |
| `TOPICS_CODEX_REASONING_EFFORT` | Default Codex reasoning tier | `xhigh` (or user `config.toml`) |
| `CLAUDE_CODE_PERMISSION_MODE` | claude-code permission mode | provider default |
| `CODEX_APPROVAL_MODE` | Codex approval mode | provider default |
| `CLAUDE_CODE_ENABLED` | Force-enable claude-code provider | auto-detect CLI |
| `CLAUDE_CODE_WORKSPACE` / `CODEX_WORKSPACE` | Default workspace dir per provider | none (per-topic cwd) |

## Deprecated aliases (env audit, Phase A)

Kept working for one release; each warns once when it supplies a value. Prefer the
canonical name.

| Deprecated | Canonical | Notes |
|------------|-----------|-------|
| `CLAUDE_EFFORT` | `TOPICS_CLAUDE_EFFORT` | Old Warp shell-mirror |
| `CODEX_REASONING_EFFORT` | `TOPICS_CODEX_REASONING_EFFORT` | Old shell-mirror |
| `CLAUDE_CODE_MODEL` | `CLAUDE_MODEL` | Single Claude model id for both providers |

## Removed (env audit, Phase A)

| Removed | Reason |
|---------|--------|
| `TOPICS_NODE_BIN` | Legacy bundled-Node PTY bridge; every shipped bundle uses the Rust sidecar (`TOPICS_PTY_BRIDGE_BIN`). |
| `TOPICS_PTY_BRIDGE_PATH` | Same — legacy Node bridge path, superseded by the Rust sidecar. |
