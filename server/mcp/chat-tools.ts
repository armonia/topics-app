/** Cross-topic chat tools: send_chat_message and read_chat_messages. */
import { bridgeAuthHeaders, HttpAnswerError, httpJson, loopbackInit } from "./topics-http";
import type { ParsedArgs } from "./topics-http";

/** How a turn ended, when it was not a finished answer (`turn` frame, chat route). */
interface TurnEndFrame { end: string; cause?: string }

/**
 * POST /api/chat for a target sessionKey and read the SSE stream, concatenating
 * the assistant's text deltas. The chat route streams
 * `data: {choices:[{delta:{content}}]}` lines (OpenAI-shaped) and ends a
 * finished turn with `data: [DONE]`. Loopback TLS + gateway token mirror
 * httpJson.
 *
 * `complete` is whether that `[DONE]` came. A close without it is a cut, not
 * an end: on 2026-09-24 the response closed 255 s into a silent tool while the
 * turn went on, and this function returned the half it had read as the reply.
 * The route's `turn` frames say which row the turn writes (`messageId`, first)
 * and how it ended when that was not a finished answer (`end`, before [DONE]).
 */
async function postChatReadSSE(
  args: ParsedArgs,
  targetSessionKey: string,
  message: string,
  fetchImpl: typeof fetch,
  topicId: string,
): Promise<{ text: string; complete: boolean; messageId?: string; end?: TurnEndFrame; held?: true }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...bridgeAuthHeaders(args) };
  let resp: Response;
  try {
    resp = await fetchImpl(`${args.baseUrl}/api/chat`, {
      method: "POST",
      headers,
      // `fromAgent`: another agent's words in the person's role. They do not
      // close the person's open questions as "you sent a new message instead".
      body: JSON.stringify({ sessionKey: targetSessionKey, messages: [{ role: "user", content: message }], fromAgent: true }),
      // A socket of its own. On a reused keep-alive socket that the server closes
      // mid-response, Bun's fetch sends the POST again by itself and glues the
      // second answer onto this body: the message reached the chat twice.
      keepalive: false,
      ...loopbackInit(),
    });
  } catch (err: unknown) {
    // The request may have arrived before the connection went: the chat may hold it.
    throw new Error(`send_chat_message: chat request lost (${err instanceof Error ? err.message : String(err)}). ${beforeResending(topicId)}`);
  }
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    // 409 non è un guasto: la topic sta già rispondendo a qualcun altro. Detto
    // com'è, invece che come un errore HTTP crudo, perché è azionabile — si
    // riprova quando ha finito (la chat dell'UI invece accoda da sola).
    // Only that 409 (`stream_in_flight`) is refused before anything is written;
    // another one can come after the person's row is saved.
    if (resp.status === 409 && t.includes("stream_in_flight")) {
      throw new Error("send_chat_message: c'è già un turno in volo su questa topic — riprova quando ha finito");
    }
    throw new Error(`send_chat_message: chat request failed (HTTP ${resp.status}) ${t.slice(0, 200)}. ${beforeResending(topicId)}`);
  }
  // The target's project is paused (quota brake): the route keeps the message
  // and sends it on "Continua". No stream comes back, and no reply to wait for.
  if (resp.status === 202) {
    const answer = (await resp.json().catch(() => null)) as { held?: unknown } | null;
    if (answer?.held === true) return { text: "", complete: false, held: true };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let complete = false;
  let messageId: string | undefined;
  let end: TurnEndFrame | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // Comment lines (`: ping`) and anything else that is not data.
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { complete = true; continue; }
        if (!payload) continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            turn?: { messageId?: string; end?: string; cause?: string };
          };
          // The first turn named is ours: anything after it on this body is not.
          if (typeof j?.turn?.messageId === "string") messageId ??= j.turn.messageId;
          if (typeof j?.turn?.end === "string") end = { end: j.turn.end, ...(j.turn.cause ? { cause: j.turn.cause } : {}) };
          const d = j?.choices?.[0]?.delta?.content;
          if (d) out += d;
        } catch { /* ignore non-JSON lines */ }
      }
    }
  } catch {
    // A reset mid-stream is a cut like a clean close without [DONE].
    complete = false;
  }
  return { text: out.trim(), complete, messageId, end };
}

/**
 * The line every failure but a person's Stop ends with. Topics resends some
 * interrupted turns by itself (a restart, a saturated API, the watchdog: the
 * resume sweep, every 5 min), and a caller that resends too runs the message
 * twice (round-4 review of card 63e01ac0).
 */
const beforeResending = (topicId: string) =>
  `Before sending it again, check read_chat_messages(topic_id="${topicId}"): Topics resends some interrupted turns by itself.`;

/** What the tool says for a turn that ended without finishing its answer. */
function unfinishedTurn(end: TurnEndFrame, text: string, topicId: string): string {
  // The route's empty-reply verdict (an error with no cause) is not always the
  // last word: the answer can land in that same row a moment later
  // (lib/empty-turn-headstone.ts), and a /clear ends this way too. Sending
  // again on it would run the message twice. A real error carries its cause.
  if (end.end === "error" && !end.cause && !text) {
    return `send_chat_message: the turn closed without writing a reply. Before sending again, check read_chat_messages(topic_id="${topicId}"): the answer can still land in that row a moment later, and a /clear ends this way too.`;
  }
  const how = end.end === "cancelled"
    ? `was stopped${end.cause === "user" ? " by a person" : end.cause ? ` (${end.cause})` : ""}`
    : end.end === "error" ? `ended in an error${end.cause ? ` (${end.cause})` : ""}` : `ended early (${end.end})`;
  return `send_chat_message: the turn ${how} before finishing its reply.`
    + (text ? ` What it had written: ${JSON.stringify(text)}.` : " It had written nothing.")
    + (end.end === "cancelled" && end.cause === "user" ? ` See read_chat_messages(topic_id="${topicId}").` : ` ${beforeResending(topicId)}`);
}

/** How long a cut send waits for the turn's real end, and how often it looks. */
export interface SendChatWait {
  pollMs?: number;
  maxWaitMs?: number;
  /** How long the server may stay unreachable, in a row, before the wait gives up. */
  unreachableMs?: number;
}
const CUT_SEND_POLL_MS = 2_000;
// A tool call cannot hold its caller for ever: past this it answers, and
// read_chat_messages has the rest. It is not the turn's limit, a live turn has none.
const CUT_SEND_MAX_WAIT_MS = 30 * 60_000;
// A save under server/ reloads the server here, and a turn in a child process
// is adopted again after it (38 s after the cut, on 24/09): the wait rides it out.
const CUT_SEND_UNREACHABLE_MS = 2 * 60_000;

type ChatRow = { id?: string; role?: string; content?: string; partial?: boolean; blocks?: Array<{ kind?: string; text?: string }>; latencyMs?: number; endReason?: string };

/**
 * The stream was cut before `[DONE]` while the turn may still be running. Wait
 * on the turn's own row, by the id the stream named, read ONE row at a time:
 * the list hides a partial row with no text yet, and the streaming registry
 * only says a turn is registered, so neither can say the turn is over.
 * The row can: it is the reply once it is no longer partial, and gone (404)
 * when the turn was dropped without writing anything. A turn waiting for a
 * person, still running past the wait, or closed with an error verdict is an
 * explicit failure.
 */
async function awaitTurnEndAndReadReply(
  args: ParsedArgs,
  topicId: string,
  sessionKey: string,
  messageId: string | undefined,
  fetchImpl: typeof fetch,
  wait: SendChatWait,
): Promise<string> {
  const see = `Use read_chat_messages(topic_id="${topicId}")`;
  if (!messageId) {
    throw new Error(`send_chat_message: stream interrupted before the turn named its reply, so there is nothing to wait on. ${beforeResending(topicId)}`);
  }
  const pollMs = wait.pollMs ?? CUT_SEND_POLL_MS;
  const maxWaitMs = wait.maxWaitMs ?? CUT_SEND_MAX_WAIT_MS;
  const unreachableMs = wait.unreachableMs ?? CUT_SEND_UNREACHABLE_MS;
  const deadline = Date.now() + maxWaitMs;
  let unreachableSince: number | null = null;
  for (;;) {
    let row: ChatRow | undefined;
    let live: { sessionKey?: string; state?: string } | undefined;
    try {
      row = (await httpJson<{ message?: ChatRow }>(
        args, "GET", `/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(messageId)}`, undefined, fetchImpl,
      ))?.message;
      if (!row || row.partial) {
        live = (await httpJson<{ sessions?: Array<{ sessionKey?: string; state?: string }> }>(
          args, "GET", "/api/topics/streaming", undefined, fetchImpl,
        ))?.sessions?.find((s) => s.sessionKey === sessionKey);
      }
      unreachableSince = null;
    } catch (err: unknown) {
      if (err instanceof HttpAnswerError && err.status === 404) {
        throw new Error(`send_chat_message: stream interrupted, and the turn ended without leaving a reply. ${beforeResending(topicId)}`);
      }
      // The server is reloading, or busy: the turn may well be alive. Ask again.
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince >= unreachableMs) {
        throw new Error(`send_chat_message: stream interrupted, and topics-app stayed unreachable for ${Math.round(unreachableMs / 1000)} s while the turn was awaited (${err instanceof Error ? err.message : String(err)}). ${beforeResending(topicId)}`);
      }
    }
    if (row && !row.partial) {
      const text = (row.content ?? "").trim();
      const verdict = row.blocks?.find((b) => b?.kind === "error");
      if (verdict) {
        throw new Error(`send_chat_message: stream interrupted, and the turn then ended badly: ${(verdict.text ?? "error").replace(/[.\s]+$/, "")}.`
          + (text ? ` What it had written: ${JSON.stringify(text)}.` : "") + ` ${beforeResending(topicId)}`);
      }
      // How the row was closed (`endReason`, card a57e6d4d): a Stop or a failure says so, the sweeps
      // close it from outside (the boot's with no verdict: the restart notice follows). An older
      // row has only `latency_ms`, which only a turn's own completion writes.
      if (row.endReason === "stopped" || row.endReason === "error") throw new Error(unfinishedTurn({ end: row.endReason === "stopped" ? "cancelled" : "error" }, text, topicId));
      if (row.endReason ? row.endReason !== "done" : row.latencyMs == null) {
        throw new Error(`send_chat_message: stream interrupted, and the turn was closed from outside before it finished (a restart or a watchdog).`
          + (text ? ` What it had written: ${JSON.stringify(text)}.` : " It had written nothing.") + ` ${beforeResending(topicId)}`);
      }
      return text;
    }
    if (live?.state === "waiting") {
      throw new Error(`send_chat_message: stream interrupted, and the turn is waiting for a person's answer in that chat. ${see} once it is answered; do not send it again.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`send_chat_message: stream interrupted, and the turn is still running after ${Math.round(maxWaitMs / 60_000)} min. ${beforeResending(topicId)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function callSendChatMessage(
  args: ParsedArgs,
  toolArgs: { topic_id?: unknown; message?: unknown },
  fetchImpl: typeof fetch = fetch,
  /** Tests only: a cut stream waits up to 30 min, polling every 2 s. */
  wait: SendChatWait = {},
): Promise<string> {
  if (typeof toolArgs?.topic_id !== "string" || !toolArgs.topic_id) {
    throw new Error("send_chat_message: 'topic_id' (string) is required");
  }
  if (typeof toolArgs?.message !== "string" || !toolArgs.message.trim()) {
    throw new Error("send_chat_message: 'message' (non-empty string) is required");
  }
  // Resolve the target topic → its sessionKey (topics carry non-derivable
  // sessionKeys for adopted/cloud sessions, so look it up rather than compute).
  // ONE topic, not the list: `GET /api/topics` is the live half only, and a
  // closed chat is still a chat one can write to.
  let target: { sessionKey?: string; name?: string } | undefined;
  try {
    const r = await httpJson<{ topic?: { sessionKey?: string; name?: string } }>(
      args, "GET", `/api/topics/${encodeURIComponent(toolArgs.topic_id)}`, undefined, fetchImpl,
    );
    target = r?.topic;
  } catch (err: unknown) {
    // A 404 is "not found", said below in the tool's own words; anything else
    // (server down, 500) is the transport's problem and stays its message.
    if (!/^HTTP 404\b/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  if (!target?.sessionKey) {
    throw new Error(`send_chat_message: topic '${toolArgs.topic_id}' not found`);
  }
  // Guard against self-loops: a session messaging itself would recurse.
  if (target.sessionKey === args.sessionKey) {
    throw new Error("send_chat_message: refusing to message your own session — reply normally instead");
  }
  const read = await postChatReadSSE(args, target.sessionKey, toolArgs.message, fetchImpl, toolArgs.topic_id);
  if (read.held) {
    return `send_chat_message: the project of topic ${toolArgs.topic_id} is paused, so the message is held and goes out by itself when the project is resumed. Its reply will not come back to this call: do not send it again, see read_chat_messages(topic_id="${toolArgs.topic_id}") later.`;
  }
  if (read.complete && read.end) throw new Error(unfinishedTurn(read.end, read.text, toolArgs.topic_id));
  const reply = read.complete
    ? read.text
    : await awaitTurnEndAndReadReply(args, toolArgs.topic_id, target.sessionKey, read.messageId, fetchImpl, wait);
  if (!reply) {
    return `Sent to "${target.name ?? toolArgs.topic_id}". The turn produced no text reply (it may have only run tools) — use read_chat_messages(topic_id="${toolArgs.topic_id}") to inspect.`;
  }
  return reply;
}

type ListedRow = { role?: string; content?: string; partial?: boolean; latencyMs?: number; endReason?: string; blocks?: Array<{ kind?: string; text?: string }> };

/** How the boot sweep's restart notice opens (`RESTART_INTERRUPTED_MARKER`, lib/boot-partial-sweep.ts). */
export const RESTART_NOTICE_OPENING = "Turno interrotto da un riavvio del server";

/** The error verdict a row carries, if any. */
const verdictOf = (row: ListedRow | undefined) => row?.blocks?.find((b) => b?.kind === "error")?.text;

/**
 * The rows a restart cut: the ones the boot sweep closed say so (`endReason`).
 * Before that field, for each restart notice: the turn's own row, the first
 * answer (not a service line) after the person's message before it, when no
 * completion closed it (no latency). Only for a turn with no `endReason` at all.
 */
function rowsCutByRestart(rows: ListedRow[]): Set<number> {
  const cut = new Set<number>();
  rows.forEach((row, i) => {
    if (row.endReason === "cut-by-restart") cut.add(i);
    if (row.role !== "assistant" || !`${row.content ?? ""} ${verdictOf(row) ?? ""}`.includes(RESTART_NOTICE_OPENING)) return;
    let asked = i - 1;
    while (asked >= 0 && rows[asked].role !== "user") asked--;
    if (rows.slice(asked + 1, i).some((r) => r.endReason)) return;
    let turn = asked >= 0 ? asked + 1 : -1;
    while (turn > 0 && turn < i && rows[turn].blocks?.some((b) => b?.kind === "background-notice" || b?.kind === "machine-stop")) turn++;
    if (turn > 0 && turn < i && rows[turn].role === "assistant" && rows[turn].latencyMs == null && !verdictOf(rows[turn])) cut.add(turn);
  });
  return cut;
}

/**
 * What `content` alone does not say about a row: a turn that ended badly, one
 * still being written, one a restart cut. The last carries nothing of its own
 * (the person reads the restart notice after it, one notice is enough).
 */
function turnNote(row: ListedRow, cutByRestart: boolean): string | undefined {
  if (row.role !== "assistant") return undefined;
  const verdict = verdictOf(row);
  // A notice row is its own verdict: its content already says it.
  if (verdict) return (row.content ?? "").includes(verdict) ? undefined : `ended badly: ${verdict}`;
  if (row.partial) return "still being written";
  return cutByRestart ? "cut by a server restart before it finished" : undefined;
}

export async function callReadChatMessages(
  args: ParsedArgs,
  toolArgs: { topic_id?: unknown; limit?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.topic_id !== "string" || !toolArgs.topic_id) {
    throw new Error("read_chat_messages: 'topic_id' (string) is required");
  }
  const limit = typeof toolArgs.limit === "number" && toolArgs.limit > 0
    ? Math.min(Math.floor(toolArgs.limit), 200)
    : 30;
  const path = `/api/topics/${encodeURIComponent(toolArgs.topic_id)}/messages?limit=${limit}`;
  const body = await httpJson<{ messages?: ListedRow[]; topicName?: string }>(
    args, "GET", path, undefined, fetchImpl,
  );
  const msgs = Array.isArray(body?.messages) ? body!.messages : [];
  const cut = rowsCutByRestart(msgs);
  const compact = msgs.map((m, i) => {
    const note = turnNote(m, cut.has(i));
    return {
      role: m.role ?? "?",
      // Cap each message so a long transcript doesn't blow the tool-result budget.
      content: (m.content ?? "").slice(0, 4000),
      ...(note ? { note } : {}),
    };
  });
  return JSON.stringify({ topic: body?.topicName, count: compact.length, messages: compact }, null, 2);
}
