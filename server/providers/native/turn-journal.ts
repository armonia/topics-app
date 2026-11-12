/**
 * The journal of a detached native turn: one JSON line per `StreamHandler`
 * event, written by the turn's own process (`turn-host.ts`) and read back by
 * the server (`detached-turn.ts`).
 *
 * WHY A JOURNAL. A native turn used to run inside the server process, so a
 * restart killed it: the chat showed "turn interrupted", the card redid its
 * turn, and the text already streamed was generated and paid for again. The
 * turn now runs in a process the AI broker hosts (`server/ai-bridge.mjs`),
 * which keeps every line in an append-only, offset-addressable store. A new
 * server re-reads the store from offset 0 and gets the whole turn so far,
 * every delta included, then follows the rest live: nothing is regenerated.
 *
 * WHAT IS NOT IN IT. The full text on every delta: `onTextDelta` carries the
 * round's text so far, and writing it each time would make the store grow
 * with the square of the answer. The decoder rebuilds it; `f` travels only
 * when the encoder's own running text disagrees with the loop's (a retried
 * round restarts from empty).
 */

import type { SteerItem } from "../../lib/turn-steer";
import { StringDecoder } from "node:string_decoder";
import type { StreamHandler } from "../types";
import type { ToolSpec } from "./tools";

export const JOURNAL_VERSION = 1;

/** One line of the journal. `e` is the event; the rest is its payload. */
export type JournalEvent =
  /** `model`: what the turn runs on, so a server that finds it after a restart prices it right. */
  | { e: "start"; v: number; pid: number; at: number; model?: string }
  | { e: "req"; at: number }
  | { e: "text"; d: string; f?: string }
  | { e: "think"; d: string }
  | { e: "think_start" }
  | { e: "think_end" }
  | { e: "tool_start"; id: string; name: string; args?: unknown }
  | { e: "tool_exec"; id: string }
  | { e: "tool_update"; id: string; r: string }
  | { e: "tool_args"; id: string; args: unknown; partial?: boolean }
  | { e: "tool_activity"; id: string }
  | { e: "retry"; info: { attempt: number; maxAttempts: number; delayMs: number; reason: string } }
  | { e: "tool_result"; id: string; r: string; err?: boolean }
  | { e: "ask"; id: string; name: string; schema: unknown }
  | { e: "compaction"; m: unknown }
  | { e: "usage"; u: RoundUsage }
  | { e: "done"; m?: unknown }
  | { e: "aborted"; m?: unknown }
  | { e: "error"; msg: string }
  /**
   * The loop took these steered messages into the history (`lib/turn-steer.ts`).
   * Whole, not just ids: a server that restarted meanwhile no longer has them.
   */
  | { e: "steered"; items: SteerItem[] }
  /**
   * The server's shared state, changed inside the host. The host's own copy of
   * these registries is invisible to the server, so each change travels here
   * and the server applies it (`turn-effects.ts`).
   */
  | {
      e: "hold"; at: number; hold: { untilMs: number; window: string; reason: string } | null;
      /** On a lift: the hold the host had, so the server lifts that one and no other. */
      lifted?: { window: string; untilMs: number };
    }
  | { e: "plan_usage"; at: number; u: unknown }
  | { e: "api_ok"; at: number }
  | { e: "cmd_start"; pid: number; command: string; at: number }
  | { e: "cmd_end"; pid: number }
  /**
   * The last line. Carries what the server keeps between turns; `warm` is the
   * request prefix the cache keep-alive needs, which a server that found the
   * turn after a restart has no other way to know.
   */
  | {
      e: "end"; history: unknown[]; calibration?: unknown; warm?: TurnWarmPrefix;
      /** Steered messages the host got and never took: sent on as turns of their own. */
      steerLeft?: SteerItem[];
      /** The turn ended on a person's Stop: what it left is held, not sent (a server that restarted cannot tell otherwise). */
      stoppedByPerson?: true;
    };

export interface TurnWarmPrefix {
  model: string;
  effort?: string | null;
  maxTokens?: number;
  system?: string;
  tools: ToolSpec[];
}

export interface RoundUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** The terminal events: after one of these only `end` may follow. */
export function isTerminal(ev: JournalEvent): boolean {
  return ev.e === "done" || ev.e === "aborted" || ev.e === "error";
}

/**
 * How often a tool's "still writing its input" heartbeat reaches the journal.
 * The loop fires one per JSON fragment of a tool's input, which for a large
 * file write is thousands of lines that say nothing new; the watchdog it feeds
 * only needs to know the tool is alive.
 */
export const ACTIVITY_EVERY_MS = 500;

/**
 * A `StreamHandler` that writes each event as a journal line.
 * `write` gets one complete line, newline included.
 */
export function journalingHandler(
  write: (line: string) => void,
  hooks: { now?: () => number } = {},
): StreamHandler & { emit: (ev: JournalEvent) => void } {
  const now = hooks.now ?? Date.now;
  const emit = (ev: JournalEvent) => write(JSON.stringify(ev) + "\n");
  let running = "";
  const lastActivity = new Map<string, number>();
  return {
    emit,
    onTextDelta: (d, full) => {
      if (full === running + d) { running = full; emit({ e: "text", d }); return; }
      running = full;
      emit({ e: "text", d, f: full });
    },
    onThinkingDelta: (d) => emit({ e: "think", d }),
    onThinkingStart: () => emit({ e: "think_start" }),
    onThinkingEnd: () => emit({ e: "think_end" }),
    onToolStart: (id, name, args) => emit({ e: "tool_start", id, name, ...(args !== undefined ? { args } : {}) }),
    onToolExecStart: (id) => emit({ e: "tool_exec", id }),
    onToolUpdate: (id, r) => emit({ e: "tool_update", id, r }),
    onToolArgsUpdate: (id, args, update) => emit({ e: "tool_args", id, args, ...(update?.partial ? { partial: true } : {}) }),
    onToolActivity: (id) => {
      const t = now();
      if (t - (lastActivity.get(id) ?? 0) < ACTIVITY_EVERY_MS) return;
      lastActivity.set(id, t);
      emit({ e: "tool_activity", id });
    },
    onRetry: (info) => emit({ e: "retry", info }),
    onToolResult: (id, r, err) => emit({ e: "tool_result", id, r, ...(err ? { err: true } : {}) }),
    onUserInputRequired: (id, name, schema) => emit({ e: "ask", id, name, schema }),
    onCompaction: (m) => emit({ e: "compaction", m }),
    onDone: (m) => emit({ e: "done", ...(m !== undefined ? { m } : {}) }),
    onAborted: (m) => emit({ e: "aborted", ...(m !== undefined ? { m } : {}) }),
    onError: (msg) => emit({ e: "error", msg }),
  };
}

/** What the reader learns from the lines it has folded so far. */
export interface JournalState {
  started: boolean;
  /** The model from `start`, when the host wrote one. */
  model: string | null;
  /** A terminal event was read: the turn is over, whatever the process does. */
  terminal: JournalEvent | null;
  end: Extract<JournalEvent, { e: "end" }> | null;
  /** Questions asked and not yet answered by a tool result. */
  openAsks: Set<string>;
  /** Round usage seen, in order. */
  rounds: number;
  /** When the last request left, for the cache keep-alive. */
  lastRequestAt: number | null;
}

export function newJournalState(): JournalState {
  return { started: false, model: null, terminal: null, end: null, openAsks: new Set(), rounds: 0, lastRequestAt: null };
}

/**
 * Folds journal lines into a handler. Keeps the running text so `onTextDelta`
 * gets the same `fullText` the loop gave the host.
 */
export interface JournalReader {
  state: JournalState;
  /** Split a chunk of the store into lines and fold each. Partial lines wait for the rest. */
  push(chunk: string): void;
  /**
   * `push` for raw store bytes. The broker cuts chunks anywhere, inside a
   * UTF-8 character too: decoding each chunk on its own turned such a
   * character into U+FFFD, in the streamed text and in `end.history`, which
   * the next turns then sent to the model.
   */
  pushBytes(chunk: Uint8Array): void;
  fold(ev: JournalEvent): void;
}

export function journalReader(
  handler: StreamHandler | null,
  extra: { onUsage?: (u: RoundUsage, model: string | null) => void; onEvent?: (ev: JournalEvent) => void } = {},
): JournalReader {
  const decoder = new StringDecoder("utf8");
  const state = newJournalState();
  let running = "";
  let pending = "";
  const fold = (ev: JournalEvent): void => {
    // An effect that throws (a registry, a persist) must not stop the reader:
    // the turn's next lines would be lost with it.
    try { extra.onEvent?.(ev); } catch (err) {
      console.warn(`[native-journal] effect failed on ${ev.e}:`, err instanceof Error ? err.message : err);
    }
    switch (ev.e) {
      case "start": state.started = true; state.model = ev.model ?? null; return;
      case "req": state.lastRequestAt = ev.at; running = ""; return;
      case "usage": state.rounds++; extra.onUsage?.(ev.u, state.model); return;
      case "end": state.end = ev; return;
      case "ask": state.openAsks.add(ev.id); break;
      case "tool_result": state.openAsks.delete(ev.id); break;
      default: break;
    }
    if (isTerminal(ev)) state.terminal = ev;
    if (!handler) return;
    // A handler that throws must not stop the reader: the next lines still
    // belong to the turn, and losing them is worse than losing one frame.
    try { deliver(handler, ev); } catch (err) {
      console.warn(`[native-journal] handler failed on ${ev.e}:`, err instanceof Error ? err.message : err);
    }
  };
  const deliver = (h: StreamHandler, ev: JournalEvent): void => {
    switch (ev.e) {
      case "text": {
        running = ev.f ?? running + ev.d;
        h.onTextDelta(ev.d, running);
        return;
      }
      case "think": h.onThinkingDelta?.(ev.d); return;
      case "think_start": h.onThinkingStart?.(); return;
      case "think_end": h.onThinkingEnd?.(); return;
      case "tool_start": h.onToolStart(ev.id, ev.name, ev.args as never); return;
      case "tool_exec": h.onToolExecStart?.(ev.id); return;
      case "tool_update": h.onToolUpdate?.(ev.id, ev.r); return;
      case "tool_args": h.onToolArgsUpdate?.(ev.id, ev.args as never, ev.partial ? { partial: true } : undefined); return;
      case "tool_activity": h.onToolActivity?.(ev.id); return;
      case "retry": h.onRetry?.(ev.info); return;
      case "tool_result": h.onToolResult(ev.id, ev.r, ev.err); return;
      case "ask": h.onUserInputRequired?.(ev.id, ev.name, ev.schema as never); return;
      case "compaction": h.onCompaction?.(ev.m as never); return;
      case "done": h.onDone(ev.m as never); return;
      case "aborted": h.onAborted?.(ev.m as never); return;
      case "error": h.onError(ev.msg); return;
      default: return;
    }
  };
  const reader: JournalReader = {
    state,
    fold,
    pushBytes(chunk: Uint8Array) {
      reader.push(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    },
    push(chunk: string) {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: JournalEvent;
        try { ev = JSON.parse(line) as JournalEvent; } catch { continue; }
        if (!ev || typeof (ev as { e?: unknown }).e !== "string") continue;
        fold(ev);
      }
    },
  };
  return reader;
}
