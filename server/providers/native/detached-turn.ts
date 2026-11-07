/**
 * The server's side of a detached native turn.
 *
 * The turn runs in `turn-host.ts`, a process the AI broker hosts under the id
 * `native:<sessionKey>`. This module starts it, feeds its journal to the route's
 * `StreamHandler`, forwards a Stop, and after a restart finds it again:
 * `reattachDetachedTurn` replays the journal from offset 0 (the store holds this
 * turn only: a new spawn truncates it) and keeps following it live.
 *
 * WHY THE BROKER AND NOT A NEW DAEMON. `ai-bridge.mjs` already hosts the CLI's
 * turns with exactly the guarantees needed here: it survives server restarts
 * and crashes, keeps an append-only store per session, replays it from any
 * offset, and kills an orphan only after 90 s without a server. A second daemon
 * would be a second copy of all that to keep honest.
 */

import { join } from "node:path";
import { getAiBridgeClient } from "../../lib/ai-bridge-client";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";
import { journalReader, type JournalEvent, type JournalReader, type RoundUsage } from "./turn-journal";
import type { TurnSpec } from "./turn-host";

const PREFIX = "native:";

/** Whether native turns run detached. Needs the broker; `TOPICS_NATIVE_DETACHED=0` turns it off. */
export function nativeDetachedEnabled(): boolean {
  if (process.env.TOPICS_NATIVE_DETACHED === "0") return false;
  return process.env.TOPICS_AI_BRIDGE === "1" || process.env.TOPICS_AI_BRIDGE === "true";
}

export function brokerIdFor(sessionKey: string): string {
  return PREFIX + sessionKey;
}

/** The session key behind a broker id, or null when the id is not a native turn's. */
export function sessionKeyOfBrokerId(id: string): string | null {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null;
}

const HOST_PATH = join(import.meta.dir, "turn-host.ts");

export interface DetachedTurnResult {
  /** The terminal event (done / aborted / error), or null if the process died first. */
  terminal: JournalEvent | null;
  end: Extract<JournalEvent, { e: "end" }> | null;
  lastRequestAt: number | null;
  exitCode: number | null;
}

interface Follow {
  reader: JournalReader;
  done: Promise<DetachedTurnResult>;
}

/**
 * Wires a reader to the broker's frames for `id`. Frames can arrive twice
 * (a replay overlapping live data after a reconnect), so each byte is folded
 * once, by offset.
 */
function follow(
  id: string,
  handler: StreamHandler | null,
  extra: { onUsage?: (u: RoundUsage) => void },
): Follow {
  const client = getAiBridgeClient();
  const reader = journalReader(handler, { onUsage: extra.onUsage });
  let consumed = 0;
  let settle!: (r: DetachedTurnResult) => void;
  const done = new Promise<DetachedTurnResult>((r) => { settle = r; });
  let settled = false;
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    client.unregister(id);
    // A process that ended without a terminal event died: the route must
    // still hear that the turn is over, or its row stays open for ever.
    if (!reader.state.terminal && handler) {
      const why = `the turn's process ended without finishing (exit ${exitCode ?? "signal"})`;
      try { handler.onError(why); } catch { /* the reader's own guard */ }
    }
    settle({ terminal: reader.state.terminal, end: reader.state.end, lastRequestAt: reader.state.lastRequestAt, exitCode });
  };
  client.registerHandlers(id, {
    onData: (chunk, offset) => {
      const endAt = offset + chunk.byteLength;
      if (endAt <= consumed) return;
      const fresh = offset < consumed ? chunk.subarray(consumed - offset) : chunk;
      consumed = endAt;
      reader.push(fresh.toString("utf8"));
      // `end` is the last line the host writes: the turn is over even if the
      // exit frame is late (or lost with a socket). The broker forgets the
      // session once a server has read its ending: a dead session left in its
      // list means a turn that ended with NO server listening, which is what
      // the boot looks for (and an old one would be read into a new row).
      if (reader.state.end) {
        finish(0);
        try { client.kill(id); } catch { /* already gone */ }
      }
    },
    onStderr: (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`[native-detached] ${id}: ${text.slice(0, 400)}`);
    },
    onExit: (code) => finish(code),
  });
  return { reader, done };
}

/**
 * Start a turn in its own process and follow it to the end.
 * Resolves when the turn is over; the handler has had every event by then.
 */
export async function runDetachedTurn(
  spec: TurnSpec,
  handler: StreamHandler,
  extra: { onUsage?: (u: RoundUsage) => void; signal?: AbortSignal; env?: Record<string, string> },
): Promise<DetachedTurnResult> {
  const client = getAiBridgeClient();
  const id = brokerIdFor(spec.sessionKey);
  await client.ensureConnected();
  // A host still alive under this id is a turn nobody is following any more
  // (the route answers 409 for one it knows). It is ended before ours starts:
  // the broker's spawn is idempotent per id and would hand us ITS stream.
  await endStrayTurn(id);
  const f = follow(id, handler, extra);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra.env ?? process.env)) if (typeof v === "string") env[k] = v;
  try {
    await client.spawn(id, { cliPath: process.execPath, args: [HOST_PATH], cwd: spec.workspace || env.HOME || "/", env });
    client.write(id, JSON.stringify(spec) + "\n");
  } catch (err) {
    client.unregister(id);
    // A process that started without its spec would wait for it for ever.
    try { client.kill(id); } catch { /* never started */ }
    throw err;
  }
  const onAbort = () => abortDetachedTurn(spec.sessionKey, String(extra.signal?.reason ?? "user"));
  if (extra.signal) {
    if (extra.signal.aborted) onAbort();
    else extra.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await f.done;
  } finally {
    extra.signal?.removeEventListener("abort", onAbort);
  }
}

/** Ask the turn's process to stop. The cause travels into the turn's own signal. */
export function abortDetachedTurn(sessionKey: string, cause: string): void {
  try { getAiBridgeClient().write(brokerIdFor(sessionKey), JSON.stringify({ t: "abort", cause }) + "\n"); }
  catch { /* no live process: nothing to stop */ }
}

async function endStrayTurn(id: string): Promise<void> {
  const client = getAiBridgeClient();
  let alive = false;
  try { alive = await client.hasLiveSession(id); } catch { alive = false; }
  if (!alive) return;
  console.warn(`[native-detached] ${id}: a turn process is still alive with no one following it, ending it first`);
  try { client.write(id, JSON.stringify({ t: "abort", cause: "superseded" }) + "\n"); } catch { /* gone */ }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try { if (!(await client.hasLiveSession(id))) return; } catch { return; }
  }
  client.kill(id);
}

export type ReattachOutcome = "completed" | "live" | "awaiting-input" | "dead";

/**
 * Find a turn again after a restart. Replays its journal from the start into
 * `handler` (the route merges it into the row it reused) and keeps following.
 * `done` resolves when the turn is over.
 */
export async function reattachDetachedTurn(
  sessionKey: string,
  handler: StreamHandler,
  extra: { onUsage?: (u: RoundUsage) => void } = {},
): Promise<{ outcome: ReattachOutcome; done: Promise<DetachedTurnResult> }> {
  const client = getAiBridgeClient();
  const id = brokerIdFor(sessionKey);
  await client.ensureConnected();
  const f = follow(id, handler, extra);
  let attached;
  try {
    attached = await client.attachWhole(id, 0);
  } catch (err) {
    client.unregister(id);
    throw err;
  }
  if (attached.missing) {
    client.unregister(id);
    return { outcome: "dead", done: Promise.resolve({ terminal: null, end: null, lastRequestAt: null, exitCode: null }) };
  }
  // The replay arrived before the ack (same socket, in order): the reader has
  // folded the whole turn so far.
  const st = f.reader.state;
  if (st.terminal) return { outcome: "completed", done: f.done };
  if (!attached.alive) {
    // Died between two servers without a word: tell the route, which closes the row.
    try { handler.onError(`the turn's process ended without finishing (exit ${attached.exitCode ?? "signal"})`); } catch { /* guarded */ }
    client.unregister(id);
    return { outcome: "dead", done: Promise.resolve({ terminal: null, end: null, lastRequestAt: st.lastRequestAt, exitCode: attached.exitCode }) };
  }
  return { outcome: st.openAsks.size > 0 ? "awaiting-input" : "live", done: f.done };
}

/** Stop listening to every turn this server follows. The processes go on. */
export function detachAll(sessionKeys: Iterable<string>): void {
  const client = getAiBridgeClient();
  for (const sk of sessionKeys) {
    const id = brokerIdFor(sk);
    try { client.detach(id); } catch { /* socket gone: nothing to detach from */ }
    client.unregister(id);
  }
}

/** Live native turn processes, by session key. */
export async function liveDetachedSessions(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const s of await getAiBridgeClient().list()) {
    const sk = sessionKeyOfBrokerId(s.id);
    if (sk && s.alive) out.add(sk);
  }
  return out;
}

/** How a detached turn ended, from its terminal journal event. */
export function detachedTurnEnd(r: DetachedTurnResult): TurnEndInfo {
  const t = r.terminal;
  if (t && (t.e === "done" || t.e === "aborted")) {
    const end = (t.m as { turnEnd?: TurnEndInfo } | undefined)?.turnEnd;
    if (end) return end;
    return t.e === "done" ? { end: "end_turn" } as TurnEndInfo : { end: "cancelled" };
  }
  if (t && t.e === "error") return { end: "error", cause: "provider-error", detail: t.msg };
  return { end: "error", cause: "provider-error", detail: `the turn's process ended without finishing (exit ${r.exitCode ?? "signal"})` };
}

/** The session still has an open (partial) row: a turn nobody has closed. */
export function sessionHasOpenRow(sessionKey: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the database module is loaded at the first call, as the provider does
    const { getDatabase } = require("../../db");
    return !!getDatabase().query("SELECT 1 FROM messages WHERE session_key = ? AND partial = 1 LIMIT 1").get(sessionKey);
  } catch {
    return false;
  }
}
