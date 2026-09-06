/**
 * LIFECYCLE HOOKS: user-declared shell commands on named Topics events.
 *
 * One file, `hooks.json` under the Topics home, read AGAIN at every event so
 * that editing it needs no restart. Its shape:
 *
 *     { "hooks": [
 *       { "event": "pre-tool", "tool": "bash", "cmd": "~/bin/guard.sh", "timeoutMs": 3000 },
 *       { "event": "task-deliver", "cmd": "bun run typecheck" }
 *     ] }
 *
 * The vocabulary is CLOSED (HOOKS-01): four events, and an entry on any other
 * name is dropped with a warning that names it, the way the control-tool
 * vocabulary drops what it does not know. The command gets the payload as
 * JSON on stdin with the field names of the incoming Claude Code hooks
 * (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`), so a
 * script written for one can read the other.
 *
 * THE VERDICT IS THE EXIT CODE, and only that (HOOKS-02). Non-zero blocks the
 * action and what the command wrote on stderr is the reason the human reads.
 * Everything that is NOT a verdict - a file that does not parse, a command
 * that cannot start, a command that runs out of time - lets the action
 * proceed and leaves one warning in the log: a veto is something a command
 * said, and a command that never answered said nothing (HOOKS-03).
 *
 * THE CEILING ANSWERS BY ITSELF. After `timeoutMs` the whole process tree is
 * killed, and the answer goes out after a short grace EVEN IF no exit event
 * ever arrives. Killing is a request: a command that ignores SIGTERM, or a
 * leader already gone with its children reparented out of reach, must not
 * hold the turn that is waiting on it. `runCommand` in the native tools paid
 * for that lesson on 2026-09-02 (two turns stuck for hours on a promise that
 * waited for a death that never came), and this runner is modelled on it.
 */
import { readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { killProcessTree } from "../lib/process-tree";
import { topicsHome } from "./daemon-state";

export const HOOK_EVENTS = ["pre-tool", "turn-end", "task-deliver", "worktree-create"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookEntry {
  event: HookEvent;
  cmd: string;
  timeoutMs?: number;
  /** `pre-tool` only: run for this tool name alone. */
  tool?: string;
}

/**
 * What the command reads on stdin. The names are those of the incoming hook
 * payload (`server/lib/claude-session-state.ts`), the events are ours.
 */
export interface LifecycleHookPayload {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

export type HookOutcome = { ok: true } | { ok: false; reason: string };

/** The one door the runtime, the worktree manager and the task route call. */
export interface LifecycleHookRunner {
  run(event: HookEvent, payload: LifecycleHookPayload): Promise<HookOutcome>;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
/**
 * How long the runner waits for the exit event after the kill before it
 * answers on its own. Capped by the timeout itself so that a short ceiling
 * stays short: a 300 ms hook must not take a 2 s grace to be declared over.
 */
const GRACE_AFTER_KILL_MS = 1_000;
const MAX_CAPTURE_CHARS = 16_000;

export function isHookEvent(name: unknown): name is HookEvent {
  return typeof name === "string" && (HOOK_EVENTS as ReadonlyArray<string>).includes(name);
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(Math.round(ms), MAX_HOOK_TIMEOUT_MS);
}

/**
 * Tolerant on purpose: anything that is not the expected shape costs a warning
 * and nothing else. A hooks file must never be able to stop the server from
 * booting, and a typo in one entry must not silence the entries around it.
 */
export function parseHooksConfig(raw: string | null | undefined): { hooks: HookEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === null || raw === undefined || raw.trim() === "") return { hooks: [], warnings };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`hooks.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { hooks: [], warnings };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { hooks?: unknown }).hooks)
      ? (parsed as { hooks: unknown[] }).hooks
      : null;
  if (!list) {
    warnings.push("hooks.json must be an object with a \"hooks\" array");
    return { hooks: [], warnings };
  }
  const hooks: HookEntry[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      warnings.push(`hooks[${i}] is not an object and was dropped`);
      return;
    }
    const e = item as Record<string, unknown>;
    if (!isHookEvent(e.event)) {
      warnings.push(
        `hooks[${i}] names an unknown event ${JSON.stringify(e.event)} and was dropped (known: ${HOOK_EVENTS.join(", ")})`,
      );
      return;
    }
    if (typeof e.cmd !== "string" || e.cmd.trim() === "") {
      warnings.push(`hooks[${i}] (${e.event}) has no "cmd" and was dropped`);
      return;
    }
    if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== "number" || !Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0)) {
      warnings.push(`hooks[${i}] (${e.event}) has a "timeoutMs" that is not a positive number; the default applies`);
    }
    if (e.tool !== undefined && (e.event !== "pre-tool" || typeof e.tool !== "string")) {
      warnings.push(`hooks[${i}] (${e.event}) declares "tool", which only a pre-tool hook may use as a string; ignored`);
    }
    const entry: HookEntry = { event: e.event, cmd: e.cmd, timeoutMs: clampTimeout(e.timeoutMs as number | undefined) };
    if (e.event === "pre-tool" && typeof e.tool === "string" && e.tool) entry.tool = e.tool;
    hooks.push(entry);
  });
  return { hooks, warnings };
}

export type HookSpawn = typeof nodeSpawn;

export interface LifecycleHooksOptions {
  /** The file to re-read at every event. A thunk so the home can move under tests. */
  file: string | (() => string);
  spawn?: HookSpawn;
  log?: (message: string) => void;
}

/**
 * Runs ONE command under its ceiling and turns what happened into an outcome.
 * Exported for the tests of the runner alone; callers go through `run`.
 */
export function runHookCommand(
  entry: HookEntry,
  payload: LifecycleHookPayload,
  deps: { spawn: HookSpawn; log: (message: string) => void },
): Promise<HookOutcome> {
  const timeoutMs = clampTimeout(entry.timeoutMs);
  const label = `${entry.event} hook \`${entry.cmd}\``;
  return new Promise<HookOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = "";
    let stdout = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(outcome);
    };
    const proceedWithWarning = (why: string) => {
      deps.log(`[lifecycle-hooks] ${label} did not answer (${why}); the action proceeds`);
      finish({ ok: true });
    };
    let child: ReturnType<HookSpawn>;
    try {
      child = deps.spawn("/bin/sh", ["-lc", entry.cmd], {
        cwd: payload.cwd || undefined,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      proceedWithWarning(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const capture = (sink: "out" | "err") => (d: Buffer) => {
      if (sink === "err") { if (stderr.length < MAX_CAPTURE_CHARS) stderr += d.toString(); }
      else if (stdout.length < MAX_CAPTURE_CHARS) stdout += d.toString();
    };
    child.stdout?.on("data", capture("out"));
    child.stderr?.on("data", capture("err"));
    child.on("error", (err) => {
      proceedWithWarning(`could not start: ${err.message}`);
    });
    child.on("exit", (code) => {
      if (timedOut) {
        // The kill got through before the grace elapsed: same answer, just
        // sooner. The warning was written when the ceiling fired.
        finish({ ok: true });
        return;
      }
      if (code === 0) { finish({ ok: true }); return; }
      const reason = stderr.trim() || stdout.trim() || `${label} exited ${code === null ? "by signal" : code} with no message`;
      finish({ ok: false, reason });
    });
    // The payload goes in and the pipe closes: a command that reads stdin to
    // the end must not wait for us. A closed stdin on a command that never
    // reads is a harmless EPIPE, swallowed here.
    child.stdin?.on("error", () => { /* the command did not read its input */ });
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch { /* the command closed its input first */ }
    timer = setTimeout(() => {
      timedOut = true;
      deps.log(`[lifecycle-hooks] ${label} exceeded ${timeoutMs}ms and was killed; the action proceeds`);
      void killProcessTree(child.pid ?? 0).catch(() => { /* nobody left to kill */ });
      // THE TIMER ANSWERS, not the exit event. See the header.
      graceTimer = setTimeout(() => finish({ ok: true }), Math.min(GRACE_AFTER_KILL_MS, timeoutMs));
      graceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

export function createLifecycleHooks(opts: LifecycleHooksOptions): LifecycleHookRunner {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const spawn = opts.spawn ?? nodeSpawn;
  // "One warning", not one per event: the same broken file would otherwise
  // write the same line on every tool call. The set empties when the file
  // reads clean again, so a fixed-then-broken file warns again.
  const warned = new Set<string>();
  const warnOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    log(`[lifecycle-hooks] ${message}`);
  };

  function load(): HookEntry[] {
    const file = typeof opts.file === "function" ? opts.file() : opts.file;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // No file is the normal state of a machine that never declared a hook;
      // it earns no line in the log.
      if (code !== "ENOENT") warnOnce(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const { hooks, warnings } = parseHooksConfig(raw);
    if (warnings.length === 0) warned.clear();
    for (const w of warnings) warnOnce(`${file}: ${w}`);
    return hooks;
  }

  return {
    async run(event, payload) {
      const hooks = load().filter((h) => h.event === event && (!h.tool || h.tool === payload.tool_name));
      for (const h of hooks) {
        const outcome = await runHookCommand(h, payload, { spawn, log });
        if (!outcome.ok) return outcome;
      }
      return { ok: true };
    },
  };
}

let shared: LifecycleHookRunner | null = null;

/**
 * The runner the server shares. The file path is resolved at every event, not
 * at construction: `topicsHome()` reads the environment, and a test server
 * moves it.
 */
export function defaultLifecycleHooks(): LifecycleHookRunner {
  if (!shared) shared = createLifecycleHooks({ file: () => join(topicsHome(), "hooks.json") });
  return shared;
}
