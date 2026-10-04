/**
 * The Claude Code hooks Topics registers, defined ONCE.
 *
 * Two places hand them to the CLI: every spawn Topics makes (the headless chat
 * and board engine in `providers/claude/args.ts`, the `claude` terminal panes in
 * `routes/terminal.ts`), through `--settings`; and the opt-in installer
 * (`scripts/install-claude-hooks.ts`), which writes them into the user's GLOBAL
 * `~/.claude/settings.json` for whoever wants every session of the machine
 * tracked. Same events, same matcher, same `async`, same timeout: two copies
 * would drift apart the first time one of them is touched.
 *
 * Pure: no disk, no environment. The script path comes in as a parameter (see
 * `topics-hook-script.ts` for where it lives).
 */

// The load-bearing set for the phase machine + the live "what it's doing" feed.
// PreToolUse/PostToolUse ARE registered: they are the highest-frequency events
// (one POST per tool call), but they carry `tool_name`, which the app SURFACES
// — the SessionActivity label shows the current tool ("Scrive codice",
// "Esegue un comando", …) on sidebar rows and the mobile status strip. Without
// them a working session only reads as a generic spinner; with them the user can
// see WHAT it's doing. `starting`→`tool-running` also advances near-instantly,
// which kills the "false finished badge while pinned at starting" residual.
// SubagentStop is still dropped (a no-op in applyHook — returns state unchanged).
export const TOPICS_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
] as const;

// Events the installer used to register and no longer does. `MonitorArmed` and
// `MonitorClosed` are not emitted by Claude Code (absent from the event list of
// 2.1.237 and 2.1.289), and 2.1.289 drops each unknown event key from
// settings.json with a "Settings Warning". The server keeps accepting them for
// an older CLI; the live watch signal is the `PreToolUse` of `Monitor`
// (`server/lib/claude-session-state.ts`). Install removes our stale entries for
// these events and uninstall cleans them up too.
export const RETIRED_HOOK_EVENTS = ["MonitorArmed", "MonitorClosed"] as const;

// Registered with `async: true`, so Claude Code does not wait for them. They
// only notify the server and their output is ignored, but a sync hook holds the
// turn until it returns: when the server is starved every prompt waited for the
// 5 s budget (`/doctor` on 01/10: UserPromptSubmit 22 timeouts out of 22 runs,
// Stop 13). The other four stay blocking on purpose:
//   - PreToolUse/PostToolUse: the swap freezer must learn that a Bash command
//     runs in the foreground BEFORE it starts (`noteBashToolCall`), and the
//     pair must reach the phase machine in order;
//   - SessionStart carries the transcript path the tail follows from the first
//     line, and SessionEnd fires as the CLI exits, when a background hook may
//     not get to run at all.
export const ASYNC_HOOK_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "Stop", "Notification"]);

/** Seconds the CLI gives one hook. The script's own worst case is 4 s (two 2 s POSTs). */
export const TOPICS_HOOK_TIMEOUT_S = 5;

export interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
  topics_app?: boolean;
  [key: string]: unknown;
}

export interface HookMatcher {
  matcher?: string;
  // Optional because a hand-written file can omit it (`{"matcher":"Bash"}`):
  // such a matcher is left exactly as it is.
  hooks?: HookEntry[];
}

export type HooksBlock = Record<string, HookMatcher[]>;

export function topicsHookCommand(scriptPath: string, event: string): string {
  // The path MUST be quoted. Claude Code runs command hooks via `/bin/sh -c`:
  // unquoted, a home containing a space is word-split and the hook never
  // starts — no error, just no signal, and the phase hangs at `starting`. The
  // event stays outside the quotes: it is our own constant, with no spaces.
  return `"${scriptPath}" ${event}`;
}

/**
 * One hook of ours. `topics_app: true` is the marker the installer uses to find
 * its own entries in a file it shares with the user; the CLI ignores the key
 * (measured on 2.1.289: the global file has carried it since the installer
 * existed, and a `--settings` with it runs the hooks).
 */
export function topicsHookEntry(scriptPath: string, event: string): HookEntry {
  return {
    type: "command",
    command: topicsHookCommand(scriptPath, event),
    timeout: TOPICS_HOOK_TIMEOUT_S,
    ...(ASYNC_HOOK_EVENTS.has(event) ? { async: true } : {}),
    topics_app: true,
  };
}

/**
 * The `hooks` block of a `--settings` object: every event, in a wildcard
 * matcher (no `matcher` = every tool, so `AskUserQuestion`, `ExitPlanMode` and
 * `Monitor` reach the server too).
 */
export function topicsHooksSettings(scriptPath: string): { hooks: HooksBlock } {
  const hooks: HooksBlock = {};
  for (const event of TOPICS_HOOK_EVENTS) hooks[event] = [{ hooks: [topicsHookEntry(scriptPath, event)] }];
  return { hooks };
}

/**
 * Two `hooks` blocks as one, the matchers of each event concatenated (`a`
 * first). The CLI takes ONE `--settings`, the last one, so a second lever that
 * brings hooks (the image guard on `PreToolUse`) has to share the object with
 * ours: a spread would keep one of the two `PreToolUse` lists and drop the
 * other in silence. Neither input is modified.
 */
export function mergeHooks(a: Readonly<HooksBlock> | undefined, b: Readonly<HooksBlock> | undefined): HooksBlock {
  const out: HooksBlock = {};
  for (const block of [a, b]) {
    if (!block) continue;
    for (const [event, matchers] of Object.entries(block)) out[event] = [...(out[event] ?? []), ...matchers];
  }
  return out;
}
