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
 *     hook object so the uninstaller can remove only our entries.
 *   - Token: relies on Topics App having generated the token on first boot
 *     (also written to ~/.claude/topics-hook-token). If the server has never
 *     been started, this script still writes the settings; the wrapper will
 *     no-op silently until the token exists.
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
  // Monitor/watch lifecycle — arm/close a background watch. MonitorArmed pins
  // the session in `watching` (ring stays on while it waits for an event);
  // MonitorClosed releases it. Harmless no-ops on a Claude Code that doesn't
  // emit them (the endpoint just never receives the event).
  "MonitorArmed",
  "MonitorClosed",
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
  hooks?: Partial<Record<typeof HOOK_EVENTS[number], HookMatcher[]>>;
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
    topics_app: true,
  };
}

/** La nostra entry per questo evento, se già presente. Il match resta per
 *  SUFFISSO (non per uguaglianza) apposta: deve riconoscere anche una entry
 *  scritta da una versione precedente, con un `command` diverso da quello che
 *  genereremmo oggi. È esattamente ciò che permette a `install()` di RIPARARLA
 *  invece di lasciarla lì o di affiancarle un duplicato. */
function findOurEntry(matcher: HookMatcher, event: string): HookEntry | undefined {
  return matcher.hooks.find((h) => h.topics_app === true && h.command?.endsWith(` ${event}`));
}

function install(): void {
  ensureWrapperInstalled();
  const settings = readSettings();
  settings.hooks = settings.hooks ?? {};

  let added = 0;
  let repaired = 0;
  for (const event of HOOK_EVENTS) {
    const matchers = settings.hooks[event] ?? [];
    // Topics App hooks fire on every matcher (no filter). We append our
    // entry to the first wildcard matcher we find, or create a new one.
    let target = matchers.find((m) => !m.matcher || m.matcher === "*");
    if (!target) {
      target = { hooks: [] };
      matchers.push(target);
    }
    const existing = findOurEntry(target, event);
    if (!existing) {
      target.hooks.push(buildEntry(event));
      added += 1;
    } else if (existing.command !== buildCommand(event)) {
      // Una entry NOSTRA ma scritta da una versione precedente. Prima veniva
      // riconosciuta e lasciata così com'era, quindi ogni correzione al comando
      // valeva solo per chi installava da zero: chi l'aveva già installato
      // restava col difetto finché non faceva uninstall+install a mano. Adesso
      // reinstallare la ripara. Si riscrive solo il campo che generiamo noi —
      // `matcher`, ordine ed eventuali entry altrui non si toccano.
      existing.command = buildCommand(event);
      repaired += 1;
    }
    settings.hooks[event] = matchers;
  }

  writeSettings(settings);
  console.log(`✓ Hook wrapper installed at ${WRAPPER_DEST}`);
  const unchanged = HOOK_EVENTS.length - added - repaired;
  console.log(`✓ Settings updated at ${SETTINGS_PATH} (${added} added, ${repaired} updated, ${unchanged} already current)`);
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
  for (const event of HOOK_EVENTS) {
    const matchers = settings.hooks[event];
    if (!matchers) continue;
    for (const m of matchers) {
      const before = m.hooks.length;
      m.hooks = m.hooks.filter((h) => h.topics_app !== true);
      removed += before - m.hooks.length;
    }
    // Drop matchers that no longer carry any hooks.
    settings.hooks[event] = matchers.filter((m) => m.hooks.length > 0);
    if (settings.hooks[event]!.length === 0) delete settings.hooks[event];
  }
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
