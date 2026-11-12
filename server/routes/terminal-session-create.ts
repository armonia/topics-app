import { launchArgs } from "../lib/subagent-launch";
import type { TerminalSessionType } from "../../shared/terminal-session-types";
import { basename } from "path";
import { getDatabase } from "../db";
import { homedir } from "os";
import { isAgentWorkspace, lowerPriority } from "../lib/low-priority";
import { augmentPath, realHome } from "../utils/path-env";
import { resolveCodexBin } from "../lib/codex-bin";
import { resolveClaudeBin } from "../lib/claude-bin";
import { topicsHooksSettings } from "../lib/topics-hooks";
import { hookScriptPath } from "../lib/topics-hook-script";
import { resolveKimiBin } from "../lib/kimi-bin";
import { resolveMuseBin } from "../lib/muse-bin";
import { discoverCodexSessionId, codexRolloutExists, codexRolloutPath } from "../lib/codex-session";
import { deriveCodexSessionTitle } from "../lib/codex-transcript-title";
import { discoverOpencodeSessionId, deriveOpencodeSessionTitle } from "../lib/opencode-session";
import { writeMcpConfigForSession } from "../providers/claude-code";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { restoreSweptTranscript } from "../lib/transcript-keeper";
import { getSubagent, setSubagentState } from "../lib/subagent-store";
import { deriveClaudeSessionTitle } from "../lib/claude-transcript-title";
import { topicsAgentSystemPrompt, resolveClaudeEffort, resolveCodexReasoningEffort, topicEffortFor } from "../lib/topics-agent-prompt";
import { type SubagentLaunchFlags, type TerminalSession, sessionSockets, sessions } from "./terminal-state";
import { pendingCreates, sendToBridge } from "./terminal-bridge-messages";
import { _tracker, broadcastTerminalSessions } from "./terminal-registry";

// --- Session management ---
export async function createSession(id: string, name: string, cwd: string, command?: string, cols = 120, rows = 30, topicId?: string, sessionType: TerminalSessionType = 'shell', skipPermissions = true, claudeSessionId?: string, parentSessionKey?: string, nameSource: 'default' | 'auto' | 'user' = 'default', launch?: SubagentLaunchFlags | null): Promise<TerminalSession> {
  let file: string;
  let args: string[];
  const isClaudeKind = sessionType === 'claude-code' || sessionType === 'claude-code-team';
  // A sub-agent keeps the model, profile and effort it was spawned with across
  // every relaunch (Reload, revive from its pane, the restart's recreate, a
  // resume from `send_to_agent`): they are read back from its row.
  const subagentRow = parentSessionKey && isClaudeKind ? getSubagent(getDatabase(), id) : null;
  if (launch === undefined && subagentRow) {
    launch = { model: subagentRow.model, agent: subagentRow.agentType, effort: subagentRow.effort };
  }

  let resolvedClaudeSessionId = claudeSessionId;
  if (isClaudeKind && !resolvedClaudeSessionId) {
    resolvedClaudeSessionId = crypto.randomUUID();
  }

  if (isClaudeKind) {
    // Absolute path where possible: the server runs under launchd (and, on a
    // fresh install, the Tauri sidecar's bundled Node) with a bare PATH that
    // excludes ~/.local/bin, Homebrew, etc. A plain `claude` then ENOENTs and the
    // pane exits instantly (blank tab). Falls back to the bare name so a
    // full-PATH dev shell still works, and so a machine without claude installed
    // surfaces a clear "command not found" rather than nothing. Mirrors codex.
    file = resolveClaudeBin() ?? 'claude';
    // No `--disallowed-tools Agent,Workflow` here, unlike a chat or a card
    // (`NATIVE_DELEGATION_TOOLS`): in its TUI the person drives the CLI and sees its sub-agents.
    // Hence `topicsAgentSystemPrompt()` without `headless`: no spawn_agent nudge.
    args = [];
    if (claudeSessionId) {
      // The CLI's 30-day cleanup may have taken the transcript of a long-parked
      // tab: put the kept one back, or `--resume` ends the pane at once.
      restoreSweptTranscript(getDatabase(), cwd, claudeSessionId, `tab ${id}`);
      args.push('--resume', claudeSessionId);
    } else if (resolvedClaudeSessionId) {
      args.push('--session-id', resolvedClaudeSessionId);
    }
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    // Nudge the agent to launch servers via the Topics MCP (run_script) so they
    // show up in the Processes panel instead of leaking into the bare shell.
    // --append-system-prompt works in interactive mode and is additive to the
    // project's own CLAUDE.md.
    args.push('--append-system-prompt', topicsAgentSystemPrompt());
    // Topics' hooks (phase, current tool, end of turn) travel with the spawn,
    // not from the user's `~/.claude/settings.json`: they fire in this pane and
    // not in the Claude the user starts outside Topics. Same definition as the
    // chat engine (`lib/topics-hooks.ts`). The only `--settings` of this argv:
    // the CLI would keep just the last one.
    args.push('--settings', JSON.stringify(topicsHooksSettings(hookScriptPath())));
    // Start the interactive session at the same effort tier a Warp shell would
    // ("ultracode" = xhigh). The server runs under launchd with no CLAUDE_EFFORT
    // in its env, and the user's global effortLevel defaults to low, so without
    // an explicit flag every Topics PTY would start at low effort. Tunable via
    // TOPICS_CLAUDE_EFFORT (set "off" to defer to the CLI's own settings).
    // L'override per-topic (migration 033, il selettore nel model picker) vince
    // su ogni default — ma solo se glielo si passa: `resolveClaudeEffort()` senza
    // argomento salta il primo ramo della sua catena, e questo percorso lo
    // chiamava così. Il risultato è che il selettore era MORTO sul terminale
    // interattivo: un topic messo a "medium" apriva comunque un PTY a xhigh, e
    // sul percorso chat (claude-code.ts, che l'override lo passa) lo stesso topic
    // si comportava diversamente. Due superfici, due effort, un solo selettore.
    if (launch) {
      // A sub-agent's effort was resolved at spawn (call, profile, parent topic):
      // `launchArgs` carries it with the model and the profile.
      args.push(...launchArgs(launch));
    } else {
      const claudeEffort = resolveClaudeEffort(topicEffortFor(getDatabase(), topicId));
      if (claudeEffort) args.push('--effort', claudeEffort);
    }
    // Bridge the Topics MCP server into the interactive CLI so a terminal
    // Claude Code can surface a browser pane next to itself (the chat path
    // does the same in providers/claude-code.ts). We key the config by the
    // terminal session id — the MCP tool POSTs to
    // /api/sessions/<id>/browser/open-pane, which the endpoint resolves to
    // THIS terminal (not a chat topic) and opens the browser in the same
    // group as the terminal pane, for both standalone and project layouts.
    // The generated config carries the `topics` bridge plus a curated set of
    // the user's global MCP servers; when scoped we add `--strict-mcp-config`
    // so the CLI uses ONLY that set (otherwise it stays additive and nothing
    // the user had is lost). Policy lives in writeMcpConfigForSession and is
    // env-tunable (TOPICS_SESSION_MCP_ALLOW/DENY/INHERIT_ALL). Cleaned up in
    // the `exit` handler below.
    try {
      const { path: mcpPath, strict } = writeMcpConfigForSession(id);
      args.push('--mcp-config', mcpPath);
      if (strict) args.push('--strict-mcp-config');
    } catch (err) {
      // Non-fatal: a missing bridge just means no open_browser_pane tool.
      console.warn(`[Terminal] MCP config write failed for ${id}:`, err);
    }
  } else if (sessionType === 'codex') {
    // Codex (OpenAI CLI) — spawned the same interactive-PTY way as `claude`,
    // with none of the Claude-specific plumbing (no session-id/--resume, no
    // MCP bridge config, no tracker registration, no skip-permissions flag).
    // Codex sessions carry no claude_session_id, so the dormant sweep treats
    // them like shells (no resumable pointer we track).
    //
    // Resolve the ABSOLUTE path: Codex ships inside Codex.app (not on PATH),
    // and under launchd the server's PATH excludes both Homebrew and the app
    // bundle — a bare `codex` ENOENTs silently, leaving a blank pane. The
    // shared resolver (used by the chat provider too) finds the bundle binary.
    file = resolveCodexBin() ?? 'codex';
    // RESUME the prior conversation when we captured a rollout id for this row
    // AND codex's rollout file still exists on disk (the codex analogue of the
    // claude `--resume` + transcript-exists guard). `claudeSessionId` here is
    // the generic resumable-pointer slot — NOT a claude id; for codex it holds
    // the UUID codex minted for its ~/.codex/sessions rollout, captured
    // post-spawn by scheduleCodexIdCapture (see lib/codex-session.ts). Codex
    // mints its own id, so we never pass --session-id; on a fresh launch
    // claudeSessionId is undefined and we start clean, then capture the id.
    if (claudeSessionId && codexRolloutExists(claudeSessionId)) {
      args = ['resume', claudeSessionId];
    } else {
      args = [];
    }
    // Same explicit reasoning-effort override the chat path passes (see
    // providers/codex.ts): deterministic tier under launchd, and the user's
    // own config.toml value wins over our default. `-c` is a global codex
    // flag, valid after `resume` too.
    const codexEffort = resolveCodexReasoningEffort();
    if (codexEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(codexEffort)}`);
  } else if (sessionType === 'opencode') {
    // opencode (open-source agent CLI) pinned to the free Cerebras provider
    // (GLM-4.7 — quasi-Opus, no-train). Two things it needs that the launchd
    // server's bare env lacks: CEREBRAS_API_KEY (the user keeps it in ~/.zshrc)
    // and Homebrew on PATH (opencode lives in /opt/homebrew/bin). So we launch
    // it inside a login+interactive shell that sources the user's profile —
    // exactly what happens when they type `opencode` in their own terminal —
    // and `exec` hands the PTY straight to opencode. No session tracking, no
    // MCP bridge: like codex/shell, opencode carries no claude_session_id.
    // Default to gemma-4-31b (instruct, NOT a reasoning model). The Cerebras
    // reasoning models on this account (zai-glm-4.7, gpt-oss-120b) make opencode
    // replay an unsupported `reasoning_content` field and 400 on the 2nd turn —
    // reproduced even on opencode 1.17.17 + @ai-sdk/cerebras. Gemma emits no
    // reasoning trace, so multi-turn is bug-proof (verified). Weaker than GLM,
    // but reliable; switch to zai-glm-4.7 manually inside opencode when the
    // upstream reasoning-replay fix lands. Model catalog is account-specific
    // (GET /v1/models): only gemma-4-31b / gpt-oss-120b / zai-glm-4.7 here.
    file = process.env.SHELL || '/bin/zsh';
    args = ['-lic', 'exec opencode -m cerebras/gemma-4-31b'];
  } else if (sessionType === 'kimi-code') {
    // Kimi Code (Moonshot AI's CLI) — spawned the same interactive-PTY way as
    // codex: no session-id/--resume, no MCP bridge config, no tracker
    // registration. It carries no claude_session_id, so the dormant sweep and
    // `decideOnRestart` treat it like shell/codex (see terminal-restart-policy.ts).
    //
    // Resolve the ABSOLUTE path: the installer drops the binary at
    // ~/.kimi-code/bin/kimi and does not reliably reach the bare PATH a
    // launchd-spawned server inherits (see lib/kimi-bin.ts).
    file = resolveKimiBin() ?? 'kimi';
    args = [];
  } else if (sessionType === 'muse') {
    // Muse (Meta's CLI) — spawned the same interactive-PTY way as
    // codex/kimi: no session-id/--resume, no MCP bridge config, no tracker
    // registration. It carries no claude_session_id, so the dormant sweep and
    // `decideOnRestart` treat it like shell/codex (see terminal-restart-policy.ts).
    //
    // Resolve the ABSOLUTE path: the launcher lives in ~/.local/bin, which the
    // bare PATH of a launchd-spawned server does not include (see
    // lib/muse-bin.ts). The shared resolver is the same one the chat provider
    // uses, so the two never disagree on where muse lives.
    file = resolveMuseBin() ?? 'muse';
    args = [];
  } else if (command) {
    const parts = command.split(" ");
    file = parts[0];
    args = parts.slice(1);
  } else if (process.platform === 'win32') {
    // The default shell on Windows. `/bin/zsh` does not exist there, and without
    // this the "shell" tab asked to launch a nonexistent file: the bridge answered
    // with a spawn error and the tab died the moment it opened.
    //
    // PowerShell rather than `cmd.exe`: it is the interactive shell a Windows user
    // expects, and `-NoLogo` drops the copyright banner that would otherwise eat the
    // first lines of every terminal. `TOPICS_SHELL` overrides it.
    file = process.env.TOPICS_SHELL || 'powershell.exe';
    args = ['-NoLogo'];
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = ["-l"];
  }

  let env: Record<string, string | null> | undefined;
  if (isClaudeKind) {
    // Pin HOME to the user's REAL home. The pty-bridge inherits whatever HOME the
    // server (or a sandbox ancestor) was launched with; if that's a throwaway dir
    // (e.g. /tmp/tcs-h-XXXX) every `claude` would read an empty ~/.claude.json
    // there and re-onboard, losing the user's account/settings/MCP/history.
    // realHome() is $HOME-independent, so this anchors claude to the real config.
    env = { CLAUDECODE: null, PATH: augmentPath(), HOME: realHome() };
    // Master Topic mode: enable Claude Code Agent Teams (experimental).
    // Sub-safe pattern — `claude` runs interactive in PTY, lead delegates
    // to teammates via shared task list (see spec MASTER-01).
    if (sessionType === 'claude-code-team') {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
  } else if (sessionType === 'codex') {
    // Same PATH augmentation as claude: under launchd the server has a
    // minimal PATH (no Homebrew), so a bare `codex` would ENOENT silently.
    // HOME pinned to the real home for the same reason as claude — codex reads
    // its auth/config from ~/.codex and would lose it under a sandbox HOME.
    env = { PATH: augmentPath(), HOME: realHome() };
  } else if (sessionType === 'opencode') {
    // HOME → real home so the login shell reads the user's ~/.zshrc (where
    // CEREBRAS_API_KEY + Homebrew PATH live) and opencode finds its config at
    // ~/.config/opencode. PATH augmented as a belt-and-suspenders fallback.
    env = { PATH: augmentPath(), HOME: realHome() };
  } else if (sessionType === 'kimi-code') {
    // Same reasoning as codex: PATH augmented for a launchd-minimal env, HOME
    // pinned to the real home so kimi reads its own auth/config, not a sandbox one.
    env = { PATH: augmentPath(), HOME: realHome() };
  } else if (sessionType === 'muse') {
    // Same reasoning as codex/kimi: PATH augmented for a launchd-minimal env,
    // HOME pinned to the real home so muse reads its own auth/config
    // (~/.local/share/muse), not a sandbox one.
    env = { PATH: augmentPath(), HOME: realHome() };
  }

  // IS THE CLI ACTUALLY THERE? If not, say so HERE.
  //
  // The branches above fall back to the bare name (`?? 'claude'`) counting on a
  // "command not found" the user reads in the terminal. On macOS that line does
  // arrive, because the shell prints it. On Windows it does not: the process
  // never starts, the PTY hits EOF the instant it opens, and the user sees a tab
  // that appears and stays empty — exactly the reported defect ("it opens Claude
  // Code as a tab, but nothing actually opens", 2026-08-26).
  //
  // A missing agent is not a fault: it is the normal state of a fresh machine,
  // and it deserves to be named along with how to install it. The check is on the
  // RESOLVED path, not on a spawn attempt: if the resolver found nothing and the
  // branch fell back to the bare name, `Bun.which` is the last word before
  // actually trying.
  if (sessionType !== 'shell' && !command) {
    const bare = !file.includes('/') && !file.includes('\\');
    if (bare && !Bun.which(file)) {
      const howToInstall: Record<string, string> = {
        'claude': 'https://claude.com/product/claude-code',
        'codex': 'npm i -g @openai/codex',
        'opencode': 'npm i -g opencode-ai',
        'kimi': 'curl https://code.kimi.com/kimi-code/install.sh | bash',
        'muse': 'curl -fsSL https://dev.meta.ai/install.sh | bash',
      };
      const base = file.replace(/\.(exe|cmd|bat)$/i, '');
      const hint = howToInstall[base];
      throw new Error(
        `"${base}" is not installed on this machine` +
        (hint ? `. Install it with: ${hint}` : '') +
        `. Topics runs the CLI you already have; it does not bundle it.`,
      );
    }
  }

  // Await the bridge's ack before populating in-memory + DB. If the
  // bridge can't actually spawn (broken native addon, missing
  // binary, lost session context), throw — the API handler returns
  // 502 and the user sees a real error instead of an empty xterm
  // pane that silently never produces output.
  const ackPromise = pendingCreates.wait(id);
  let ptyPid: number | undefined;
  // Stamp the spawn instant so the codex rollout-id discovery (below) only
  // considers a rollout written at/after this launch, not a stale one.
  const spawnTimeMs = Date.now();
  try {
    sendToBridge({ type: "create", id, shell: file, args, cwd, cols, rows, ...(env ? { env } : {}) });
    ptyPid = await ackPromise; // bridge resolves the create-ack with the PTY pid
  } catch (err) {
    // `sendToBridge` throws synchronously when the socket is gone, so this
    // catch can run with the wait still counting down and nobody left to hear
    // its verdict. Cancel it: the register already makes the late rejection
    // harmless, this stops it from happening at all.
    pendingCreates.cancel(id);
    throw err;
  }

  // An agent's PTY is demoted at birth (nice 15, `utility` QoS on macOS), and
  // everything the CLI forks from it inherits the demotion: the fleet yields
  // to the owner's own windows. The owner's shells keep their priority. See
  // server/lib/low-priority.ts.
  if (ptyPid && isAgentWorkspace(cwd, parentSessionKey, homedir())) lowerPriority(ptyPid);

  // A plain shell born with the generic add-menu label ("Shell") or "Terminal N"
  // gets a more useful default: the working directory's basename (e.g. the repo
  // name). Kept name_source='default' so a later user rename (PATCH → 'user')
  // still wins, and claude/codex are untouched (they auto-name from their
  // transcript/rollout). Only when the caller didn't pass a user name.
  if (sessionType === 'shell' && nameSource === 'default') {
    const dirName = basename(cwd);
    if (dirName) name = dirName;
  }

  const session: TerminalSession = {
    id,
    name,
    nameSource,
    createdAt: new Date().toISOString(),
    cwd,
    command: sessionType === 'claude-code' ? 'claude' : (command || file),
    cols,
    rows,
    topicId,
    type: sessionType,
    skipPermissions,
    claudeSessionId: resolvedClaudeSessionId,
    ptyPid,
    parentSessionKey,
  };

  sessions.set(id, session);
  sessionSockets.set(id, new Set());
  // A child relaunched under its id is running again, whoever relaunched it.
  if (subagentRow && subagentRow.state !== 'running') setSubagentState(getDatabase(), id, 'running');

  try {
    getDatabase().run(
      `INSERT OR REPLACE INTO terminal_sessions (id, name, name_source, cwd, command, type, topic_id, cols, rows, skip_permissions, created_at, claude_session_id, parent_session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, nameSource, cwd, session.command, sessionType, topicId || null, cols, rows, skipPermissions ? 1 : 0, session.createdAt, resolvedClaudeSessionId || null, parentSessionKey || null]
    );
  } catch (err) {
    // NEVER swallow silently: a failed persist means the session won't survive a
    // server/bridge restart (reconcileSessions has no DB row to reattach or
    // revive). A swallowed CHECK-constraint violation on `type` is exactly how
    // codex/claude-code-team panes vanished on restart before migration 029
    // widened the constraint — log loudly so the next such mismatch is obvious.
    console.error(`[Terminal] FAILED to persist session ${id} (type=${sessionType}) — it will NOT survive a restart:`, err);
  }

  // Register topic-less claude sessions with the tracker so their hooks resolve
  // and drive the authoritative phase signal. Topic-bound ones already have a
  // claude_code_sessions row owned by the chat provider — registerTerminalSession
  // is a no-op for those.
  if (isClaudeKind && resolvedClaudeSessionId) {
    _tracker?.registerTerminalSession(resolvedClaudeSessionId, { cwd });
  }

  // Codex mints its session UUID itself (no --session-id to pre-assign), so we
  // discover it from the rollout codex writes shortly after start and persist
  // it as the resumable pointer. Runs for BOTH a fresh launch and a resume:
  // resuming may append to the same rollout or spawn a child, and either way we
  // want the pointer to track the latest so the NEXT restart resumes current
  // state. Best-effort + async — failure just leaves the pane non-resumable.
  if (sessionType === 'codex') {
    scheduleCodexIdCapture(id, cwd, spawnTimeMs);
  }

  return session;
}

/**
 * After a codex PTY launches, poll ~/.codex/sessions for the rollout it just
 * wrote (matched by cwd + recency) and stash its UUID on the terminal_sessions
 * row's resumable-pointer slot (`claude_session_id`) + the in-memory session,
 * then rebroadcast so the roster carries it. Bounded, self-cancelling (stops if
 * the pane is closed), and `unref`'d so it never holds the process open.
 */
function scheduleCodexIdCapture(sessionId: string, cwd: string, sinceMs: number): void {
  let attempts = 0;
  const poll = () => {
    if (!sessions.has(sessionId)) return; // pane closed before we captured it
    const found = discoverCodexSessionId({ cwd, sinceMs });
    if (found) {
      const s = sessions.get(sessionId);
      if (s && s.claudeSessionId !== found) {
        s.claudeSessionId = found;
        try {
          getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [found, sessionId]);
        } catch (e) {
          console.warn(`[Terminal] codex session-id persist failed for ${sessionId}:`, e);
        }
        broadcastTerminalSessions();
        // The rollout now exists (its first user_message is written), so give
        // the tab a real label immediately instead of waiting for the first
        // idle transition. Best-effort — no-ops if nothing usable yet.
        autoNameCodexSession(found);
      }
      return;
    }
    if (++attempts < 12) {
      const t = setTimeout(poll, 1000);
      t.unref?.();
    }
  };
  const t = setTimeout(poll, 800);
  t.unref?.();
}

/**
 * Auto-label a Claude Code terminal tab from its session topic, unless the user
 * has manually renamed it. Called on each Stop / UserPromptSubmit hook so the
 * tab tracks the topic as it evolves; no-ops when the derived title is unchanged
 * or the name is user-owned. Best-effort — never throws into the hook path.
 * Updates the in-memory session + the persisted row, then re-broadcasts the
 * roster so every client relabels live.
 */
export function autoNameClaudeSession(claudeSessionId: string, transcriptPath?: string): void {
  if (!claudeSessionId) return;
  let target: TerminalSession | undefined;
  for (const s of sessions.values()) {
    if (s.claudeSessionId === claudeSessionId &&
        (s.type === "claude-code" || s.type === "claude-code-team")) { target = s; break; }
  }
  if (!target || target.nameSource === "user") return; // a manual rename wins

  const file = (transcriptPath && transcriptPath.trim())
    ? transcriptPath
    : claudeTranscriptPath(target.cwd, claudeSessionId);
  const title = deriveClaudeSessionTitle(file);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/**
 * Safety-net sweep: re-derive the auto-name for EVERY live Claude session, not
 * just the one whose hook fired. `autoNameClaudeSession` is normally driven by
 * the UserPromptSubmit/Stop hooks (claude-hooks), but a session whose hooks never
 * reach the server — started outside the app flow, or a `claude_session_id` that
 * drifted after a `--resume` — keeps the generic "Claude Code" label forever even
 * though its transcript already carries a perfectly good title. This closes that
 * gap. Cheap and idempotent: autoNameClaudeSession no-ops when the name is
 * user-owned, unchanged, or underivable (missing transcript), and transcript
 * reads are incremental via the scan cache. Best-effort — never throws.
 */
export function sweepAutoNameClaudeSessions(): void {
  for (const s of sessions.values()) {
    if ((s.type === "claude-code" || s.type === "claude-code-team") &&
        s.nameSource !== "user" && s.claudeSessionId) {
      try { autoNameClaudeSession(s.claudeSessionId); } catch { /* best-effort */ }
    }
  }
}

// Kick a first sweep once the boot reconcile has populated the session map, then
// keep a low-frequency net running so a session that never gets a hook still
// picks up its title within a minute. Unref'd — never holds the process open.
const AUTO_NAME_SWEEP_MS = 45_000;
setTimeout(() => {
  try { sweepAutoNameClaudeSessions(); } catch { /* best-effort */ }
  try { sweepAutoNameOpencodeSessions(); } catch { /* best-effort */ }
}, 8_000).unref?.();
setInterval(() => {
  try { sweepAutoNameClaudeSessions(); } catch { /* best-effort */ }
  try { sweepAutoNameOpencodeSessions(); } catch { /* best-effort */ }
}, AUTO_NAME_SWEEP_MS).unref?.();

/**
 * Auto-label a Codex terminal tab from its rollout's user prompts (Codex has no
 * `ai-title` event, so the label tracks the user's own text — see
 * codex-transcript-title.ts). The Codex analogue of autoNameClaudeSession:
 * no-ops until the rollout id has been captured (scheduleCodexIdCapture can lag
 * a few seconds), when the derived title is unchanged, or once the user has
 * renamed the tab (name_source='user'). Best-effort — never throws into the
 * caller (the id-capture success branch or the per-turn idle transition).
 * `codexRolloutId` is the UUID stored on the session's resumable-pointer slot
 * (`claudeSessionId`).
 */
export function autoNameCodexSession(codexRolloutId: string): void {
  if (!codexRolloutId) return;
  let target: TerminalSession | undefined;
  for (const s of sessions.values()) {
    if (s.claudeSessionId === codexRolloutId && s.type === "codex") { target = s; break; }
  }
  if (!target || target.nameSource === "user") return; // a manual rename wins

  const path = codexRolloutPath(codexRolloutId);
  if (!path) return; // rollout not written/discovered yet
  const title = deriveCodexSessionTitle(path);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] codex auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/**
 * Auto-label an opencode terminal tab from the AI title opencode itself wrote
 * into its SQLite `session` row. Unlike claude (hooks) and codex (rollout id
 * captured post-spawn), opencode's session id + title only exist AFTER the first
 * user prompt, so this takes the TERMINAL session id and lazily discovers the
 * opencode `ses_…` id (by cwd + recency) the first time it can, stashing it on
 * the resumable-pointer slot (`claudeSessionId`) for O(1) lookups thereafter.
 * Driven by the busy→idle turn boundary (opencode has no hooks) + the sweep.
 * No-ops until a real (non-placeholder) title exists, when unchanged, or once the
 * user renamed the tab. Best-effort — never throws into the caller.
 */
export function autoNameOpencodeSession(terminalSessionId: string): void {
  const target = sessions.get(terminalSessionId);
  if (!target || target.type !== "opencode" || target.nameSource === "user") return;

  let ocId = target.claudeSessionId;
  if (!ocId) {
    const sinceMs = Date.parse(target.createdAt) || 0;
    ocId = discoverOpencodeSessionId({ cwd: target.cwd, sinceMs }) ?? undefined;
    if (!ocId) return; // opencode hasn't minted a session row yet (no prompt sent)
    target.claudeSessionId = ocId;
    try {
      getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [ocId, target.id]);
    } catch (e) {
      console.warn(`[Terminal] opencode session-id persist failed for ${target.id}:`, e);
    }
  }

  const title = deriveOpencodeSessionTitle(ocId);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] opencode auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/** Safety-net sweep for opencode tabs (analogue of sweepAutoNameClaudeSessions):
 *  opencode's AI title can land a few seconds AFTER the busy→idle that triggered
 *  the first attempt, so a low-frequency re-check catches it. Idempotent. */
export function sweepAutoNameOpencodeSessions(): void {
  for (const s of sessions.values()) {
    if (s.type === "opencode" && s.nameSource !== "user") {
      try { autoNameOpencodeSession(s.id); } catch { /* best-effort */ }
    }
  }
}

