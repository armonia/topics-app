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

// Registered with `async: true`, so Claude Code does not wait for them. The
// script only notifies the server: it always exits 0 and returns no decision,
// so the CLI has nothing to wait FOR, and a synchronous hook holds the turn
// until it returns. On a loaded Mac that is seconds per tool call: on 04/10, at
// load 50-150, the CLI cancelled the `PreToolUse` of this script after 10.9,
// 35.2, 37.4 and 6.1 s, each one a tool that waited for it; `/doctor` on 01/10
// counted 22 timeouts out of 22 runs of `UserPromptSubmit`. Measured on the CLI
// 2.1.289 (`claude -p`, two Bash calls, a hook that sleeps 3 s): 9.6 s with
// every event async against 27.7 s with every event sync.
//
// The two reasons the tool events used to be sync are covered elsewhere:
//   - their ORDER: async hooks race to the server, so the script stamps the
//     firing time and the tracker puts them back in order (`hook-order.ts`);
//   - the swap freezer learning that a Bash runs in the foreground BEFORE it
//     starts: a sync hook never guaranteed it (cancelled at the timeout, the
//     tool starts anyway and the server never hears of it), and a background
//     record no longer claims a process started after it
//     (`STALE_RECORD_SLACK_MS` in `agent-tool-children.ts`).
// `SessionStart` declared the transcript the tail follows from its first line;
// a new session is now followed from byte 0 whenever its hook arrives.
//
// `SessionEnd` stays synchronous: it fires as the CLI exits, and an async hook
// still running then is cut (measured on 2.1.289 with the 3 s hook: the async
// `Stop` SIGTERMed at the exit, and in the same run no `SessionEnd` at all).
// It fires once per process, after the last tool, so it holds nothing up. The
// real script takes tens of ms, so an async `Stop` is cut only when the CLI
// exits during its POST, which a chat or a pane kept open does not.
export const ASYNC_HOOK_EVENTS: ReadonlySet<string> = new Set(
  TOPICS_HOOK_EVENTS.filter((event) => event !== "SessionEnd"),
);

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
