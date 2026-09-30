/**
 * WHAT WOKE THE CLI: the source of a turn nobody asked for.
 *
 * A Monitor delivers each event by opening a turn of the model, and its
 * stream-json stdout says nothing about the event: recorded on chat 33966f4e
 * (CLI 2.1.285, 30/09), seven Monitor events reached the model and the store
 * holds zero lines naming them; a wake is a bare `result` then `system/init`.
 * The event lives in the CLI's own transcript, as the `user` line that opened
 * the turn:
 *
 *     <task-notification>
 *     <task-id>b5r4mxs3d</task-id>
 *     <summary>Monitor event: "batch 4 results"</summary>
 *     <event>[new] v133 ok in 229s</event>
 *     </task-notification>
 *
 * Topics used to label every wake with the description of the Monitor armed
 * LAST. On 30/09 between 20:57 and 21:14 that chat woke nine times, and seven
 * of the nine rows named the wrong source: two other Monitors expiring or
 * firing, and three reports of a background agent, all shown as
 * "Landed: batch 4 results", with no event text.
 *
 * So the source is read, in order of truth: the notifications the transcript
 * holds for this wake; else the task whose `task_notification` stdout printed
 * before it (a Monitor's expiry or end, a Bash, an Agent). Otherwise the wake
 * stays unnamed, which says less but never says something false: "the one
 * Monitor still listed" is no fact either, since the CLI delivers an event of a
 * Monitor after that Monitor's own expiry (20:59:11Z in the recording).
 *
 * Each source is spent by the wake that names it: a turn shorter than the
 * clock slack, or a report already answered, must not name the next wake too.
 */
import { closeSync, openSync, readSync, fstatSync } from "fs";
import { claudeTranscriptPath } from "../../lib/claude-transcript-path";
import type { BackgroundWork } from "./background-work";
import type { WakeEvent } from "../../../shared/types";


/** How much of the transcript's tail is read: a wake's own lines are the last few kB. */
const TAIL_BYTES = 256 * 1024;
/** The longest event text carried into a chat row. */
const EVENT_TEXT_MAX = 2_000;
/** Clock slack between the CLI's timestamps and the server's arrival times (same machine). */
const SLACK_MS = 1_000;
/** How far back a wake with no earlier `result` looks. */
const FIRST_WAKE_WINDOW_MS = 30_000;

function tag(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : undefined;
}

/**
 * How the CLI words a Monitor's end in a notification's summary (CLI 2.1.286,
 * the function that words a task's end): `Monitor "<description>" ` then
 * `stream ended`, `script failed` or `ended without producing output` (each
 * possibly with ` (exit N)`), or `stopped`. The Monitor's last event travels
 * in that same notification.
 */
const MONITOR_END = /^Monitor "([\s\S]*)" (stream ended|stopped|script failed(?: \(exit -?\d+\))?|ended without producing output(?: \(exit -?\d+\))?)$/;

/** The Monitor and how it ended, when `summary` is a Monitor's end as the CLI words it. */
export function readMonitorEnd(summary: string): { label: string; end: string } | null {
  const m = summary.match(MONITOR_END);
  return m ? { label: m[1], end: m[2] } : null;
}

/**
 * One `<task-notification>` as the chat names it, or null when the text is not
 * one. A Monitor's summary is `Monitor event: "<description>"`, or one of its
 * endings (`readMonitorEnd`), both named as that Monitor with the event text;
 * any other task (an Agent, a background Bash) is named by its summary as the
 * CLI wrote it.
 */
function parseTaskNotification(text: string): WakeEvent | null {
  if (!text.includes("<task-notification>")) return null;
  const summary = tag(text, "summary") ?? "";
  const event = tag(text, "event");
  const eventText = event ? { text: event.length > EVENT_TEXT_MAX ? `${event.slice(0, EVENT_TEXT_MAX)}…` : event } : {};
  const monitor = summary.match(/^Monitor event:\s*"([\s\S]*)"$/);
  if (monitor) return { source: "monitor", label: monitor[1], ...eventText };
  const ended = readMonitorEnd(summary);
  if (ended) return { source: "monitor", label: ended.label, end: ended.end, ...eventText };
  if (!summary) return null;
  return { source: "task", label: summary };
}

/**
 * The notifications that opened turns since `sinceMs`, read off the tail of the
 * CLI's transcript. Only `user` lines count: a notification the CLI folded into
 * a turn already running is an attachment of that turn, not a wake. Empty when
 * the file is missing or unreadable.
 */
function readWakeNotifications(path: string, sinceMs: number): Array<WakeEvent & { at: number }> {
  let fd: number | null = null;
  let text: string;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(len);
    readSync(fd, tail, 0, len, size - len);
    text = tail.toString("utf8");
    // The first line of a cut tail is partial.
    if (len < size) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return [];
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
  const out: Array<WakeEvent & { at: number }> = [];
  for (const line of text.split("\n")) {
    if (!line.includes("task-notification") || !line.includes('"type":"user"')) continue;
    let entry: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "user" || typeof entry.message?.content !== "string") continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const ev = parseTaskNotification(entry.message.content);
    if (ev) out.push({ ...ev, at });
  }
  return out;
}

/**
 * The source of the wake whose turn is starting now, from what the session's
 * background work knows (`background-work.ts`). The CLI's transcript is found
 * from the cwd and session id its last `system/init` reported.
 */
export function resolveWakeSource(work: BackgroundWork | undefined): WakeEvent[] {
  if (!work) return [];
  const since = (work.turnEndedAt > 0 ? work.turnEndedAt : work.initAt - FIRST_WAKE_WINDOW_MS) - SLACK_MS;
  const report = work.lastReport;
  work.lastReport = undefined;
  if (work.cliCwd && work.cliSessionId) {
    const read = readWakeNotifications(claudeTranscriptPath(work.cliCwd, work.cliSessionId), Math.max(since, work.wakeReadUpTo + 1));
    if (read.length > 0) {
      work.wakeReadUpTo = Math.max(...read.map((e) => e.at));
      return read.map(({ at: _at, ...ev }) => ev);
    }
  }
  if (report && report.at >= since) return [{ source: report.monitor ? "monitor" : "task", label: report.description, ...(report.end ? { end: report.end } : {}) }];
  return [];
}
