#!/usr/bin/env bun
/**
 * Install Topics App's Claude Code hook wrappers into the user's GLOBAL
 * ~/.claude/settings.json.
 *
 * OPTIONAL since the hooks became dynamic: every Claude session Topics launches
 * (chat, board, `claude` terminal panes) already carries them through
 * `--settings` (`server/lib/topics-hooks.ts`, the one definition this script
 * shares). Installing them globally makes them fire in EVERY Claude session of
 * the machine, Topics or not — useful only to whoever wants those tracked too.
 * `uninstall` is the way back to a clean local Claude.
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
 *   - Fire-and-forget events (`ASYNC_HOOK_EVENTS`) are registered with
 *     `async: true`, so a slow server never holds the turn.
 *   - Token: relies on Topics App having generated the token on first boot
 *     at ${TOPICS_HOME:-~/.topics}/claude-hooks/hook-token (the wrapper also
 *     falls back to a legacy ~/.claude/topics-hook-token left by an older
 *     version). If the server has never been started, this script still
 *     writes the settings; the wrapper will no-op silently until the token
 *     exists.
 *   - Script: the entries point at ${TOPICS_HOME:-~/.topics}/claude-hooks/post-hook.sh,
 *     the copy the server writes at boot next to the token; this script writes
 *     it too, so it works before the first boot. The old copy under
 *     ~/.claude/topics-hooks/ is removed by both install and uninstall.
 *   - This script is the ONE place Topics writes under ~/.claude, and only
 *     because the user runs it by hand (`bun run hooks:install`): the server
 *     itself never touches that directory.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  ASYNC_HOOK_EVENTS,
  RETIRED_HOOK_EVENTS,
  TOPICS_HOOK_EVENTS,
  topicsHookEntry,
  type HookEntry,
  type HookMatcher,
} from "../server/lib/topics-hooks";
import { hookScriptPath, writeHookScript } from "../server/lib/topics-hook-script";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
// Where an older version copied the script. Nothing reads it any more: install
// and uninstall both remove it.
const LEGACY_HOOKS_DIR = join(CLAUDE_DIR, "topics-hooks");
// The same file the server writes at boot and names in its spawns' `--settings`.
const WRAPPER_DEST = hookScriptPath();

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

function buildEntry(event: string): HookEntry {
  return topicsHookEntry(WRAPPER_DEST, event);
}

// The wrapper path followed by the event, quoted or not, whatever the home it
// was written under. This is how an entry written before the `topics_app`
// marker existed is recognised: the live file of the first users still has
// seven of them, unmarked and with the path unquoted. Both homes of the script
// count: `~/.claude/topics-hooks/` (before) and `${TOPICS_HOME}/claude-hooks/`.
const WRAPPER_TAIL = /(?:^|\/)(?:topics|claude)-hooks\/post-hook\.sh["']?\s+(\S+)\s*$/;

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
  if (!ASYNC_HOOK_EVENTS.has(event) && "async" in entry) {
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
  writeHookScript(WRAPPER_DEST);
  const settings = readSettings();
  settings.hooks = settings.hooks ?? {};

  let added = 0;
  let repaired = 0;
  for (const event of TOPICS_HOOK_EVENTS) {
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
  for (const event of RETIRED_HOOK_EVENTS) retired += removeOurEntries(settings, event);

  writeSettings(settings);
  rmSync(LEGACY_HOOKS_DIR, { recursive: true, force: true });
  console.log(`✓ Hook wrapper installed at ${WRAPPER_DEST}`);
  const unchanged = TOPICS_HOOK_EVENTS.length - added - repaired;
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
  for (const event of [...TOPICS_HOOK_EVENTS, ...RETIRED_HOOK_EVENTS]) removed += removeOurEntries(settings, event);
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);

  // The legacy copy goes. The script under TOPICS_HOME stays, with the token:
  // the server's own spawns still use it.
  try {
    rmSync(LEGACY_HOOKS_DIR, { recursive: true, force: true });
  } catch {}

  console.log(`✓ Removed ${removed} Topics App hook entries from ${SETTINGS_PATH}`);
  console.log(`✓ Removed ${LEGACY_HOOKS_DIR}`);
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
