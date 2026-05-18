/**
 * claude-events-watcher.ts — Phase F (triple-layer notification capture).
 *
 * Reads `~/.topics/events.jsonl` produced by the Claude Code hooks
 * (scripts/hooks/claude-stop.ts, claude-pretooluse.ts) and forwards
 * actionable events to connected clients via the broadcast channel.
 *
 * Three layers (NOTIF-01):
 *   1. **FS watcher** — primary, sub-second latency on local fs.
 *   2. **5s polling fallback** — closes gaps when fs watcher misses.
 *   3. **Real-time Darwin notification** — produced by the hook itself
 *      (not consumed here; the tray app subscribes).
 *
 * Non-invasive (NOTIF-05): we read all lines but only broadcast P0/P1.
 * P2 lines are persisted for the reasoning trail and not surfaced as
 * notifications.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClaudeEvent {
  ts: number;
  kind: string;
  severity: "P0" | "P1" | "P2" | "SKIP";
  payload: any;
}

export type BroadcastFn = (msg: any) => void;

/**
 * Pluggable Focus / Do-Not-Disturb signal (NOTIF-03).
 * Returns true if macOS Focus mode is currently active. The default
 * implementation always returns false (no suppression). The Electron tray
 * app can swap in a richer probe via osascript / NSUserNotificationCenter.
 */
export type FocusProbe = () => boolean;

export interface WatcherOptions {
  /** Override path to events.jsonl (default ~/.topics/events.jsonl). */
  eventsPath?: string;
  /** Polling interval ms (default 5000 per NOTIF-01). */
  pollMs?: number;
  /** Called for each event that crosses the actionable threshold. */
  broadcast: BroadcastFn;
  /**
   * Optional Focus probe. When it returns true, P1 events are tagged
   * `suppressed: true` so downstream consumers (tray, push) know to skip
   * the visible notification while still updating in-app state.
   * P0 events bypass the probe (NOTIF-03 — P0 always delivered).
   */
  focusProbe?: FocusProbe;
}

export interface WatcherHandle {
  stop(): void;
  /** Returns the byte offset already consumed. Useful for tests. */
  cursor(): number;
}

export function startClaudeEventsWatcher(opts: WatcherOptions): WatcherHandle {
  const eventsPath = opts.eventsPath
    || join(process.env.TOPICS_HOME || join(homedir(), ".topics"), "events.jsonl");
  const pollMs = opts.pollMs ?? 5000;
  let cursor = 0;
  let lastIno = 0;
  let lastMtimeMs = 0;
  let fsWatcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function drainSync() {
    if (stopped) return;
    if (!existsSync(eventsPath)) return;
    let st: ReturnType<typeof statSync>;
    try { st = statSync(eventsPath); } catch { return; }
    // Detect rotation: different inode, OR same/smaller size with a newer mtime.
    // Re-write that produces a same-size file (rare but real) is caught by mtime.
    const inoChanged = lastIno !== 0 && st.ino !== lastIno;
    const truncated = st.size < cursor;
    const rewriteSameSize = lastMtimeMs !== 0 && st.mtimeMs > lastMtimeMs && st.size <= cursor;
    if (inoChanged || truncated || rewriteSameSize) {
      cursor = 0;
    }
    lastIno = st.ino;
    lastMtimeMs = st.mtimeMs;
    if (st.size === cursor) return;
    const length = st.size - cursor;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(eventsPath, "r");
      readSync(fd, buf, 0, length, cursor);
    } catch (err) {
      console.warn(`[claude-events-watcher] read failed: ${(err as Error).message}`);
      return;
    } finally {
      if (fd != null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
    cursor = st.size;
    const text = buf.toString("utf-8");
    const lines = text.split("\n");
    // Last fragment may be partial — leave it for next tick by rewinding cursor.
    if (lines.length > 0 && !text.endsWith("\n")) {
      const partial = lines.pop()!;
      cursor -= Buffer.byteLength(partial, "utf-8");
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: ClaudeEvent | null = null;
      try { ev = JSON.parse(trimmed) as ClaudeEvent; }
      catch { continue; }
      if (!ev || typeof ev.severity !== "string") continue;
      if (ev.severity === "P0" || ev.severity === "P1") {
        // NOTIF-03: Focus mode suppresses P1 desktop notifications but
        // never P0. We pass a `suppressed` flag the tray app honours.
        const suppressed = ev.severity === "P1" && opts.focusProbe ? opts.focusProbe() : false;
        opts.broadcast({ type: "claude-event", event: ev, suppressed });
      }
      // P2 events are intentionally not broadcast (NOTIF-05).
    }
  }

  // FS watcher (primary)
  try {
    if (existsSync(eventsPath)) {
      cursor = statSync(eventsPath).size;
      fsWatcher = watch(eventsPath, { persistent: false }, () => drainSync());
    } else {
      // Watch the parent directory for file creation.
      const dir = eventsPath.replace(/\/[^/]+$/, "");
      if (existsSync(dir)) {
        fsWatcher = watch(dir, { persistent: false }, (_evt, name) => {
          if (typeof name === "string" && eventsPath.endsWith(name)) drainSync();
        });
      }
    }
  } catch (err) {
    console.warn(`[claude-events-watcher] fs watch failed: ${(err as Error).message}`);
  }

  // Polling (fallback)
  pollTimer = setInterval(drainSync, pollMs);

  return {
    stop() {
      stopped = true;
      if (fsWatcher) { try { fsWatcher.close(); } catch { /* ignore */ } }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },
    cursor() { return cursor; },
  };
}
