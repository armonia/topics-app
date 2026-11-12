/**
 * Chat streaming engine — the POST /api/chat handler, extracted verbatim from
 * the topics.ts god-file. This is the streaming chat-proxy core: resolve the
 * topic/provider, assemble context, open an SSE writer, drive the provider
 * stream (WS-preferred with an HTTP-SSE fallback), dispatch inline markers
 * (browser / topic-switch / project) and server-side browser tool calls, track
 * soft/hard inactivity timeouts, persist blocks/tool-calls, and finalize the
 * assistant message.
 *
 * Pattern mirrors edit.ts/history.ts/autoname.ts: a dependency-injected
 * sub-router instantiated INSIDE createTopicsRouter, receiving the closure-local
 * helpers it needs (see ChatDeps) by reference. The only SHARED mutable state it
 * touches is `browserNavigatedTopics` (the localhost-auto-navigate dedupe Set),
 * passed in as the same instance so the dedupe contract still spans the marker
 * helper + the open-pane route. Behaviour is a verbatim move — only the route
 * dispatch wrapper changed.
 */
import type { ChatTurnScope } from "./chat-turn-scope";
import { prepareTurnMessages, takeTurnCheckpoint } from "./chat-prepare";
import { assembleTurnContext } from "./chat-context";
import { resolveTurnProvider } from "./chat-provider";
import { createFailureHandlers } from "./chat-failure";
import { setupTurnStream } from "./chat-stream-setup";
import { armTurnTimers } from "./chat-timers";
import { createFinalizeStream } from "./chat-finalize";
import { createStreamHandler } from "./chat-handler";
import { createUsageCapture } from "./chat-usage";
import { runProviderTurn } from "./chat-run";
import { runHttpFallback } from "./chat-fallback";
import type { AppContext, RouteHandler, Topic } from "../types";
import { repeatedRowMarks, userRowMarks } from "../lib/user-row-marks";
import { getProvider, type AIProvider } from "../providers";
import { hasPendingAsk } from "../lib/ask-user-bridge";
import { recentActiveRows } from "../lib/ask-answer-routing";
import { askerStillThere, openQuestionsOnRows } from "../lib/question-outlives-asker";
import { type AnswerRelay, type Carry } from "../lib/answer-relay";
import { TopicsRoutingIncompatibleError } from "../providers/resolve-topic-provider";
import { commandWakeState } from "./processes";
import { goalContinuationForChatRoute, type ChatGoalLoop } from "../services/goal-continuation";
import { resumeAttemptOf } from "../lib/ripresa-boot";
import { autoreDaIdentita } from "../lib/message-author";
import type { BrowserService } from "../browser-service";
import { decodeCol } from "../../shared/message-blob";
import { isInternalRequest } from "../lib/abort-cause";
import { agentAuthOk } from "../lib/agent-auth";
import { getSubagentBySessionKey } from "../lib/subagent-store";
import { stopTurnBodyOf } from "../lib/turn-body-flush";

/** This handler writes the timeline: see `toolColumnWriteMode` in server/utils.ts. */
const MIRRORED = { mirroredInBlocks: true } as const;
import { type ControlDispatchDeps } from "../control-tools";
import { resolveTabRef } from "../lib/tab-resolver";
import { tabResolverDeps } from "../lib/tab-resolver-deps";
// `stripSlowAnnotation` resta: non lo appende piu' nessuno, ma `fullContent` puo'
// essere seminato da un messaggio parziale RILETTO dal DB (reattach, hot-reload
// con due server in volo), e quello puo' ancora portarla. Toglierlo qui
// riesumerebbe l'annotazione nel contenuto finale.
import { crashedTurnNotice, shortErrorDetail } from "./crashedTurnNotice";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { planModeFor } from "../lib/autonomy-mode";
import { turnEnded, turnStarted } from "../attention/store";
import { withCommandTask } from "../attention/background-tasks";
import { classifyTurnEnd } from "../push-triggers";
import { runningTaskOwnsTopic } from "../lib/wake-adoption";
import { sessionAttentionBackground } from "../providers/background-probes";
import { topicSubject, type AttentionTaskMap } from "../../shared/attention";
import { isSideQuestionTopicId } from "../../shared/chat-fork";
import { createIdempotencyCache } from "../lib/idempotency-cache";
import { keyTakenBy, rowStoredUnderKey } from "../lib/client-message-key";
import {
  isEligibleGlobalOrchestratorSession,
  isGlobalOrchestratorTopic,
} from "../services/global-orchestrator-session";
import type { LifecycleHookRunner } from "../services/lifecycle-hooks";
import { subagentWakeState } from "../lib/subagent-runtime";
import {
  noteSteerFailed, noteSteerMessage, offerSteer, setSteerSink, steerState, type SteerItem, type SteerMeta,
} from "../lib/turn-steer";
import { onTurnEnded } from "../lib/turn-ended";

/**
 * The keys of the messages already taken, to recognise a resend: the fast
 * path. Half an hour, because a key is a uuid minted once per send, never a
 * fingerprint of the text. It lives in the process and a restart loses it, so
 * the table is asked next: the key is on the row (`lib/client-message-key.ts`).
 */
const chatIdempotency = createIdempotencyCache({ ttlMs: 30 * 60_000 });

/**
 * Closure-local helpers from createTopicsRouter that the /api/chat block needs,
 * injected by reference (they keep their own closures, so their transitive deps
 * stay in topics.ts). `browserNavigatedTopics` is shared mutable state — pass
 * the SAME Set instance the marker helper + open-pane route use.
 */
export interface ChatDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
  /** Resolver for an explicitly named provider, injectable for the same path
   * used by headless reattach and woken turns. */
  resolveProviderByName?: (name: string) => AIProvider;
  detectLocalhostAutoNav: (content: string, topic: Topic | null) => string;
  bindTopicToProject: (topicId: string, targetDir: string, opts?: { focus?: boolean }) => boolean;
  resolveProjectRef: (ref: string, opts?: { trustRawPaths?: boolean }) => string | null;
  /** The project folders already known: they say where a new project is born. */
  knownProjectPaths?: () => string[];
  getProjectIdForTopic: (topicId: string) => string | null;
  getWorkspaceProjects: () => string[];
  autoBindProject: (topic: Topic) => void;
  watchSessionForSubagents: (topicId: string, sessionKey: string) => void;
  updateUnreadCount: (topicId: string) => void;
  browserNavigatedTopics: Set<string>;
  WORKSPACE_DIR: string;
  /** The SSE ping's interval (`lib/sse-ping.ts`); tests only, the real one is 20 s. */
  ssePingMs?: number;
  /**
   * The user's `turn-end` hook (HOOKS-02). Fired by this route AFTER the
   * stream is finalised, never awaited: the turn is over and the hook can
   * only add a line to the chat. Native runtime only.
   */
  hooks?: LifecycleHookRunner;
  goalLoop?: ChatGoalLoop; // when the caller holds it too (the Stop, the boot)
  /**
   * The answers owed to the model by questions whose asker is gone
   * (`lib/answer-relay.ts`). This route is where they are taken: the relay's
   * own message claims its answer, a person's message takes every owed answer
   * of the session and carries it in front of itself. Taken is not sent: the
   * turn that carries them settles them at the model's first event, or gives
   * them back if it never gets there.
   */
  answerRelay?: Pick<AnswerRelay, "claim" | "takeOwed" | "heard" | "notCarried">;
}

/**
 * I due ingredienti dello scope di `inline-sent-state`: quale conversazione CLI
 * stiamo servendo, e quante volte è stata compattata. Letture indicizzate su una
 * riga sola — trascurabili accanto al turno di modello che stanno per precedere,
 * e sempre best-effort: un errore qui deve costare una re-iniezione, non un send.
 */
function readClaudeSessionId(ctx: AppContext, sessionKey: string): string | null {
  try {
    const row = ctx.db
      .prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?`)
      .get(sessionKey) as { claude_session_id?: string } | undefined;
    return row?.claude_session_id ?? null;
  } catch {
    return null;
  }
}

function countCompactions(ctx: AppContext, sessionKey: string): number {
  try {
    const row = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM compaction_markers WHERE session_key = ?`)
      .get(sessionKey) as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function createChatRouter(ctx: AppContext, deps: ChatDeps, browserService?: BrowserService): RouteHandler {
  const {
    broadcastToAll, broadcastToTopicSubscribers, db, json, readJSON,
    getTopicBySessionKey, saveSingleTopic, touchTopicActivity,
    appendLocalMessage,
    createPartialMessage, reuseOrCreatePartialForReattach, reuseHeadstoneOrCreate, updateLastMessage, discardIfEmptyTurn, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamContent, updateStreamActivity, endStream, isStreaming,
    findNewMediaFiles, updateLastMessageWithMedia,
  } = ctx;

  /**
   * A NEW MESSAGE SUPERSEDES A QUESTION NOBODY IS WAITING ON ANY MORE.
   *
   * A question outlives the turn that asked it (`lib/question-outlives-asker.ts`), so it
   * can still be on screen when the person writes something else instead of
   * answering. That message is the person's choice, and the standard's third
   * way to end a question: the panel is closed as `superseded`, and it says so
   * in plain words instead of inviting a click that would now arrive AFTER a
   * newer request. A question whose asker may still be there (a live ask, no
   * `askerGone` mark) is left alone: the composer answers those.
   *
   * Only a message a PERSON sent: the caller skips the goal nudge, the
   * dispatcher's envelope, a command's wake and a resume, which would
   * otherwise close a person's question under the words "you sent a new
   * message instead".
   */
  function supersedeOpenQuestions(sessionKey: string, topicId: string | undefined): void {
    let open: ReturnType<typeof openQuestionsOnRows> = [];
    try { open = openQuestionsOnRows(recentActiveRows(ctx, sessionKey), decodeCol); } catch { return; }
    if (open.length === 0) return;
    const pendingAsk = hasPendingAsk(sessionKey);
    const endedAt = Date.now();
    for (const { rowId, call } of open) {
      if (askerStillThere({ pendingAsk, call })) continue;
      const error = "Superseded: a new message was sent instead of an answer";
      updateToolCallFields(sessionKey, call.id, { status: "error", askEnded: "superseded", error, endedAt }, { rowId });
      broadcastToAll({
        type: "stream:tool_result", sessionKey, topicId, toolCallId: call.id,
        status: "error", error, endedAt, askEnded: "superseded",
      });
    }
  }
  const {
    resolveProvider, resolveProviderByName = getProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef, knownProjectPaths,
    getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR, hooks,
    ssePingMs,
  } = deps;

  /**
   * Un evento di tool va a chi ha quella topic aperta, non a tutti.
   *
   * I chunk di contenuto e di thinking passavano gia' da
   * `broadcastToTopicSubscribers` (righe 1226, 1255, 2077-2078): gli eventi dei
   * tool erano gli unici rimasti su `broadcastToAll`, e su un turno agentico
   * sono le CENTINAIA di frame piu' grossi del turno — un `stream:tool_result`
   * porta il risultato intero. Ogni finestra aperta su un'altra topic li
   * riceveva tutti per scartarli: il client li instrada per `topicId` e li
   * butta. Su un desktop con tre finestre piu' la PWA in LAN sono tre copie di
   * troppo per frame.
   *
   * Non e' un cambio di semantica ma l'allineamento al resto della famiglia:
   * `clientReceivesTopicDelta` include comunque i client che non hanno ancora
   * dichiarato un insieme aperto, e chi non riceve piu' i tool di una topic non
   * ne riceveva GIA' il testo.
   *
   * Senza `topicId` (sessione non ancora legata a una topic) resta il broadcast
   * a tutti: non c'e' niente su cui instradare.
   */
  /**
   * THE GOAL LOOP'S ONE HANDLE ON THIS ROUTE.
   *
   * The wiring lives in `services/goal-continuation.ts`; what stays here is the
   * one thing only this scope can give it, the route itself. It is a named
   * function expression, whose name is in scope only inside its own body, so it
   * hands itself over on the first request it serves (see `selfRoute` below).
   */
  const goalLoop = deps.goalLoop ?? goalContinuationForChatRoute({
    ctx, resolveProvider, commandWakeState, subagentWakeState, log: (m) => console.log(`[goal] ${m}`),
  });

  const broadcastStreamToTopic = (message: OutboundMessage, topicId: string | undefined): void => {
    if (topicId) broadcastToTopicSubscribers(topicId, message);
    else broadcastToAll(message);
  };

  // Bump the topic's own timestamp on real activity — a new user message
  // (below) OR a completed/errored/timed-out assistant turn (via
  // finalizeTurnActivity). Without the latter, a turn that never round-trips
  // through a fresh POST /api/chat user message (autonomous continuation,
  // dispatched task) left the sidebar's lastActivity — and the project row
  // rolled up from it — frozen mid-conversation.
  //
  // Scrittura MIRATA su `updated_at`, non un upsert della riga intera: `topic`
  // qui è l'oggetto letto quando la richiesta è arrivata, e questo bump scatta
  // alla FINE del turno, anche venti minuti dopo. Riscrivere tutte le colonne
  // da quell'oggetto riportava indietro qualunque cosa il turno avesse cambiato
  // nel frattempo — in particolare `projectPath`, che `open_project` /
  // `create_project` scrivono a metà risposta: la chat si spostava nel progetto
  // e a fine turno si ritrovava fuori, slegata, senza un errore da nessuna
  // parte (card 76b0058b). Il broadcast porta la riga RILETTA, così i client
  // vedono lo stato vero e non la copia vecchia.
  const bumpTopicActivity = (topic: Topic): void => {
    if (isSideQuestionTopicId(topic.id)) return;
    const updatedAt = new Date().toISOString();
    topic.updatedAt = updatedAt;
    const fresh = touchTopicActivity(topic.id, updatedAt);
    if (fresh) broadcastToAll({ type: "topic:updated", topic: fresh });
  };

  // Every turn-finalization site (success / error / soft- or hard-timeout)
  // funnels through here so the activity bump and the unread bump stay in
  // lockstep — a new terminal path can't silently forget to refresh the
  // sidebar's lastActivity and leave the row looking frozen mid-turn.
  //
  // The unread goes up only for a turn that left a VISIBLE message
  // (notifications-redesign, T17, defect D7): an empty woken turn is thrown
  // away, and a badge with nothing behind it is a lie.
  const finalizeTurnActivity = (topic: Topic, opts: { visible?: boolean } = {}): void => {
    if (isSideQuestionTopicId(topic.id)) return;
    bumpTopicActivity(topic);
    if (opts.visible !== false) updateUnreadCount(topic.id);
  };

  /**
   * THE TURN, FOR THE ATTENTION STATE (notifications-redesign, design section
   * 4.2). Every `stream:start` and `stream:end` this route broadcasts is also
   * told to the attention store, the one place that decides whether the end
   * lights the chat, announces, pushes and writes a history row. The end is
   * classified by `classifyTurnEnd`, the gates the reply push used to apply on
   * the frame.
   */
  const startTurnAttention = (topic: Topic | null | undefined, boardAgent: boolean): void => {
    if (!topic || isSideQuestionTopicId(topic.id)) return;
    // Both read from the topic at every turn: a board agent's topic is born
    // archived and no archive path ever runs for it, and its woken turns carry
    // no `dispatched` (review 2 of notifications-redesign, B2).
    try { turnStarted(topicSubject(topic.id), { dispatched: boardAgent, archived: !!topic.archived }); } catch (err) { console.warn("[attention] turn start failed:", err); }
  };
  const endTurnAttention = (
    topic: Topic | null | undefined,
    frame: { messageId?: string; completed?: boolean; reason?: string; error?: string; stopCause?: string; stopReason?: string; dispatched?: boolean; discardedMessageId?: string },
    extra: { background?: AttentionTaskMap; preview?: string } = {},
  ): void => {
    if (!topic || isSideQuestionTopicId(topic.id)) return;
    try {
      const verdict = classifyTurnEnd({ completed: frame.completed, reason: frame.reason, error: frame.error, stopCause: frame.stopCause, stopReason: frame.stopReason, dispatched: frame.dispatched, discarded: !!frame.discardedMessageId });
      turnEnded(topicSubject(topic.id), {
        turnId: frame.messageId ?? null,
        outcome: verdict.outcome,
        detail: verdict.detail ?? (extra.preview ? extra.preview.trim().split("\n").find((l) => l.trim())?.slice(0, 140) ?? null : null),
        resumes: verdict.resumes,
        ...(extra.background ? { background: extra.background } : {}),
      });
    } catch (err) { console.warn("[attention] turn end failed:", err); }
  };
  /**
   * What the chat waits on as its turn ends (`attentionBackground`, design
   * section 5.2): the live tasks, the wake on its way, the non-recurring crons,
   * and the Topics commands still running. Null when no provider can tell.
   */
  const backgroundForAttention = (provider: unknown, sessionKey: string, ownWake?: string): { tasks: AttentionTaskMap; count: number; kinds: string[] } | null => {
    const own = (provider as { attentionBackground?: (sk: string) => { tasks: AttentionTaskMap; count: number; kinds: string[] } }).attentionBackground;
    let b: { tasks: AttentionTaskMap; count: number; kinds: string[] } | null = null;
    try { b = own ? own.call(provider, sessionKey) : sessionAttentionBackground(sessionKey); } catch { b = null; }
    const command = commandWakeState(sessionKey, ownWake);
    if (command === "none") return b;
    return withCommandTask(b?.tasks ?? {}, command, new Date().toISOString());
  };

  // Deps for the SDK-passthrough control tools (open/create-project, switch/new-
  // topic). Reuses the SAME closure-local project helpers + AppContext topic
  // ops the Layer-1 endpoints use, so a claude/openai tool call and an MCP tool
  // call land on identical side-effects + broadcasts.
  //
  // `resolveTab` chiude sulle STESSE deps della rotta `GET /api/tabs/resolve`
  // (`lib/tab-resolver-deps.ts`): l'agente via MCP e la chat SDK devono
  // rispondere la stessa cosa sullo stesso link, e il resolver è di sola lettura
  // — non tocca `ui_state`, non riflette niente nella history.
  const tabDeps = tabResolverDeps(ctx, browserService);
  const controlDispatchDeps: ControlDispatchDeps = {
    getTopicById: ctx.getTopicById,
    loadTopics: ctx.loadTopics,
    saveSingleTopic: ctx.saveSingleTopic,
    slugify: ctx.slugify,
    broadcastToAll,
    resolveProjectRef,
    bindTopicToProject,
    workspaceDir: WORKSPACE_DIR,
    listProjectDirs: knownProjectPaths,
    projectStore: ctx.projectStore,
    resolveTab: (ref) => resolveTabRef(ref, tabDeps),
  };

  /**
   * The author of a message this route sends on someone else's behalf (a
   * steered message the turn did not take): the request is a new object, so
   * the sender's identity, which the gate pinned to the original one, is
   * carried here instead.
   */
  const replayAuthors = new WeakMap<Request, SteerMeta["author"]>();
  const authorFor = (req: Request) => replayAuthors.has(req)
    ? replayAuthors.get(req) ?? undefined
    : autoreDaIdentita(ctx.db as never, ctx.requestIdentity?.(req) ?? null);
  /** A steered message still waiting for the turn, by its idempotency slot: a resend under the same key gets the same answer, not a second copy. */
  const pendingSteerBySlot = new Map<string, string>();

  /** Every steered row carries a key: the sender's, or the steer's own id, so writing it twice (a journal replayed after a restart) stores it once. */
  const steerKey = (item: SteerItem) => item.meta.key ?? item.id;
  /** What a steered message's own turn needs from its first request, if the running turn never reads it: who sent it and how to run it. */
  const replayFieldsOf = (body: Record<string, unknown>, sentByAgent: boolean): Record<string, unknown> => ({
    ...(sentByAgent ? { fromAgent: true } : {}),
    ...(typeof body.model === "string" && body.model.trim() ? { model: body.model } : {}),
    ...(typeof body.provider === "string" && body.provider.trim() ? { provider: body.provider } : {}),
    ...(body.fastMode === true ? { fastMode: true } : {}),
  });

  setSteerSink({
    taken(sessionKey, item) {
      const key = steerKey(item);
      pendingSteerBySlot.delete(`${sessionKey} ${key}`);
      let stored: ReturnType<typeof appendLocalMessage>;
      try {
        const marks = [
          ...(userRowMarks({
            dispatched: item.meta.dispatched, commentIds: item.meta.dispatchedFor,
            repeats: repeatedRowMarks(ctx.db, sessionKey, item.text),
          }) ?? []),
          // Read by the turn of `into`, though written after its row: the
          // resume sweep and the rebuilt history read this mark (CHAT-QUEUE-08).
          { kind: "steered" as const, ...(item.meta.into ? { into: item.meta.into } : {}) },
        ];
        stored = appendLocalMessage(sessionKey, "user", item.text, item.meta.author ?? undefined, marks, key);
      } catch (err) {
        const taken = keyTakenBy(err, ctx.db, sessionKey, key);
        if (taken) noteSteerMessage(sessionKey, item.id, taken);
        else console.warn(`[steer] ${sessionKey} ${item.id}: taken by the turn, row not written: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      chatIdempotency.remember(`${sessionKey} ${key}`, stored.id);
      noteSteerMessage(sessionKey, item.id, stored.id);
      const topicId = ctx.getTopicBySessionKey(sessionKey)?.id;
      if (topicId) {
        broadcastToAll({
          type: "message:new", topicId, sessionKey, role: "user",
          messageId: stored.id, content: item.text, preview: item.text.slice(0, 100),
          ...(stored.blocks?.length ? { blocks: stored.blocks } : {}),
          // The sender's window matches its own bubble by this key, as for any message.
          ...(item.meta.key ? { clientMessageId: item.meta.key } : {}),
        });
      }
      const topic = ctx.getTopicBySessionKey(sessionKey);
      if (topic) bumpTopicActivity(topic);
    },
    returned(sessionKey, item) {
      pendingSteerBySlot.delete(`${sessionKey} ${steerKey(item)}`);
      replayReturnedSteer(sessionKey, item);
    },
  });

  /**
   * The owed answers a request took (`lib/answer-relay.ts`), by request. A
   * request that ends without starting the turn that carries them (a refusal
   * after the gate, a throw, a provider it could not reach) gives them back
   * here, on every way out of the route, so none of them is lost to an exit
   * nobody thought of. Once the turn has started, its first model event or its
   * end decides instead.
   */
  const carries = new WeakMap<Request, Carry>();
  async function chatRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    try {
      return await routeChat(req, url, pathname, method);
    } finally {
      const carry = carries.get(req);
      if (carry && !carry.turnStarted) deps.answerRelay?.notCarried(carry);
    }
  }
  return chatRouter;

  /**
   * A message that joins the turn running on its session instead of waiting
   * for its end (`lib/turn-steer.ts`). Null when the turn there takes no
   * messages (not a native turn, or one adopted after a restart): the caller
   * answers the usual 409.
   *
   * The row is written when the loop TAKES the message (`steerSink.taken`),
   * not now: until then the model has not read it.
   */
  function steerIntoRunningTurn(
    req: Request,
    body: Record<string, unknown>,
    sessionKey: string,
    m: {
      idempotencyKey: string | null; idempotencySlot: string | null; dispatched: boolean;
      dispatchedFor: string[]; liveMessageId?: string; sentByAgent: boolean;
    },
  ): Response | null {
    const messages = body.messages as Array<{ role?: unknown; content?: unknown }> | undefined;
    const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
    const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
    // A slash command is a command to the route, not words for the model.
    if (!text.trim() || text.trim().startsWith("/")) return null;
    const offered = offerSteer(sessionKey, text, {
      key: m.idempotencyKey,
      dispatched: m.dispatched,
      dispatchedFor: m.dispatchedFor,
      author: authorFor(req) ?? null,
      into: m.liveMessageId ?? null,
      replay: replayFieldsOf(body, m.sentByAgent),
    });
    if (!offered) return null;
    if (m.idempotencySlot) pendingSteerBySlot.set(m.idempotencySlot, offered.id);
    console.log(`[HTTP] POST /api/chat 202 — steer ${offered.id} into the turn running on ${sessionKey}`);
    return json({ steered: true, steerId: offered.id, messageId: m.liveMessageId ?? null }, 202);
  }

  /**
   * The ordinary turn of a steered message the running turn did not take.
   * Sent when the session is free: a turn end is the signal, as for the
   * answer relay, and a timer backs it up for a refusal no turn end follows.
   * Somebody else's turn getting in first (`stream_in_flight`) waits for the
   * next try; five other refusals give up and say so on the status.
   */
  function replayReturnedSteer(sessionKey: string, item: SteerItem): void {
    const key = steerKey(item);
    const payload = JSON.stringify({
      ...(item.meta.replay ?? {}),
      sessionKey, messages: [{ role: "user", content: item.text }], clientMessageId: key,
      ...(item.meta.dispatched ? { dispatched: true } : {}),
      ...(item.meta.dispatchedFor.length ? { dispatchedFor: item.meta.dispatchedFor } : {}),
    });
    let failures = 0;
    let sending = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onTurnEnded((sk) => { if (sk === sessionKey) void attempt(); });
    const finish = () => { done = true; off(); if (timer) clearTimeout(timer); };
    const later = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void attempt(); }, ms);
      timer.unref?.();
    };
    const refused = (why: string) => {
      failures++;
      console.warn(`[steer] ${sessionKey} ${item.id}: ${why}`);
      if (failures >= 5) {
        finish();
        noteSteerFailed(sessionKey, item.id);
        console.warn(`[steer] ${sessionKey} ${item.id}: given up after ${failures} refusals`);
        return;
      }
      later(Math.min(60_000, 2_000 * 2 ** failures));
    };
    const attempt = async (): Promise<void> => {
      if (done || sending) return;
      if (isStreaming(sessionKey)) { later(5_000); return; }
      sending = true;
      try {
        // A chat archived or deleted meanwhile gets no turn from the machine, as in the resume sweep.
        const topic = ctx.getTopicBySessionKey(sessionKey);
        if (!topic || topic.archived) {
          finish();
          noteSteerFailed(sessionKey, item.id);
          console.warn(`[steer] ${sessionKey} ${item.id}: the chat is ${topic ? "archived" : "gone"}, not sent`);
          return;
        }
        const url = new URL("http://localhost/api/chat");
        const req = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
        replayAuthors.set(req, item.meta.author);
        const resp = await chatRouter(req, url, "/api/chat", "POST");
        if (resp?.ok) {
          finish();
          const reader = resp.body?.getReader();
          if (reader) void (async () => { while (!(await reader.read()).done) { /* drain */ } })().catch(() => {});
          const row = chatIdempotency.lookup(`${sessionKey} ${key}`) ?? rowStoredUnderKey(ctx.db, sessionKey, key);
          if (row) noteSteerMessage(sessionKey, item.id, row);
          console.log(`[steer] ${sessionKey} ${item.id}: not taken by the turn, sent as a turn of its own`);
          return;
        }
        const answer = (await resp?.json().catch(() => null)) as { code?: unknown; messageId?: unknown } | null;
        if (resp?.status === 409 && answer?.code === "duplicate_message") {
          finish();
          if (typeof answer.messageId === "string") noteSteerMessage(sessionKey, item.id, answer.messageId);
          return;
        }
        if (resp?.status === 409 && answer?.code === "stream_in_flight") { later(5_000); return; }
        refused(`the chat route answered ${resp?.status ?? "nothing"} ${String(answer?.code ?? "")}`);
      } catch (err) {
        // Not a refusal the route wrote: a throw (a busy database on the row's
        // append). Called with `void`, it would end the process.
        refused(`the chat route threw: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        sending = false;
      }
    };
    void attempt();
  }

  async function routeChat(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // The goal loop resends through this very route: see `goalLoop`.
    goalLoop.useRoute(chatRouter);
    // What became of a steered message: `taken` (it joined the running turn),
    // `returned` (it went as a turn of its own), `pending`, or 404 when this
    // process does not know it (a restart).
    if (method === "GET" && pathname === "/api/chat/steer") {
      const sk = _url.searchParams.get("sessionKey") ?? "";
      const id = _url.searchParams.get("id") ?? "";
      const st = steerState(sk, id);
      return st ? json(st) : json({ error: "unknown steer id", code: "steer_unknown" }, 404);
    }
    if (method === "POST" && pathname === "/api/chat") {
      const turn = {
        MIRRORED, WORKSPACE_DIR, addToolCallToLastMessage, appendLocalMessage, authorFor, autoBindProject, backgroundForAttention,
        bindTopicToProject, broadcastStreamToTopic, broadcastToAll, broadcastToTopicSubscribers, browserNavigatedTopics, browserService,
        bumpTopicActivity, chatIdempotency, controlDispatchDeps, countCompactions, createPartialMessage, ctx, db, deps, detectLocalhostAutoNav,
        discardIfEmptyTurn, endStream, endTurnAttention, finalizeTurnActivity, findNewMediaFiles, getWorkspaceProjects, goalLoop, hooks, isStreaming,
        json, knownProjectPaths, readClaudeSessionId, req, resolveProjectRef, resolveProvider, reuseHeadstoneOrCreate,
        reuseOrCreatePartialForReattach, saveSingleTopic, ssePingMs, startStream, startTurnAttention, supersedeOpenQuestions, updateLastMessage,
        updateLastMessageWithMedia, updateStreamActivity, updateStreamContent, updateToolCallFields, updateToolCallResult, updateUnreadCount,
        watchSessionForSubagents,
      } as ChatTurnScope;
      console.log(`[HTTP] POST /api/chat received`);
      const body = await readJSON(req);
      turn.body = body;
      if (!body) return json({ error: "body required" }, 400);
      const sessionKey = body.sessionKey;
      turn.sessionKey = sessionKey;
      /**
       * IS THIS TURN THE BOOT RESUMING ITSELF, and for the how-manieth time?
       *
       * Read once, here, because two very different things need it: the
       * `ripreso` block on the row (which is how the next boot counts the
       * chain) and the `resumedBy` marker on `stream:start` (which is how the
       * chat on screen stops advising Retry while the resend is already
       * running). Read twice, they could disagree.
       */
      const resumeAttempt = resumeAttemptOf(body);
      turn.resumeAttempt = resumeAttempt;

      /**
       * THE SAME MESSAGE DOES NOT GET TAKEN TWICE.
       *
       * The client had a single rule for knowing whether a message had gone
       * out: `streamStarted`, which becomes true when `fetch` returns the
       * response. If the connection dies BEFORE that — and it does die,
       * because on this machine the server reloads on every save in
       * `server/` — from the client's view the server never received it.
       * But the two things that could have happened are opposite and look
       * identical from outside: (a) we died before writing the row, and
       * then the message is lost and needs resending; (b) we died after,
       * and then resending it duplicates it.
       *
       * Unable to tell them apart, the client picked a side: it kept the
       * message queued and hoped. Its drain's own comment says it plainly —
       * "keeping it here would mean resending it to a server that may have
       * already taken it". Measured on 2026-08-18: a message written during
       * a reload never arrived (zero rows, zero turns) and the page stayed
       * spinning; shortly before, another had shown "Message queued" while
       * having arrived just fine.
       *
       * With a key the doubt disappears: the client ALWAYS resends, and we
       * say whether we'd already taken it. The key is written ON the user row
       * (further below), the moment the message truly exists: the map, then
       * the table, answer for it, across a restart too.
       */
      const idempotencyKey =
        req.headers.get("x-idempotency-key")
        ?? (typeof body.clientMessageId === "string" && body.clientMessageId.trim() ? body.clientMessageId.trim() : null);
      turn.idempotencyKey = idempotencyKey;
      const idempotencySlot = idempotencyKey ? `${sessionKey} ${idempotencyKey}` : null;
      turn.idempotencySlot = idempotencySlot;
      // A steered message under this key is still waiting for its turn: the
      // resend gets the same answer, not a second copy in the model's history.
      const pendingSteer = idempotencySlot ? pendingSteerBySlot.get(idempotencySlot) : undefined;
      if (pendingSteer) {
        if (steerState(sessionKey, pendingSteer)?.state === "pending") {
          return json({ steered: true, steerId: pendingSteer, duplicate: true, messageId: null }, 202);
        }
        // Held, unknown or failed: the key is free again for the sender's own resend.
        pendingSteerBySlot.delete(idempotencySlot!);
      }
      if (idempotencySlot) {
        const already = chatIdempotency.lookup(idempotencySlot) ?? rowStoredUnderKey(ctx.db, sessionKey, idempotencyKey!);
        if (already) {
          console.log(`[HTTP] POST /api/chat: ripetizione di ${idempotencyKey} su ${sessionKey} — già preso come ${already}, non lo rifaccio`);
          return json(
            { error: "message already accepted", code: "duplicate_message", messageId: already },
            409,
          );
        }
      }
      // Turno guidato dalla board (runHeadlessTurn), non una chat umana: si
      // propaga sul `stream:end` di completamento così la push di fine risposta
      // lo esclude (vedi server/push-triggers.ts). Decine di turni d'agente = spam.
      const dispatched = body.dispatched === true;
      turn.dispatched = dispatched;
      // The card comments this envelope delivers, when the dispatcher is
      // resuming an agent on words somebody wrote while it was busy. Filtered
      // here rather than trusted: the body is input.
      const dispatchedFor: string[] = Array.isArray(body.dispatchedFor)
        ? (body.dispatchedFor as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      turn.dispatchedFor = dispatchedFor;
      // O(1) UNIQUE-index lookup — replaces a full topics scan per chat send.
      const matchedTopic = getTopicBySessionKey(sessionKey);
      turn.matchedTopic = matchedTopic;
      // A board agent's topic for the attention state (rule 2): the turn the
      // dispatcher sent, and every other turn of a topic its running card
      // owns, its CLI's own wakes, a reattach, a command's wake. Only the
      // dispatched one says so on the wire; the card is the subject of all.
      const boardAgentTurn = dispatched || (!!matchedTopic && runningTaskOwnsTopic(ctx.db, matchedTopic.id));
      turn.boardAgentTurn = boardAgentTurn;
      // The `before` snapshot of THIS turn, when one was taken: its label and
      // the folder it was taken in, held so the end-of-turn `after` reuses
      // exactly them. Recomputing the label from "the last user message" at
      // the end would read a message that may no longer be the last one.
      turn.turnCheckpointMark = null;
      // This is an exact registry lookup, never a title/provider/MCP-policy
      // inference. It also fences generic chat side-effect handlers so a
      // provider regression cannot broaden the focused board profile.
      const globalOrchestrator = !!matchedTopic && isGlobalOrchestratorTopic(ctx.db, matchedTopic.id);
      turn.globalOrchestrator = globalOrchestrator;
      const overrideProvider = typeof body.provider === "string" && body.provider.trim()
        ? body.provider.trim()
        : null;
      // Il modello di QUESTO turno, gia' qui perche' con lo switch acceso e' lui che il motore nativo deve poter servire, non quello pinnato sul topic. allow-italian: perche' e' letto prima del resolver
      const turnModelOverride = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : null;
      // Keep raw identity and usable capability distinct. A damaged registry
      // Topic never degrades into an ordinary chat: it has no project/file
      // authority, and it must not recover a default provider through fallback.
      if (globalOrchestrator && !isEligibleGlobalOrchestratorSession(ctx.db, sessionKey)) {
        return json({
          error: "global coordinator integrity is invalid; reopen it from the Kanban",
          code: "orchestrator_topic_invariant",
        }, 409);
      }
      if (globalOrchestrator && overrideProvider && overrideProvider !== "codex") {
        return json({
          error: "the global coordinator is Codex-only",
          code: "orchestrator_provider_required",
        }, 400);
      }
      // Resolve Codex before the user message is persisted. If it is not
      // available, fail explicitly rather than recording a turn that could
      // later be sent through a default/foreign provider.
      turn.forcedGlobalProvider = null;
      if (globalOrchestrator) {
        try {
          turn.forcedGlobalProvider = resolveProviderByName("codex");
        } catch {
          return json({
            error: "Codex is unavailable for the global coordinator",
            code: "codex_unavailable",
          }, 503);
        }
      }
      const requestedProviderId = overrideProvider ?? matchedTopic?.provider;
      turn.explicitProvider = null;
      // A REATTACH ADOPTS A TURN THAT IS ALREADY RUNNING, so the provider that
      // owns it is the one the caller names, taken as is: the routing switch
      // answers "who would run a NEW turn of this topic", and on 11/10 it
      // answered the native engine for a claude-haiku-5-5 chat whose CLI turn
      // had been running for four hours. The reattach after the restart was
      // refused (501 below), the turn kept going unseen, and its next question
      // never reached the screen.
      if (!turn.forcedGlobalProvider && body.mode === "reattach" && overrideProvider) {
        // Only an owner that can actually reattach: otherwise the ordinary
        // resolver below decides, and the 501 further down still speaks.
        try {
          const owner = resolveProviderByName(overrideProvider);
          if (typeof (owner as unknown as { reattach?: unknown }).reattach === "function") turn.explicitProvider = owner;
        } catch { turn.explicitProvider = null; }
      }
      if (!turn.forcedGlobalProvider && !turn.explicitProvider && requestedProviderId) {
        try {
          // AICTRL-01: anche un override PER MESSAGGIO passa dal resolver. Prima si prendeva il provider dal registry e basta, quindi con lo switch acceso bastava un override nel body per eseguire fuori dal motore nativo, in silenzio. allow-italian: nomina la porta laterale chiusa qui
          // Il topic non viene riscritto: la scelta del turno viaggia come topic SINTETICO e il pin resta quello che era. allow-italian: perche' si costruisce un topic finto
          turn.explicitProvider = resolveProvider(
            overrideProvider || turnModelOverride
              ? ({
                  ...(matchedTopic ?? {}),
                  provider: overrideProvider ?? matchedTopic?.provider ?? null,
                  model: turnModelOverride ?? matchedTopic?.model ?? null,
                } as Topic)
              : matchedTopic,
          );
          if (!turn.explicitProvider.connected) throw new Error("unavailable");
        } catch (err) {
          // AICTRL-01: this is the resolver call that actually runs whenever a
          // topic has a pinned provider (the common case) — the generic catch
          // below used to erase TopicsRoutingIncompatibleError into a plain
          // "provider_unavailable", losing its reason and code before the turn
          // even had a chance to be blocked correctly. Caught here, before the
          // user message is persisted, with the pinned provider/model untouched.
          if (err instanceof TopicsRoutingIncompatibleError) {
            return json({ error: err.message, code: err.code, provider: err.provider }, 409);
          }
          return json({
            error: `Provider "${requestedProviderId}" is unavailable. Connect it in Settings or choose another provider.`,
            code: "provider_unavailable", provider: requestedProviderId,
          }, 503);
        }
      }
      // Reset browser navigate tracking for this topic so new URLs can trigger
      if (matchedTopic) browserNavigatedTopics.delete(matchedTopic.id);
      // Il piano ha UNA leva sola, ed è l'autonomia della chat.
      //
      // C'erano due modi di chiedere un piano, e facevano cose diverse: un
      // interruttore nel composer che iniettava questo blocco di prompt — una
      // RICHIESTA, che il modello poteva ignorare, tenuta in localStorage e mai
      // sincronizzata — e il livello di autonomia `ask`, che passa
      // `--permission-mode plan` alla CLI, dove i file non si possono proprio
      // scrivere. Potevano contraddirsi a vicenda sullo stesso turno.
      //
      // L'interruttore è sparito; il blocco di prompt no, perché è quello che
      // dà al piano il formato che l'app poi sa leggere («## Plan / ## Summary»,
      // planModeContent). Adesso lo accende il livello di autonomia. Stessa
      // forma del Fast Mode qui sotto: flag per-turno OPPURE preferenza del
      // topic. Il flag resta accettato per i chiamanti headless (dispatcher,
      // bridge), che non hanno un composer da cui premere niente.
      const planMode = planModeFor({ turnFlag: body.planMode === true, autonomy: matchedTopic?.autonomyLevel });
      turn.planMode = planMode;
      // Fast Mode: per-turn flag OR per-topic persisted preference. Either is
      // enough to opt in. Resolution into an actual model id happens after
      // provider resolution below (the mapping is provider-dependent).
      const fastModeRequested = body.fastMode === true;
      const messages = body.messages;
      turn.messages = messages;
      /**
       * `reattach` NON porta un messaggio: adotta il turno che sta già girando
       * nel broker dopo un riavvio del server (`runHeadlessReattach` in
       * server.ts, `reattachSurvivingChatTurns`). Pretendere un `messages` non
       * vuoto lo respingeva con 400 — e il chiamante drenava quel JSON come se
       * fosse SSE, non trovava `[DONE]`, e riportava `end_turn`: un turno mai
       * iniziato, dichiarato finito bene. Tutta la macchina di reattach qui
       * sotto (`reuseOrCreatePartialForReattach`, il ramo `reattachFn`) era
       * quindi irraggiungibile.
       */
      const isReattach = body.mode === "reattach";
      turn.isReattach = isReattach;
      /**
       * `woken`: il turno che la CLI ha aperto DA SOLA — un `Monitor` che
       * consegna il suo evento (vedi `claude/woken-turn.ts`). Adotta un turno
       * già in corso senza portare un messaggio, come un riattacco: riga, SSE,
       * finalizzazione, usage e broadcast sono identici.
       *
       * Ma NON per la RIGA: `reattach` RIUSA quella del turno interrotto e la
       * svuota, quindi ha bisogno di un'istantanea da cui ripescare ciò che il
       * replay non ri-emette (`reattachMerge.ts`); un risveglio apre una riga
       * NUOVA, e quella istantanea gli incollerebbe addosso il turno prima —
       * osservato sulla chat 205d1fbb il 20/08, tre righe con gli stessi tool.
       * Quindi `adottaTurnoVivo` per chi CHIAMA, `isReattach` per la riga.
       */
      const isWoken = body.mode === "woken";
      turn.isWoken = isWoken;
      const adottaTurnoVivo = isReattach || isWoken;
      turn.adottaTurnoVivo = adottaTurnoVivo;
      // Typed by a person, not produced by the machine (goal nudge, dispatch, wake, resume).
      const sentByPerson = !isWoken && !isReattach && !dispatched && !body.goalNudge && !body.processExit && !body.subagentResults && !resumeAttempt;
      turn.sentByPerson = sentByPerson;

      if (!messages || !Array.isArray(messages) || (messages.length === 0 && !adottaTurnoVivo)) {
        return json({ error: "messages array required" }, 400);
      }
      // An agent, not a person: send_chat_message (fromAgent) or an agent credential.
      // Read from the request's authentication, never trusted from the body alone.
      const sentByAgent = !isInternalRequest(req) && (body.fromAgent === true || agentAuthOk(req));
      const subagentOfChat = getSubagentBySessionKey(ctx.db as never, sessionKey);
      // A native sub-agent's chat: whoever writes (a person, the resume,
      // send_to_agent), a message is the child's prompt, never a chat command.
      const nativeChildChat = subagentOfChat?.runtime === "topics";
      turn.nativeChildChat = nativeChildChat;
      // It is driven by its parent through send_to_agent: an agent writing
      // here would open a turn nobody owns and a second result.
      if (sentByAgent && nativeChildChat) {
        return json({ error: `this chat belongs to sub-agent ${subagentOfChat!.id}: its parent writes to it with send_to_agent(agent_id="${subagentOfChat!.id}")`, code: "subagent_chat" }, 409);
      }

      /**
       * UN TURNO PER SESSIONE.
       *
       * Questa era l'unica route mutante di sessione senza cancello: `edit.ts`
       * e `branches.ts` rispondono già 409 su stream attivo, la chat no. Due
       * POST sulla stessa sessione (due finestre sullo stesso topic, o l'umano
       * che scrive mentre un task dispatchato sta lavorando nella sua topic)
       * finivano entrambe in `startStream`, che SOVRASCRIVE la voce di
       * `activeStreams`: il `finally` del primo turno chiudeva il SECONDO, con
       * il messageId sbagliato. Costo doppio, e per un agente anche side effect
       * doppi — scrive gli stessi file due volte.
       *
       * Il 409 è il canale di STEERING della chat, ed è lo stesso patto che la
       * board ha già per i task (`dispatcher.resume` bufferizza il commento
       * umano e lo consegna al confine del turno): il client rimette il
       * messaggio IN TESTA alla coda (`requeueFront`/`unshiftTurn` in
       * `state/chatQueue.ts`, ramo `is409` di `useChat`) e lo spedisce appena
       * il turno in volo finisce. Prima quel ramo del client era codice morto —
       * nessun 409 su /api/chat esisteva in tutto il server.
       *
       * Not forever: the `[StaleStream]` sweep closes a turn whose child is dead,
       * or whose provider cannot say (no probe), and its entry leaves the map.
       * `reattach` è esente per costruzione — adottare il turno vivo È il suo
       * mestiere, e vale identico per `woken` (`adottaTurnoVivo`).
       */
      //
      // The gate asks the turn LEDGER (`lib/turn-ledger.ts`), not only
      // `activeStreams`: a turn the CLI opened by itself (a notification, a
      // cron fire) is registered in the map only at the model's first line,
      // seconds later, and a message let through in between was written into
      // that running turn (chat 33966f4e, 27/09). The resume sweep's own
      // resend passes the boot hold: resuming the interrupted turn is what that
      // hold waits for. The answer carries the turn's state, so the window that
      // queues the message waits for THAT turn's end.
      if (!adottaTurnoVivo) {
        const live = isStreaming(sessionKey);
        const ledgerOpen = ctx.turnLedger?.isOpen(sessionKey, { ignore: resumeAttempt > 0 ? ["boot"] : [] }) ?? false;
        if (live || ledgerOpen) {
          // STEER: the sender asked for its message to join the running turn
          // (`steer: true`, `lib/turn-steer.ts`), and that turn takes messages.
          if (body.steer === true) {
            const steered = steerIntoRunningTurn(req, body, sessionKey, {
              idempotencyKey, idempotencySlot, dispatched, dispatchedFor, liveMessageId: live?.messageId, sentByAgent,
            });
            if (steered) return steered;
          }
          console.log(`[HTTP] POST /api/chat 409 — turno già in volo su ${sessionKey} (messageId ${live?.messageId ?? "-"}, ledger ${ctx.turnLedger?.sourcesOf(sessionKey).join("+") || "-"})`);
          return json(
            {
              error: "a response is already streaming for this session", code: "stream_in_flight", messageId: live?.messageId,
              ...(ctx.turnLedger ? { turn: ctx.turnLedger.stateOf(sessionKey) } : {}),
            },
            409,
          );
        }
      }

      const lastUserMsg = messages[messages.length - 1];
      turn.lastUserMsg = lastUserMsg;
      /**
       * AN ANSWER THE PERSON GAVE EARLIER GOES FIRST.
       *
       * An answer to a question whose asker is gone is owed to the model as a
       * message (`lib/answer-relay.ts`). The relay posts it here when the
       * session's turn ends, but the composer drains what the person typed
       * meanwhile on the same `stream:end`, and whichever reached this gate
       * first won: measured 30/09, the model read "and after that deploy it"
       * before the answer given before it. So the answers are TAKEN here, in
       * the same synchronous stretch as the gate above and the row below:
       *   - the relay's own message claims its answer, and is refused
       *     (`answer_not_owed`) if a person's message carried it already;
       *   - a person's message takes every answer the session owes and writes
       *     them as their own rows first, and the model reads them first, in
       *     the same turn. A slash command is left alone: its text is a command.
       */
      /** The owed answers this message took: settled when its turn reaches the model (`carries`). */
      turn.carry = null;
      /** The rows of the answers this message carries, and their text, oldest first. */
      const carried: Array<{ rowId: string; content: string }> = [];
      turn.carried = carried;
      if (deps.answerRelay && lastUserMsg?.role === "user" && typeof lastUserMsg.content === "string" && lastUserMsg.content) {
        const claimedId = (body.questionAnswer as { toolCallId?: unknown } | undefined)?.toolCallId;
        if (typeof claimedId === "string") {
          turn.carry = deps.answerRelay.claim(sessionKey, claimedId);
          if (!turn.carry) return json({ error: "this answer has already reached the model", code: "answer_not_owed" }, 409);
          carries.set(req, turn.carry);
        } else if (sentByPerson && !lastUserMsg.content.trim().startsWith("/")) {
          turn.carry = deps.answerRelay.takeOwed(sessionKey);
          if (turn.carry) carries.set(req, turn.carry);
          for (const answer of turn.carry?.answers ?? []) {
            const stored = appendLocalMessage(
              sessionKey, "user", answer.content,
              authorFor(req),
              userRowMarks({ repeats: repeatedRowMarks(ctx.db, sessionKey, answer.content) }),
            );
            if (matchedTopic) {
              broadcastToAll({
                type: "message:new", topicId: matchedTopic.id, sessionKey, role: "user",
                messageId: stored.id, content: answer.content, preview: answer.content.slice(0, 100),
                ...(stored.blocks?.length ? { blocks: stored.blocks } : {}),
              });
            }
            carried.push({ rowId: stored.id, content: answer.content });
          }
        }
      }
      // What the model reads for this turn: the carried answers first.
      const turnUserContent: string = carried.length > 0
        ? [...carried.map((c) => c.content), lastUserMsg.content].join("\n\n")
        : lastUserMsg?.content ?? "";
      turn.turnUserContent = turnUserContent;
      const earlyPersist = prepareTurnMessages(turn);
      if (earlyPersist) return earlyPersist;
      // The opt-in checkpoint is the only await between the gate and `startStream`.
      if (turn.turnCheckpointMark) await takeTurnCheckpoint(turn);

      assembleTurnContext(turn);

      const earlyProvider = resolveTurnProvider(turn);
      if (earlyProvider) return earlyProvider;

      // Per-message override wins; otherwise the topic's persisted model is
      // used (set by the picker via PUT /api/topics/:id and broadcast as
      // topic:updated). Falls through to the provider default when both unset.
      const requestedModel = turnModelOverride
        ?? (typeof matchedTopic?.model === "string" && matchedTopic.model.trim() ? matchedTopic.model.trim() : undefined);

      // A catalog can be stale or incomplete. Keep the chosen ID: only the
      // provider can reject it. Silently using its default would run a different
      // model from the one shown on the task and in the composer.
      const overrideModel = requestedModel;
      turn.overrideModel = overrideModel;

      // ─── Fast Mode ────────────────────────────────────────────────────
      //
      // NON è più uno scambio di modello. Lo era: con il Fast acceso questa
      // route sostituiva il modello con quello «veloce» del provider (haiku),
      // che è l'opposto di ciò che la fast mode di Claude Code fa — stesso
      // modello (Opus), uscita più rapida, prezzo diverso. Un toggle che sotto
      // lo stesso nome faceva un'altra cosa, e in silenzio: chi lo accendeva
      // per andare più veloce si ritrovava un modello più debole.
      //
      // Ora la richiesta viaggia COME richiesta fino al provider, che la gira
      // alla CLI (`/fast on`) soltanto quando la CLI ha dichiarato di poterla
      // servire. Oggi non può: nelle chat giriamo `--print --input-format
      // stream-json`, cioè la via Agent SDK, e la CLI risponde
      // `fast_mode_disabled_reason: sdk_opt_in_required`. Il composer lo dice,
      // invece di far finta di aver fatto qualcosa — vedi providers/fast-mode.ts.
      //
      // Due opt-in, come prima: il flag per-turno del composer e la preferenza
      // persistita sulla topic.
      const fastModeActive = fastModeRequested || matchedTopic?.fastMode === true;
      turn.fastModeActive = fastModeActive;

      // ─── Streaming ───
      const useWS = turn.topicProvider.capabilities.has('streaming') && turn.topicProvider.connected;

      // Il modello che servirà DAVVERO questo turno, suffisso compreso.
      //
      // Senza pin sul topic `overrideModel` è `undefined`, e per l'anello del
      // contesto quello voleva dire «non lo so»: restava il nome NUDO che la
      // CLI riporta nei suoi eventi (`claude-opus-5`, mai `[1m]`), cioè 200k di
      // denominatore su una chat che gira a un milione. L'anello segnava pieno
      // a un quinto del vero. Il default del provider è il nome giusto: è lo
      // stesso che `spawnPersistentProcess` passa alla CLI.
      const spawnedModel = overrideModel ?? turn.topicProvider.defaultModel?.() ?? undefined;
      turn.spawnedModel = spawnedModel;
      console.log(`[Chat] useWS=${useWS}, sessionKey=${sessionKey}`);
      // La riga assistente di QUESTO turno, raggiungibile anche dal `catch` in
      // fondo: se schiantiamo dopo averla aperta, va chiusa lì — vedi
      // crashedTurnNotice.ts. Dichiarata fuori dal `try` apposta.
      turn.crashedPartialId = null;
      turn.stopPing = () => {}; // out here too: the last catch stops it
      createFailureHandlers(turn);
      const { readRowForNotice } = turn;
      // Dichiarato FUORI dal try apposta: anche il `catch` in fondo deve poterlo
      // chiudere. Chiuso non era, e il conto lo pagava un turno già finito —
      // un guasto sincrono nel montaggio finalizzava la riga, ma i timer del
      // watchdog restavano armati e due minuti dopo `handleGraceExpiry` la
      // riscriveva sopra con «Response timed out», cancellando il vero motivo.
      turn.streamState = "streaming";
      if (useWS) {
        // === WS-based chat: sends via chat.send, receives tool + text events ===
        try {
          setupTurnStream(turn);
          const { readable } = turn;

          armTurnTimers(turn);

          createFinalizeStream(turn);

          createStreamHandler(turn);

          createUsageCapture(turn);

          const earlyRun = await runProviderTurn(turn);
          if (earlyRun) return earlyRun;

          // Return SSE response — events will be pushed by the handler.
          // `no-transform` + `X-Accel-Buffering: no` tell every proxy in
          // the chain (vite-dev, electron, nginx) NOT to coalesce the
          // body into chunks of their own. Without these the user sees
          // the whole message arrive at once on stream-end instead of
          // progressive deltas.
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });

        } catch (err: any) {
          console.error(`[StreamWS] Unexpected error for ${sessionKey}:`, err);
          turn.stopPing();
          // Uscire di qui con un 502 e basta lasciava tre cose sul campo: la
          // riga assistente APERTA (e `partial` è il perno che il setaccio di
          // boot legge per decidere chi è vivo), lo stream registrato in
          // memoria — quindi la chat che gira per sempre nelle altre finestre —
          // e nessuna traccia del perché. Il 3 agosto quella riga è finita
          // etichettata «No response received. The AI service may be
          // temporarily unavailable»: generico, e falso, perché il guasto era
          // nostro. Si chiude qui, dicendo cosa è successo davvero.
          try {
            stopTurnBodyOf(turn.crashedPartialId);
            endStream(sessionKey);
            if (turn.crashedPartialId) {
              const notice = crashedTurnNotice(readRowForNotice(turn.crashedPartialId), err);
              // Il flag `partial` cade comunque: aperta, quella riga farebbe
              // credere a un turno in volo che non esiste più.
              if (notice) db.prepare("UPDATE messages SET content = ?, partial = 0, end_reason = 'error' WHERE id = ?").run(notice, turn.crashedPartialId);
              else db.prepare("UPDATE messages SET partial = 0, end_reason = 'error' WHERE id = ?").run(turn.crashedPartialId);
              if (matchedTopic) {
                const crashText = notice ?? `Errore interno di Topics: ${shortErrorDetail(err)}`;
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: crashText });
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: turn.crashedPartialId, reason: "error", error: crashText, ...(dispatched ? { dispatched: true } : {}) });
                endTurnAttention(matchedTopic, { messageId: turn.crashedPartialId, reason: "error", error: crashText, dispatched: boardAgentTurn });
              }
            }
          } catch (cleanupErr) {
            // La pulizia non deve mai coprire il guasto vero.
            console.error(`[StreamWS] anche la chiusura del turno è fallita su ${sessionKey}:`, cleanupErr);
          }
          return json({ error: "Gateway WS error: " + err.message }, 502);
        }

      } else {
        // === Fallback: HTTP SSE (original approach — no tool visibility) ===
        console.log(`[Stream] Using HTTP SSE fallback (provider ${turn.topicProvider.connected ? 'connected but no WS' : 'disconnected'})`);
        try {
          const earlyFallback = await runHttpFallback(turn);
          if (earlyFallback) return earlyFallback;
        } catch (err: any) {
          if (err.name === "AbortError") return json({ error: "Request timeout (5 min)" }, 504);
          return json({ error: "Gateway unreachable: " + err.message }, 502);
        }
      }
    }

    return null;
  }
}
