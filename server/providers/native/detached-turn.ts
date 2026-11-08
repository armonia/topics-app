/**
 * The server's side of a detached native turn.
 *
 * The turn runs in `turn-host.ts`, a process the AI broker hosts under the id
 * `native:<sessionKey>`. This module starts it, feeds its journal to the route's
 * `StreamHandler`, forwards a Stop, and after a restart finds it again:
 * `reattachDetachedTurn` replays the journal from offset 0 (the store holds this
 * turn only: a new spawn truncates it) and keeps following it live. The turn's
 * effects on server-wide state (provider holds, plan usage, running commands)
 * travel in the journal too and are applied here (`turn-effects.ts`).
 *
 * WHY THE BROKER AND NOT A NEW DAEMON. `ai-bridge.mjs` already hosts the CLI's
 * turns with exactly the guarantees needed here: it survives server restarts
 * and crashes, keeps an append-only store per session, replays it from any
 * offset, and kills an orphan only after 90 s without a server. A second daemon
 * would be a second copy of all that to keep honest.
 */

import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAiBridgeClient } from "../../lib/ai-bridge-client";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";
import { journalReader, type JournalEvent, type JournalReader, type RoundUsage } from "./turn-journal";
import { applyTurnEffects, type HostControl } from "./turn-effects";
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
  /** Ends the follow now, as an exit would. */
  finish: (exitCode: number | null) => void;
  /**
   * Starts re-attaching on every reconnect. Called once the broker knows the
   * session: before the spawn's ack a reconnect finds it `missing`, and taking
   * that for a dead turn reported an error while the spawn's retry started the
   * host anyway, with nobody following it.
   */
  armReconnect: () => void;
}

/** What `detachAll` has to undo besides the handlers: the reconnect hook and the turn's effects. */
const followed = new Map<string, () => void>();

/**
 * Wires a reader to the broker's frames for `id`. Frames can arrive twice
 * (a replay overlapping live data after a reconnect), so each byte is folded
 * once, by offset.
 *
 * A DROPPED SOCKET IS NOT A DEAD TURN. The daemon forgets every attachment of
 * a socket that closes, and the host keeps writing to a store nobody reads:
 * the chat went silent and, at the host's exit, everything after the drop was
 * lost. So a reconnect re-attaches from the last byte folded, and an exit
 * that arrives before `end` first fetches the tail it never saw.
 */
function follow(
  id: string,
  handler: StreamHandler | null,
  extra: { onUsage?: (u: RoundUsage, model: string | null) => void },
): Follow {
  const client = getAiBridgeClient();
  const sessionKey = sessionKeyOfBrokerId(id) ?? id;
  const effects = applyTurnEffects(sessionKey, (msg) => { void sendControl(id, msg); });
  const reader = journalReader(handler, { onUsage: extra.onUsage, onEvent: effects.apply });
  let consumed = 0;
  let settle!: (r: DetachedTurnResult) => void;
  const done = new Promise<DetachedTurnResult>((r) => { settle = r; });
  let settled = false;
  let offReconnect: () => void = () => {};
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    offReconnect();
    effects.close();
    followed.delete(id);
    client.unregister(id);
    // A process that ended without a terminal event died: the route must
    // still hear that the turn is over, or its row stays open for ever.
    if (!reader.state.terminal && handler) {
      const why = `the turn's process ended without finishing (exit ${exitCode ?? "signal"})`;
      try { handler.onError(why); } catch { /* the reader's own guard */ }
    }
    // The broker forgets the session on EVERY ending a server has read, not
    // only on `end`: a dead store left behind is read by the boot as a turn
    // that ended with nobody listening, and an old one was merged into the
    // row of a later turn.
    try { client.kill(id); } catch { /* already gone */ }
    settle({ terminal: reader.state.terminal, end: reader.state.end, lastRequestAt: reader.state.lastRequestAt, exitCode });
  };
  const fetchTailThenFinish = (exitCode: number | null) => {
    if (settled) return;
    client.attachWhole(id, consumed, 1)
      .catch((err: unknown) => console.warn(`[native-detached] ${id}: could not fetch the tail (${err instanceof Error ? err.message : String(err)}), closing without it`))
      .finally(() => finish(exitCode));
  };
  client.registerHandlers(id, {
    onData: (chunk, offset) => {
      const endAt = offset + chunk.byteLength;
      if (endAt <= consumed) return;
      const fresh = offset < consumed ? chunk.subarray(consumed - offset) : chunk;
      consumed = endAt;
      reader.pushBytes(fresh);
      // `end` is the last line the host writes: the turn is over even if the
      // exit frame is late (or lost with a socket).
      if (reader.state.end) finish(0);
    },
    onStderr: forwardHostLog(id),
    onExit: (code, endOffset) => {
      if (reader.state.end) { finish(code); return; }
      // Bytes past what we folded: a stretch spent detached. Read them first.
      if (typeof endOffset !== "number" || endOffset > consumed) { fetchTailThenFinish(code); return; }
      finish(code);
    },
  });
  const armReconnect = () => {
    if (settled) return;
    offReconnect();
    offReconnect = client.onReconnect(() => {
      if (settled) return;
      client.attachWhole(id, consumed)
        .then((r) => {
          if (settled) return;
          if (r.missing) { finish(r.exitCode); return; }
          if (!r.alive) finish(r.exitCode);
        })
        .catch((err: unknown) => console.warn(`[native-detached] ${id}: re-attach after a reconnect failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  };
  followed.set(id, () => { offReconnect(); effects.close(); });
  return { reader, done, finish, armReconnect };
}

/**
 * The host's stderr, line by line, into the server's own logs. The loop's
 * `[native] ...` lines (rounds, compaction) were `console.log` in the server,
 * and `scripts/token-audit.ts` reads them from the stdout log: sent to stderr
 * they landed in the error log and the audit never saw a detached turn. A
 * line cut across two chunks is joined first, and capped per line, not per
 * chunk: a chunk of several lines lost all but the first.
 */
export function forwardHostLog(
  id: string,
  sink: { out: (line: string) => void; err: (line: string) => void } = { out: (l) => console.log(l), err: (l) => console.warn(l) },
): (chunk: Uint8Array) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      const tagged = `[native-detached] ${id}: ${line.slice(0, 2_000)}`;
      if (line.startsWith("[native] ")) sink.out(tagged);
      else sink.err(tagged);
    }
  };
}

/** One control line to the host. A socket being re-made is waited for once; past that, `fallback`. */
async function sendControl(id: string, msg: HostControl, fallback?: () => void): Promise<void> {
  const client = getAiBridgeClient();
  const line = JSON.stringify(msg) + "\n";
  try { client.write(id, line); return; } catch { /* the socket is down: reconnect and resend */ }
  try {
    await client.ensureConnected();
    client.write(id, line);
  } catch (err) {
    console.warn(`[native-detached] ${id}: could not send ${msg.t}: ${err instanceof Error ? err.message : String(err)}`);
    fallback?.();
  }
}

/**
 * Start a turn in its own process and follow it to the end.
 * Resolves when the turn is over; the handler has had every event by then.
 */
export async function runDetachedTurn(
  spec: TurnSpec,
  handler: StreamHandler,
  extra: { onUsage?: (u: RoundUsage, model: string | null) => void; signal?: AbortSignal; env?: Record<string, string> },
): Promise<DetachedTurnResult> {
  const client = getAiBridgeClient();
  const id = brokerIdFor(spec.sessionKey);
  await client.ensureConnected();
  // A host still alive under this id is a turn nobody follows: the provider
  // adopts it first (`awaitStrayTurn`). One still here is a race lost to it,
  // and the broker's spawn is idempotent per id and would hand us ITS stream.
  await endStrayTurn(id);
  const f = follow(id, handler, extra);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra.env ?? process.env)) if (typeof v === "string") env[k] = v;
  try {
    await client.spawn(id, { cliPath: process.execPath, args: [HOST_PATH], cwd: spec.workspace || env.HOME || "/", env });
    client.write(id, JSON.stringify(spec) + "\n");
    f.armReconnect();
  } catch (err) {
    followed.get(id)?.();
    followed.delete(id);
    client.unregister(id);
    // A process that started without its spec would wait for it for ever.
    try { client.kill(id); } catch { /* never started */ }
    throw err;
  }
  const onAbort = () => { void abortDetachedTurn(spec.sessionKey, String(extra.signal?.reason ?? "user")); };
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

/**
 * Ask the turn's process to stop. The cause travels into the turn's own signal.
 * A Stop pressed while the broker socket is being re-made is sent once it is
 * back; if it cannot be, the process is killed: a Stop that is lost leaves a
 * turn editing files after the person was told it stopped.
 */
export async function abortDetachedTurn(sessionKey: string, cause: string): Promise<void> {
  const id = brokerIdFor(sessionKey);
  await sendControl(id, { t: "abort", cause }, () => { try { getAiBridgeClient().kill(id); } catch { /* gone */ } });
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

/**
 * A turn of this session that no server follows (a restart left it, and
 * nothing re-adopted it): still running, or already ended with its journal
 * in the broker. Followed silently to its end, so its conversation is not
 * lost under the new turn: a new spawn truncates the store, and the history
 * rebuilt from the database misses what it did. Its rounds are priced through
 * `onUsage` like any other. Resolves with its `end`, or null when there was
 * none.
 */
export async function awaitStrayTurn(
  sessionKey: string,
  extra: { onUsage?: (u: RoundUsage, model: string | null) => void } = {},
): Promise<Extract<JournalEvent, { e: "end" }> | null> {
  const client = getAiBridgeClient();
  let info: { alive: boolean; endOffset: number } | undefined;
  try { info = (await client.list()).find((x) => x.id === brokerIdFor(sessionKey)); } catch { info = undefined; }
  // A store that ended while nobody listened holds the `end` too: the common
  // case of a card left running with dispatch off, written to after it ended.
  if (!info || (!info.alive && info.endOffset <= 0)) return null;
  console.warn(`[native-detached] ${sessionKey}: a turn nobody follows ${info.alive ? "is still running" : "ended unread"}, adopting it before the next one`);
  const { done } = await reattachDetachedTurn(sessionKey, null, extra);
  return (await done).end;
}

export type ReattachOutcome = "completed" | "live" | "awaiting-input" | "dead";

/**
 * Find a turn again after a restart. Replays its journal from the start into
 * `handler` (the route merges it into the row it reused) and keeps following.
 * `done` resolves when the turn is over.
 */
export async function reattachDetachedTurn(
  sessionKey: string,
  handler: StreamHandler | null,
  extra: { onUsage?: (u: RoundUsage, model: string | null) => void } = {},
): Promise<{ outcome: ReattachOutcome; done: Promise<DetachedTurnResult> }> {
  const client = getAiBridgeClient();
  const id = brokerIdFor(sessionKey);
  await client.ensureConnected();
  const f = follow(id, handler, extra);
  let attached;
  try {
    attached = await client.attachWhole(id, 0);
  } catch (err) {
    followed.get(id)?.();
    followed.delete(id);
    client.unregister(id);
    throw err;
  }
  f.armReconnect();
  // The replay arrived before the ack (same socket, in order): the reader has
  // folded the whole turn so far.
  const st = f.reader.state;
  if (!attached.missing && st.terminal) {
    // A host killed between its terminal event and `end` gets no exit frame
    // for us any more: the follow ends here.
    if (!attached.alive) f.finish(attached.exitCode);
    return { outcome: "completed", done: f.done };
  }
  if (attached.missing || !attached.alive) {
    // Gone between the list and the attach, or died between two servers
    // without a word: `finish` tells the route, which closes the row.
    f.finish(attached.exitCode);
    return { outcome: "dead", done: f.done };
  }
  return { outcome: st.openAsks.size > 0 ? "awaiting-input" : "live", done: f.done };
}

/** Stop listening to every turn this server follows. The processes go on. */
export function detachAll(sessionKeys: Iterable<string>): void {
  const client = getAiBridgeClient();
  for (const sk of sessionKeys) {
    const id = brokerIdFor(sk);
    try { client.detach(id); } catch { /* socket gone: nothing to detach from */ }
    followed.get(id)?.();
    followed.delete(id);
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

/**
 * When the session's open (partial) row was created, or null without one: a
 * turn nobody has closed. Epoch ms.
 */
export function openRowSince(sessionKey: string, db?: import("bun:sqlite").Database): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the database module is loaded at the first call, as the provider does
    const database = db ?? require("../../db").getDatabase();
    const row = database.query("SELECT timestamp FROM messages WHERE session_key = ? AND partial = 1 ORDER BY sort_order DESC LIMIT 1").get(sessionKey) as { timestamp?: string } | null;
    if (!row) return null;
    const t = Date.parse(String(row.timestamp ?? ""));
    return Number.isFinite(t) ? t : 0;
  } catch {
    return null;
  }
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
