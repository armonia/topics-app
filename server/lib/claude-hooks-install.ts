/**
 * Auto-install Topics App's Claude Code hook wrappers into the user's
 * ~/.claude/settings.json on server boot.
 *
 * WHY this exists: the phase machine (claude-session-state / -tracker) is the
 * ONLY reliable "Claude finished its turn" signal. Without the hooks feeding it,
 * a session never advances past `starting`, so the client falls back to a crude
 * 1.5s-of-pty-silence heuristic that fires on every mid-turn lull — the "random
 * notification" bug. The server already mints the hook auth token on first boot
 * (routes/claude-hooks.ts → getOrCreateHookToken); installing the matching hook
 * entries here completes that flow so notifications are accurate out of the box.
 *
 * This mirrors the manual CLI (scripts/install-claude-hooks.ts) but is hardened
 * for an always-on server: it NEVER throws, NEVER calls process.exit, refuses to
 * touch an unparseable settings file, and only writes when something actually
 * changed (no file churn on every boot). It is idempotent and non-destructive —
 * user-defined hooks for the same event are preserved (we append, marked with
 * `topics_app: true` so the uninstaller can remove only our entries).
 *
 * Keep the wrapper script + event list in sync with
 * scripts/install-claude-hooks.ts and scripts/claude-hooks/post-hook.sh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const HOOKS_DEST_DIR = join(CLAUDE_DIR, "topics-hooks");
const WRAPPER_NAME = "post-hook.sh";
const WRAPPER_DEST = join(HOOKS_DEST_DIR, WRAPPER_NAME);

// Minimal load-bearing set for the phase machine (matches the manual installer):
// SessionStart/SessionEnd/UserPromptSubmit/Notification/Stop. PreToolUse/
// PostToolUse/SubagentStop are deliberately omitted (high-frequency or no-op).
const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Notification",
  "Stop",
] as const;

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
  topics_app?: boolean;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/** Candidate locations for the bundled wrapper, relative to the server root
 *  (import.meta.dir of server.ts). Dev keeps it under scripts/; the packaged
 *  build stages it next to the server (see scripts/stage-server-dist.mjs). */
function wrapperSourceCandidates(serverRoot: string): string[] {
  return [
    join(serverRoot, "scripts", "claude-hooks", WRAPPER_NAME), // dev (repo root)
    join(serverRoot, "claude-hooks", WRAPPER_NAME),            // packaged (Resources/server)
  ];
}

function buildEntry(event: string): HookEntry {
  // Quote the path: Claude Code runs command hooks via `/bin/sh -c`, which would
  // word-split an unquoted path containing a space (a home dir with a space).
  // The trailing ` ${event}` is unchanged, so hasOurEntry()/the uninstaller still
  // match. Keep in sync with scripts/install-claude-hooks.ts.
  return { type: "command", command: `"${WRAPPER_DEST}" ${event}`, timeout: 5, topics_app: true };
}

function hasOurEntry(matcher: HookMatcher, event: string): boolean {
  return matcher.hooks.some((h) => h.topics_app === true && h.command?.endsWith(` ${event}`));
}

/**
 * Ensure the wrapper script is installed and the settings.json hook entries
 * exist. Best-effort and non-fatal: any failure is logged and swallowed so the
 * server boots regardless. Returns a small result for logging/tests.
 */
export function ensureClaudeHooksInstalled(serverRoot: string): {
  ok: boolean;
  reason?: string;
  added?: number;
} {
  // Skip on test / E2E instances so a test run never mutates the developer's
  // real global ~/.claude config — but ONLY on signals the packaged app never
  // sets. CRUCIAL: do NOT gate on DATA_DIR / TOPICS_DATA_DIR — the packaged
  // Electron app sets BOTH for every shipped build (electron-app/main.ts spawns
  // the bundled server with TOPICS_DATA_DIR + DATA_DIR to route mutable state
  // out of the read-only .app bundle). Gating on them would silently disable
  // this installer in production — the exact env that needs it most. Use instead:
  //   - TOPICS_NO_HOOK_INSTALL=1 : explicit opt-out (also set by the E2E harness),
  //   - NODE_ENV=test            : `bun test` sets it; packaged sets 'production',
  //   - TOPICS_PTY_SOCKET        : set ONLY by the E2E harness, never by the app.
  if (process.env.TOPICS_NO_HOOK_INSTALL === "1") return { ok: false, reason: "opted-out" };
  if (process.env.NODE_ENV === "test" || process.env.TOPICS_PTY_SOCKET) {
    return { ok: false, reason: "isolated-instance" };
  }

  try {
    // 1. Install/refresh the wrapper from whichever bundled copy exists.
    const src = wrapperSourceCandidates(serverRoot).find((p) => existsSync(p));
    if (!src) {
      console.error("[claude-hooks] wrapper script not found; skipping auto-install:", wrapperSourceCandidates(serverRoot));
      return { ok: false, reason: "wrapper-missing" };
    }
    mkdirSync(HOOKS_DEST_DIR, { recursive: true });
    // Copy only when missing or changed, to avoid needless writes each boot.
    let needCopy = true;
    try {
      if (existsSync(WRAPPER_DEST) && readFileSync(WRAPPER_DEST, "utf-8") === readFileSync(src, "utf-8")) {
        needCopy = false;
      }
    } catch { /* fall through to copy */ }
    if (needCopy) {
      copyFileSync(src, WRAPPER_DEST);
      chmodSync(WRAPPER_DEST, 0o755);
    }

    // 2. Read settings — refuse to overwrite an unparseable file.
    let settings: ClaudeSettings = {};
    if (existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as ClaudeSettings;
      } catch {
        console.error("[claude-hooks] ~/.claude/settings.json is unparseable; leaving it untouched.");
        return { ok: false, reason: "settings-unparseable" };
      }
    }
    settings.hooks = settings.hooks ?? {};

    // 3. Append our entry to each event's first wildcard matcher (idempotent).
    let added = 0;
    for (const event of HOOK_EVENTS) {
      const matchers = settings.hooks[event] ?? [];
      let target = matchers.find((m) => !m.matcher || m.matcher === "*");
      if (!target) {
        target = { hooks: [] };
        matchers.push(target);
      }
      if (!hasOurEntry(target, event)) {
        target.hooks.push(buildEntry(event));
        added += 1;
      }
      settings.hooks[event] = matchers;
    }

    // 4. Only write when we actually added entries (no churn on warm boots).
    if (added > 0) {
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      console.log(`[claude-hooks] installed ${added} hook entr${added === 1 ? "y" : "ies"} into ${SETTINGS_PATH}`);
    }
    return { ok: true, added };
  } catch (err) {
    console.error("[claude-hooks] auto-install failed (non-fatal):", err);
    return { ok: false, reason: "error" };
  }
}
