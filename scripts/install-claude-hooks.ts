#!/usr/bin/env bun
/**
 * Install Topics App's Claude Code hook wrappers into the user's
 * ~/.claude/settings.json.
 *
 * Behaviours:
 *   - Idempotent: re-running this script produces no diff.
 *   - Non-destructive: user-defined hooks for the same event are preserved
 *     (we append, never overwrite).
 *   - Localised marker: every entry we add carries `topics_app: true` in the
 *     hook object so the uninstaller can remove only our entries, under
 *     whatever event they sit. An entry
 *     written before the marker existed (same wrapper path, no marker, path
 *     quoted or not) is recognised too: install repairs it in place instead of
 *     appending a second Topics hook, and uninstall removes it.
 *   - Topics hooks fire on every tool: our entry lives in a wildcard matcher
 *     (no `matcher`, `""` or `"*"`). A copy found in a narrowed matcher is
 *     removed from it, and the other hooks of that matcher stay.
 *   - Only a matcher emptied by removing our entries is dropped; an empty
 *     matcher that was already empty belongs to someone else and stays.
 *   - Fire-and-forget events (`ASYNC_EVENTS`) are registered with
 *     `async: true`, so a slow server never holds the turn.
 *   - Token: relies on Topics App having generated the token on first boot
 *     at ${TOPICS_HOME:-~/.topics}/claude-hooks/hook-token (the wrapper also
 *     falls back to a legacy ~/.claude/topics-hook-token left by an older
 *     version). If the server has never been started, this script still
 *     writes the settings; the wrapper will no-op silently until the token
 *     exists.
 *   - This script is the ONE place Topics writes under ~/.claude, and only
 *     because the user runs it by hand (`bun run hooks:install`): the server
 *     itself never touches that directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const HOOKS_DEST_DIR = join(CLAUDE_DIR, "topics-hooks");
const WRAPPER_NAME = "post-hook.sh";
const WRAPPER_SRC = join(__dirname, "claude-hooks", WRAPPER_NAME);
const WRAPPER_DEST = join(HOOKS_DEST_DIR, WRAPPER_NAME);

// The load-bearing set for the phase machine + the live "what it's doing" feed.
// PreToolUse/PostToolUse ARE now registered: they are the highest-frequency
// events (one POST per tool call), but they carry `tool_name`, which the app now
// SURFACES — the SessionActivity label shows the current tool ("Scrive codice",
// "Esegue un comando", …) on sidebar rows and the mobile status strip. Without
// them a working session only reads as a generic spinner; with them the user can
// see WHAT it's doing. `starting`→`tool-running` also advances near-instantly,
// which kills the "false finished badge while pinned at starting" residual.
// SubagentStop is still dropped (a no-op in applyHook — returns state unchanged).
const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
] as const;

// Events this installer used to register and no longer does. `MonitorArmed` and
// `MonitorClosed` are not emitted by Claude Code (absent from the event list of
// 2.1.237 and 2.1.289), and 2.1.289 drops each unknown event key from
// settings.json with a "Settings Warning". The server keeps accepting them for
// an older CLI; the live watch signal is the `PreToolUse` of `Monitor`
// (`server/lib/claude-session-state.ts`). Install removes our stale entries for
// these events and uninstall cleans them up too.
const RETIRED_EVENTS = ["MonitorArmed", "MonitorClosed"] as const;

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
const ASYNC_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "Stop", "Notification"]);

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
  topics_app?: boolean;
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  // Optional because a hand-written file can omit it (`{"matcher":"Bash"}`):
  // such a matcher is left exactly as it is.
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Could not parse ${SETTINGS_PATH}:`, err);
    console.error("Refusing to overwrite an unparseable settings file. Fix it manually first.");
    process.exit(1);
  }
}

function writeSettings(s: ClaudeSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function ensureWrapperInstalled(): void {
  mkdirSync(HOOKS_DEST_DIR, { recursive: true });
  copyFileSync(WRAPPER_SRC, WRAPPER_DEST);
  chmodSync(WRAPPER_DEST, 0o755);
}

function buildCommand(event: string): string {
  // Il path VA tra apici. Claude Code esegue i command hook via `/bin/sh -c`:
  // senza virgolette una home che contiene uno spazio viene word-splittata e
  // l'hook non parte proprio — nessun errore, semplicemente niente segnale, e la
  // fase resta appesa a `starting`. WRAPPER_DEST nasce da homedir(), quindi non è
  // input esterno, ma costa una riga e toglie di mezzo un'intera classe di guasto
  // muto. L'evento resta fuori dagli apici: è una costante nostra, senza spazi.
  return `"${WRAPPER_DEST}" ${event}`;
}

function buildEntry(event: string): HookEntry {
  return {
    type: "command",
    command: buildCommand(event),
    timeout: 5,
    ...(ASYNC_EVENTS.has(event) ? { async: true } : {}),
    topics_app: true,
  };
}

// The wrapper path followed by the event, quoted or not, whatever the home it
// was written under. This is how an entry written before the `topics_app`
// marker existed is recognised: the live file of the first users still has
// seven of them, unmarked and with the path unquoted.
const WRAPPER_TAIL = /(?:^|\/)topics-hooks\/post-hook\.sh["']?\s+(\S+)\s*$/;

/** Is this hook one of ours for `event`? A marked entry is ours wherever it
 *  sits, whatever its command says: the marker is written by this script only,
 *  so a marked `post-hook.sh SessionEnd` under `Stop` is a stray of ours, which
 *  install repairs and uninstall removes. An unmarked entry is ours when it is
 *  the wrapper followed by this very event. */
function isOurEntry(h: HookEntry, event: string): boolean {
  if (h?.topics_app === true) return true;
  if (typeof h?.command !== "string") return false;
  return WRAPPER_TAIL.exec(h.command)?.[1] === event;
}

function firesOnEveryTool(m: HookMatcher): boolean {
  return !m.matcher || m.matcher === "*";
}

function hooksOf(m: HookMatcher): HookEntry[] {
  return Array.isArray(m?.hooks) ? m.hooks : [];
}

/** Take `drop` out of the matchers, then remove only the matchers this left
 *  empty: one that was empty before is somebody else's and stays. */
function dropEntries(matchers: HookMatcher[], drop: ReadonlySet<HookEntry>): HookMatcher[] {
  const nowEmpty = new Set<HookMatcher>();
  for (const m of matchers) {
    const hooks = hooksOf(m);
    if (!hooks.some((h) => drop.has(h))) continue;
    m.hooks = hooks.filter((h) => !drop.has(h));
    if (m.hooks.length === 0) nowEmpty.add(m);
  }
  return matchers.filter((m) => !nowEmpty.has(m));
}

/** Rewrite `entry` in place to the canonical shape. Only the fields this script
 *  generates change; any other key keeps its value and position. Returns
 *  whether something changed. */
function repairEntry(entry: HookEntry, event: string): boolean {
  const canonical = buildEntry(event);
  let changed = false;
  for (const [key, value] of Object.entries(canonical)) {
    if (entry[key] !== value) {
      entry[key] = value;
      changed = true;
    }
  }
  if (!ASYNC_EVENTS.has(event) && "async" in entry) {
    delete entry.async;
    changed = true;
  }
  return changed;
}

/** Drop every hook of ours for `event`, then the matchers and the event key
 *  left empty by it. Returns how many entries went. */
function removeOurEntries(settings: ClaudeSettings, event: string): number {
  const matchers = settings.hooks?.[event];
  if (!matchers) return 0;
  const ours = new Set(matchers.flatMap((m) => hooksOf(m).filter((h) => isOurEntry(h, event))));
  if (ours.size === 0) return 0;
  settings.hooks![event] = dropEntries(matchers, ours);
  if (settings.hooks![event]!.length === 0) delete settings.hooks![event];
  return ours.size;
}

function install(): void {
  ensureWrapperInstalled();
  const settings = readSettings();
  settings.hooks = settings.hooks ?? {};

  let added = 0;
  let repaired = 0;
  for (const event of HOOK_EVENTS) {
    const matchers = settings.hooks[event] ?? [];
    // Look in EVERY matcher, not only the first wildcard one: a legacy entry
    // can sit anywhere, and missing it is what appended a second Topics hook
    // next to it.
    const found = matchers.flatMap((m) => hooksOf(m).filter((h) => isOurEntry(h, event)).map((h) => ({ m, h })));
    // Ours, possibly written by an older version: the first copy sitting in a
    // wildcard matcher is repaired where it stands, so a fix to the entry
    // reaches whoever installed before it, and `matcher`, order and foreign
    // hooks stay as they are. A copy in a narrowed matcher never wins: the hook
    // would fire on that tool only, and `AskUserQuestion`, `ExitPlanMode` and
    // `Monitor` would never reach the server.
    const keep = found.find(({ m }) => firesOnEveryTool(m) && Array.isArray(m.hooks));
    // Every other copy goes: the old installer appended one next to every
    // unmarked entry, and a narrowed one is the case above.
    const extra = new Set(found.filter((f) => f !== keep).map(({ h }) => h));
    const kept = extra.size > 0 ? dropEntries(matchers, extra) : matchers;
    if (keep) {
      if (repairEntry(keep.h, event) || extra.size > 0) repaired += 1;
      settings.hooks[event] = kept;
      continue;
    }
    // None in a wildcard matcher: append to the first one we find, or create it.
    let target = kept.find((m) => firesOnEveryTool(m) && Array.isArray(m.hooks));
    if (!target) {
      target = { hooks: [] };
      kept.push(target);
    }
    target.hooks!.push(buildEntry(event));
    settings.hooks[event] = kept;
    if (found.length === 0) added += 1;
    else repaired += 1;
  }
  let retired = 0;
  for (const event of RETIRED_EVENTS) retired += removeOurEntries(settings, event);

  writeSettings(settings);
  console.log(`✓ Hook wrapper installed at ${WRAPPER_DEST}`);
  const unchanged = HOOK_EVENTS.length - added - repaired;
  console.log(`✓ Settings updated at ${SETTINGS_PATH} (${added} added, ${repaired} updated, ${unchanged} already current, ${retired} retired)`);
  console.log(`\nNext step: start Topics App so the hook token is generated.`);
  console.log(`  bun run dev:server`);
}

function uninstall(): void {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log("No hooks block in settings — nothing to remove.");
    return;
  }
  let removed = 0;
  for (const event of [...HOOK_EVENTS, ...RETIRED_EVENTS]) removed += removeOurEntries(settings, event);
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);

  // Remove the wrapper directory (keep token file — server may still use it).
  try {
    rmSync(HOOKS_DEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log(`✓ Removed ${removed} Topics App hook entries from ${SETTINGS_PATH}`);
  console.log(`✓ Removed ${HOOKS_DEST_DIR}`);
}

const cmd = process.argv[2] ?? "install";
if (cmd === "install") {
  install();
} else if (cmd === "uninstall") {
  uninstall();
} else {
  console.error(`Usage: ${process.argv[1]} [install|uninstall]`);
  process.exit(2);
}
