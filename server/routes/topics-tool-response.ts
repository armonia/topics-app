import { recentActiveRows, rowCarryingAsk, rowCarryingTool, type AskHaystackRow } from "../lib/ask-answer-routing";
import { patchLiveTool } from "../lib/turn-body-flush";
import type { AppContext, RouteHandler, Topic, ToolCall } from "../types";
import { type AIProvider } from "../providers";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { deliverAnswer, hasPendingAsk, openAskIdentity, ASK_NOT_CURRENT_LINE } from "../lib/ask-user-bridge";
import { storedToolCall, routeAnswer, liveQuestionCallId, questionTexts, answerAsNextMessage, type StoredQuestionCall } from "../lib/question-outlives-asker";
import { type AnswerRelay } from "../lib/answer-relay";
import { markAnswerOwed } from "../lib/owed-answers";
import { isPlanApprovalAnswer } from "../lib/plan-approval";
import { decodeCol } from "../../shared/message-blob";

/** POST /api/chat/tool-response: resume a paused AskUserQuestion / MCP elicitation. */
export function createToolResponseRoutes(
  ctx: AppContext,
  deps: {
    resolveProvider: (topic?: Topic | null) => AIProvider;
    answerRelay: AnswerRelay;
  },
): RouteHandler {
  const { resolveProvider, answerRelay } = deps;
  const { broadcastToAll, getTopicBySessionKey, updateToolCallFields, readJSON, json, errorResponse, db } = ctx;
  /** How far back an answer looks for its question when the short window misses it. */
  const QUESTION_LOOKBACK_ROWS = 400;

  return async function toolResponseRoutes(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Tool response (resume a paused AskUserQuestion / MCP elicitation) ---
    //
    // Companion endpoint to the `onUserInputRequired` callback wired into
    // the stream handler above. The provider has paused the turn waiting
    // for a `tool_result` block on its stdin; we validate the submission
    // against the still-pending request on its side, persist the user's
    // answer onto the assistant message's tool_calls blob (so the
    // exchange survives reload), and ask the provider to inject the
    // result. Status transitions waiting_for_input → running; the next
    // `tool_result` from the CLI will flip it to success/error normally.
    if (method === "POST" && pathname === "/api/chat/tool-response") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      const toolCallId = body?.toolCallId;
      const response = body?.response;
      if (!sessionKey || !toolCallId || !response || typeof response.kind !== 'string') {
        return errorResponse(400, "sessionKey, toolCallId, and response{kind,...} required");
      }
      // The global coordinator deliberately exposes no approval/elicitation
      // tools. Do not let a direct request reach the generic provider-resume
      // path, especially if a raw registry row has been corrupted to another
      // provider.
      if (isGlobalOrchestratorSession(db, sessionKey)) {
        return json({
          error: "the global coordinator does not accept generic tool responses",
          code: "orchestrator_topic_invariant",
        }, 403);
      }

      // --- Bridge ask path: mcp__topics__ask_user_question ---
      // The Topics MCP bridge tool answers through the bridge subprocess'
      // OWN JSON-RPC response (see server/lib/ask-user-bridge.ts), NOT via a
      // stdin `tool_result` line. A blocked bridge handler for this session
      // means THIS session's pending input IS the bridge ask (the CLI blocks
      // the turn on one ask at a time), so route the answer to the rendez-vous
      // and skip the provider stdin path entirely. Without this, the answer
      // would be written to stdin AND returned by the bridge — a double result
      // that desyncs the transcript.
      // Il tool che si sta rispondendo È il pannello del bridge?
      //
      // `hasPendingAsk` legge una mappa IN MEMORIA, e quella mappa si svuota a
      // ogni riavvio del server mentre il figlio continua a pollare imperterrito
      // (le sue gambe ripartono da sole). In quella finestra la risposta
      // dell'umano cadeva nel ramo di sotto — stdin del provider — dove nessuno
      // la aspetta: il pannello restava su «Invio…» per sempre e la risposta si
      // perdeva. Osservato il 4 agosto su topic:ed2070df, con la POST arrivata
      // al server e il figlio che continuava a chiedere.
      //
      // Il nome del tool è un fatto della RIGA, non della memoria di questo
      // processo: se è il pannello, la risposta va al rendez-vous — che se non
      // c'è nessuno in ascolto la mette da parte per la gamba successiva
      // (`deliverAnswer` bufferizza apposta).
      // NOT ONLY THE LAST ROW - the rule and its measurement live in
      // `lib/ask-answer-routing.ts`. The window is short on purpose: the
      // question being answered belongs to this exchange, and a scan of the
      // whole session would cost a table walk per answer.
      //
      // A QUESTION IS NOT LOST TO THE WINDOW. It now outlives its turn, and the
      // machine turns after it (a relaunch, a goal nudge, a command's wake) can
      // push it past the last twenty rows: found nowhere, the answer went to
      // the provider's stdin path and died there (503/404) while the row stayed
      // `waiting_for_input`. Only when the short window misses it, the lookup
      // looks further back.
      const recentRows = (() => {
        try {
          const rows = recentActiveRows(ctx, sessionKey);
          if (response.kind !== 'questions' || rowCarryingTool(rows, toolCallId, decodeCol)) return rows;
          return recentActiveRows(ctx, sessionKey, QUESTION_LOOKBACK_ROWS);
        } catch { return [] as AskHaystackRow[]; }
      })();
      const askRowId = response.kind === 'questions' ? rowCarryingAsk(recentRows, toolCallId, decodeCol) : null;
      // EVERY WRITE OF THIS ROUTE GOES ON THE ROW THAT CARRIES THE TOOL, by id,
      // whatever the tool: a question, the outbound gate's confirmation painted
      // on its `send_mail` row, a plan, a provider's paused tool. The last row
      // is that row only while nothing was written after it: a sweep notice, a
      // resend, a woken turn (card 1046df0b). `null` means the tool was never
      // announced in the window, and then nothing is written: never "the last
      // row" instead.
      const toolRowId = rowCarryingTool(recentRows, toolCallId, decodeCol);
      // And in the timeline of the turn that asked, if it still writes: its
      // next write rewrites the row from there (lib/turn-body-flush.ts).
      const patchToolRow = (patch: Partial<ToolCall>) => {
        if (!toolRowId) return;
        updateToolCallFields(sessionKey, toolCallId, patch, { rowId: toolRowId });
        patchLiveTool(sessionKey, toolCallId, patch);
      };
      const answeringBridgeAsk = response.kind === 'questions' && (hasPendingAsk(sessionKey) || askRowId !== null);
      if (answeringBridgeAsk) {
        // AND THE ANSWER NAMES THE QUESTION, here too.
        //
        // The rendez-vous is keyed by SESSION, not by question: until now an
        // open ask was enough, and the `toolCallId` of the clicked panel only
        // decided WHETHER that row is a bridge panel, never FOR WHICH question.
        // With two panels on screen - the send confirmation that is waiting,
        // and the generic ask the gate parks whose form the stream detector has
        // already painted - the yes given to the generic one was delivered to
        // the SEND: measured with both real routes and no card, the send refused
        // with "the answer that came back was not about this message" and the
        // generic question stayed unanswered. One click, two questions damaged.
        //
        // The board road already has this rule (`answerTo`, routes/tasks.ts):
        // the yes belongs to THAT question. When nobody named a panel
        // (`undefined`) the answer is delivered as it always was - that is the
        // generic leg, which only reaches the wait when no confirmation of this
        // session holds the gate's lock, so its question is the only one that
        // can be waiting.
        //
        // Since 30/09 the rule is total: the click is bound to the panel's id
        // from here to the model (`routeAnswer`). A live leg takes it only if it
        // is the leg of THAT question; an answer to a question whose asker is
        // gone never goes to another question's leg (it went, and the model
        // read the answer to A as the result of B), it is queued as a message.
        const asked: StoredQuestionCall | null = askRowId ? storedToolCall(recentRows, toolCallId, decodeCol) : null;
        const open = openAskIdentity(sessionKey);
        const route = routeAnswer({
          toolCallId,
          clicked: asked,
          open,
          legCallId: open && !open.toolCallId ? liveQuestionCallId(recentRows, open.questions, decodeCol) : null,
        });
        if (route === 'not-current') {
          // Nothing delivered and NO wait killed: the live one stays live and
          // the person can still answer the right panel. The 409 reaches the
          // form as an inline error (`ToolInputForm` shows the ApiError
          // message), which is the opposite of the silence it replaces. The
          // same for a panel already answered or ended (another window, a
          // phone that reconnected): delivering it would reopen a closed row
          // and hand the model an answer to nothing.
          return json({ error: ASK_NOT_CURRENT_LINE, code: "ask_not_current" }, 409);
        }
        const submittedAt = new Date().toISOString();
        const answers = (response.answers || {}) as Record<string, string>;
        const normalised = {
          kind: 'questions' as const,
          answers,
          metadata: response.metadata as Record<string, unknown> | undefined,
          submittedAt,
        };
        const topic = getTopicBySessionKey(sessionKey);
        // THE ASKER IS GONE: the turn that asked ended, the server restarted
        // under it, its child died. The question stayed open on purpose, and
        // the answer reaches the model as the next user message with the
        // question quoted (`lib/question-outlives-asker.ts`). The row says
        // `queued` BEFORE anything is sent: the panel reads "answered, on its
        // way", and a restart finds the answer owed (`lib/answer-relay.ts`).
        // No ask is ended here: an open one belongs to another question.
        const deliverAsMessage = (late: Record<string, string>) => {
          const queuedResponse = { ...normalised, answers: late };
          // With its entry in `owed_answers`, in one transaction: the boot
          // loads owed answers from there, whatever the question's age.
          ctx.db.transaction(() => {
            patchToolRow({ status: 'success', userResponse: queuedResponse, answerRelay: 'queued' });
            if (toolRowId) markAnswerOwed(ctx.db, { toolCallId, sessionKey, rowId: toolRowId });
          })();
          broadcastToAll({
            type: 'stream:tool_update', sessionKey, topicId: topic?.id, toolCallId,
            status: 'success', userResponse: queuedResponse, answerRelay: 'queued',
          });
          answerRelay.enqueue({
            sessionKey, toolCallId, rowId: toolRowId,
            content: answerAsNextMessage(questionTexts(asked), late),
          });
        };
        if (route === 'message') {
          deliverAsMessage(answers);
          return json({ ok: true, submittedAt, deliveredAs: 'message' });
        }
        // Unblock the bridge handler → it returns the answers as its tool
        // result → the CLI resumes the turn. Bound to this panel and its
        // questions: only a leg of this question collects it from the buffer,
        // and if none ever does (its asker died unmarked, or after the check
        // above) the buffer hands it to the delivery as a message instead of
        // dropping it.
        deliverAnswer(sessionKey, answers, {
          toolCallId,
          ...(asked ? { questions: questionTexts(asked) } : {}),
          onUnclaimed: deliverAsMessage,
        });
        // Forget the provider's pending entry so a reattach REPLAY won't
        // re-open the panel for an already-answered question. We intentionally
        // do NOT call resumeWithToolResponse — the bridge return is the result.
        try { resolveProvider(topic).clearPendingInput?.(sessionKey, toolCallId); } catch { /* provider gone; nothing to clear */ }
        // On the panel's own row: a question asked by a turn the watchdog had
        // already closed sits above the sweep's notice, and the last row does
        // not carry it (card 1046df0b). No row carries it: the answer is
        // delivered all the same, and nothing is written on the last row.
        patchToolRow({
          status: 'running',
          userResponse: normalised,
        });
        broadcastToAll({
          type: 'stream:tool_update',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          // THE STATUS TRAVELS, or the panel never switches off. The call
          // above writes it to the DB and this announcement used to stay
          // silent about it: the client entered only when a `partialResult`
          // was present, so the transition reached nobody and the form sat on
          // its spinner until a reload. See `toolUpdatePatch` on the client.
          status: 'running',
          userResponse: normalised,
        });
        return json({ ok: true, submittedAt });
      }

      // --- Approvazione di un piano ---
      // Non c'è nessun tool sospeso da sbloccare: il turno è già finito, e la
      // domanda l'ha messa Topics a fine turno perché la CLI in plan mode non
      // ha più `ExitPlanMode` per chiederla (vedi server/lib/plan-approval.ts).
      // Qui si registra solo la risposta; a far ripartire il lavoro è il client,
      // che manda un turno nuovo con l'autonomia giusta — la stessa strada di
      // qualunque altro messaggio, invece di un secondo modo di avviare turni.
      if (response.kind === 'questions' && isPlanApprovalAnswer(response)) {
        const submittedAt = new Date().toISOString();
        const topicForPlan = getTopicBySessionKey(sessionKey);
        patchToolRow({
          status: 'success',
          userResponse: { ...response, submittedAt },
        });
        broadcastToAll({
          type: 'stream:tool_update',
          sessionKey,
          topicId: topicForPlan?.id,
          toolCallId,
          // This is the ONLY announcement that will ever arrive: the plan
          // hangs off a tool already finished, which Topics back-marks at the
          // end of the turn, so no provider will emit a `stream:tool_result`
          // for this id. Without the status in here the plan panel spun
          // forever while the new turn scrolled underneath.
          status: 'success',
          userResponse: { ...response, submittedAt },
        });
        return json({ ok: true, submittedAt });
      }

      // Provider lookup mirrors abort: O(1) by sessionKey instead of a topics scan.
      const topic = getTopicBySessionKey(sessionKey);
      const provider = resolveProvider(topic);
      if (!provider.connected || !provider.resumeWithToolResponse) {
        // Fail the tool fast — the route never leaves a waiting_for_input
        // status orphaned on the row.
        const errMsg = provider.resumeWithToolResponse
          ? `provider ${provider.name} is not connected`
          : `provider ${provider.name} does not support user input`;
        patchToolRow({
          status: 'error',
          error: errMsg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: errMsg,
        });
        return errorResponse(503, errMsg);
      }

      const submittedAt = new Date().toISOString();
      // Normalize the payload — accept partial shapes from the client so
      // a forgetful caller (no `submittedAt`) still gets a record we can
      // persist and replay.
      const normalised =
        response.kind === 'questions'
          ? {
              kind: 'questions' as const,
              answers: (response.answers || {}) as Record<string, string>,
              metadata: response.metadata as Record<string, unknown> | undefined,
              submittedAt,
            }
          : response.kind === 'elicitation'
            ? { kind: 'elicitation' as const, value: response.value, submittedAt }
            : response.kind === 'raw'
              ? { kind: 'raw' as const, text: String(response.text ?? ''), submittedAt }
              : null;
      if (!normalised) {
        return errorResponse(400, `unsupported response kind: ${String(response.kind)}`);
      }

      try {
        await provider.resumeWithToolResponse(sessionKey, toolCallId, normalised);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Provider rejected (no pending input, process dead, stdin write
        // failed). Flag the tool as errored so the UI unblocks; the next
        // user turn can retry from scratch.
        patchToolRow({
          status: 'error',
          error: msg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: msg,
        });
        // 404 specifically for "no pending input" so the client can show
        // a friendly "this question was already answered" toast.
        const status = /no pending input/i.test(msg) ? 404 : 502;
        return errorResponse(status, msg);
      }

      patchToolRow({
        status: 'running',
        userResponse: normalised,
      });
      broadcastToAll({
        type: 'stream:tool_update',
        sessionKey,
        topicId: topic?.id,
        toolCallId,
        // No partialResult - this is just a status transition. The next
        // tool_result event will carry the actual content from the model.
        //
        // But the transition NOW travels. This announcement used to carry the
        // id alone, and the client entered only when a `partialResult` was
        // present: the transition never arrived, and the panel sat on its
        // spinner for the whole duration of the tool instead of an instant.
        status: 'running',
        userResponse: normalised,
      });

      return json({ ok: true, submittedAt });
    }

    return null;
  };
}
