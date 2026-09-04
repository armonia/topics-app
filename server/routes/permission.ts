import type { AppContext, RouteHandler } from "../types";
import { waitForAnswer, cancelAsk, beginAsk, deliverAnswer, AskWaitError } from "../lib/ask-user-bridge";
import { createTaskService } from "../services/tasks";
import { routeAskToTaskThread, clearRoutedAskForSession } from "../services/board-ask-routing";
import {
  beginPermission,
  waitForDecision,
  deliverDecision,
  resolvePendingPermission,
  aliasPermission,
  cancelPermission,
  allowPendingPermissions,
  PermissionWaitError,
} from "../lib/permission-bridge";
import { decideGrantForTool, addToolGrant, listToolGrants, removeToolGrant } from "../lib/tool-grants";
import { decidePermissionPaint } from "../lib/permission-paint";
import { cliDecisionFor, decisionFreesSession, isPermissionDecision } from "../../shared/permission-decision";
import { sessionIsFree, switchSessionToFree } from "../lib/session-free-mode";
import { etichettaAutore } from "../lib/message-author";
import { logActivity } from "../db/activity-log";
import { decodeCol } from "../../shared/message-blob";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import type { PermissionDecision, ToolPermissionOutcome, ToolPermissionRequest } from "../../shared/types";

/**
 * IL CANALE UMANO: le quattro rotte con cui una CLI si ferma e aspetta una
 * persona, più le regole che le permettono di non fermarsi affatto.
 *
 *   POST /api/sessions/:sessionKey/ask-user             una gamba della domanda
 *   POST /api/sessions/:sessionKey/permission           una gamba del permesso
 *   POST /api/sessions/:sessionKey/permission-response  il click che decide
 *   GET/POST /api/tool-grants, DELETE /api/tool-grants/:pattern   «consenti sempre»
 *
 * Scorporate da server/routes/topics.ts, dove stavano in mezzo a una quarantina
 * di altri blocchi di rotta. Stanno insieme perché sono UN meccanismo: il
 * rendez-vous a gambe corte (chi chiede torna ogni pochi secondi invece di
 * tenere un socket muto aperto per minuti) e le tre uscite che ne derivano —
 * deciso / in attesa / annullato. Le regole di `/api/tool-grants` sono il ramo
 * che salta il rendez-vous: `allow_always` le scrive, la gamba del permesso le
 * legge per prima cosa.
 *
 * A differenza di autoname/history/edit questo router non ha bisogno di NIENTE
 * dalla closure di createTopicsRouter: solo `ctx` e i moduli qui sopra. Resta
 * comunque montato da lì, alla stessa posizione che il blocco aveva nel
 * dispatch — l'ordine fra rotte è comportamento, non stile.
 */
export function createPermissionRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey, saveSingleTopic, updateToolCallFields } = ctx;

  // The registry role remains recognizable even after a backing Topic has been
  // corrupted.  It never gets to use the generic human-approval bridge: the
  // coordinator's Codex-only profile has just the focused board tools, and a
  // raw row must not become an ordinary session merely because that invariant
  // no longer holds.
  const denyGlobalCoordinatorHumanBridge = (sessionKey: string): Response | null => {
    if (!isGlobalOrchestratorSession(ctx.db, sessionKey)) return null;
    return json({
      error: "the global coordinator does not use generic ask or permission bridges",
      code: "orchestrator_topic_invariant",
    }, 403);
  };

  // Le dipendenze dell'instradamento di una domanda nel thread di un task. Il
  // servizio dei task si costruisce qui e non si riceve, come fa la rotta dei
  // task: è una vista sul db, non uno stato, e due viste sullo stesso db sono
  // la stessa vista.
  const askRouting = {
    db: ctx.db,
    comment: (a: { taskId: string; projectId: string; content: string; options: string[] }) => {
      try {
        const svc = createTaskService(ctx.db);
        svc.addComment({
          taskId: a.taskId,
          author: "agent",
          content: a.content,
          projectId: a.projectId,
          questionOptions: a.options,
        });
        const task = svc.get(a.taskId, { projectId: a.projectId })?.task;
        if (task) broadcastToAll({ type: "task:updated", projectId: a.projectId, task });
        return true;
      } catch {
        // Il thread non ha accolto la domanda: il pannello nel tab resta, ed è
        // il ripiego giusto. Meglio una domanda raggiungibile in un posto solo
        // che una domanda che non esiste da nessuna parte.
        return false;
      }
    },
    deliver: (sessionKey: string, answers: Record<string, string>) => deliverAnswer(sessionKey, answers),
  };

  return async function permissionRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // POST /api/sessions/:sessionKey/ask-user
    //
    // One POLL LEG of the rendez-vous for the `mcp__topics__ask_user_question`
    // bridge tool. Called by the bridge subprocess when the model asks the human
    // a question; it blocks here for a few seconds and then answers one of three
    // ways: `{answers}` (the human submitted the panel, via
    // /api/chat/tool-response → deliverAnswer), `{pending:true}` (nobody has
    // answered yet — come straight back), or `{cancelled,reason}` (the ask is
    // over: aborted, superseded, or expired).
    //
    // WHY legs instead of one long block: the first live question died after
    // minutes with a socket connection error. A single request held open with
    // zero bytes flowing is exactly what an idle-socket timeout kills, and it
    // dies CLIENT-side, so no amount of server patience helps. Short legs always
    // come back; `beginAsk` keeps the TTL on the ask itself, not on the leg.
    //
    // The panel is NOT rendered from here — the CLI also emits a `tool_use` for
    // this call that the provider's detector turns into
    // `stream:tool_user_input_required`, so the UI is already showing the form
    // by the time we start waiting. We only supply the answer channel.
    {
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/ask-user");
      if (bySession && method === "POST") {
        const sk = decodeURIComponent(bySession.sessionKey);
        const denied = denyGlobalCoordinatorHumanBridge(sk);
        if (denied) return denied;
        const body = (await readJSON(req)) as { questions?: unknown; legMs?: unknown } | null;
        if (!Array.isArray(body?.questions) || body.questions.length === 0) {
          return json({ error: "questions (non-empty array) is required" }, 400);
        }
        // The CALLER picks the leg length: it's the one whose socket dies, so it
        // knows its own idle budget. Clamped so a bad value can't turn this back
        // into the long-poll that broke, nor into a busy loop.
        const legMs = typeof body.legMs === "number" && Number.isFinite(body.legMs)
          ? Math.min(Math.max(body.legMs, 100), 60_000)
          : undefined;
        const firstLeg = beginAsk(sk);
        if (!firstLeg) {
          // The ask outlived its TTL. Close it here rather than letting the
          // bridge poll on into the CLI child's own lifetime cap.
          cancelAsk(sk, "no answer: the question expired");
          clearRoutedAskForSession(sk);
          return json({ cancelled: true, reason: "ask_user_question: the question expired with no answer" });
        }
        // LA DOMANDA ESCE NEL THREAD DEL TASK, se questa sessione ne ha uno.
        // La chiamata è su OGNI gamba ma scrive una volta sola: il registro di
        // `routeAskToTaskThread` riconosce la domanda già aperta per questa
        // sessione e non la ripete. Le gambe sono lo stesso pannello, non
        // domande nuove, e un commento per gamba riempirebbe il thread di copie
        // ogni pochi secondi.
        //
        // Non sostituisce il pannello nel tab: lo affianca. Chi guarda la board
        // vede la domanda dove già risponde ai commenti, chi ha il tab aperto
        // continua a rispondere da lì, e la prima risposta che arriva chiude il
        // rendez-vous per entrambe le strade.
        try { routeAskToTaskThread(askRouting, { sessionKey: sk, questions: body.questions as never[] }); }
        catch { /* il pannello nel tab resta comunque */ }
        try {
          const answers = await waitForAnswer(sk, legMs !== undefined ? { timeoutMs: legMs } : {});
          return json({ answers });
        } catch (err: any) {
          // A leg expiring is the NORMAL case — the human is still reading.
          // Only a genuinely finished ask (cancelled/superseded) ends the tool.
          if (err instanceof AskWaitError && err.code === "timeout") {
            return json({ pending: true });
          }
          // Uses `reason`, not `error`, so the bridge's httpJson passes it
          // through instead of auto-throwing on `error`.
          return json({ cancelled: true, reason: err?.message ?? String(err) });
        }
      }
    }

    // POST /api/sessions/:sessionKey/permission
    //
    // Una GAMBA del rendez-vous del CANALE DI PERMESSO. La chiama il bridge
    // (`mcp__topics__approval_prompt`) quando la CLI, invece di eseguire uno
    // strumento, chiede il permesso — cioè in ogni `--permission-mode` che non
    // sia `bypassPermissions`. Senza questa rotta quella richiesta diventava un
    // no muto («…but you haven't granted it yet»), e con lei sparivano TUTTI i
    // tool MCP e ogni scrittura fuori dalla cwd.
    //
    // Tre risposte, esattamente come la gamba di una domanda:
    //   { decision }            qualcuno ha deciso (o una regola lo copriva)
    //   { pending: true }       nessuno ha ancora premuto — torna subito
    //   { cancelled, reason }   la richiesta è finita: turno interrotto o scaduta
    //
    // Il pannello lo dipinge QUESTA rotta, non lo stream: la chiamata al tool di
    // prompt non compare nella trascrizione (verificato sul filo), quindi non
    // c'è nessun `tool_use` da cui il rilevatore possa ricavarla. Si aggancia
    // alla riga che è GIÀ a schermo — quella dello strumento in attesa — perché
    // il `tool_use_id` che la CLI passa è lo stesso id di quella riga.
    {
      const permM = matchRoute(pathname, "/api/sessions/:sessionKey/permission");
      if (permM && method === "POST") {
        const sk = decodeURIComponent(permM.sessionKey);
        const denied = denyGlobalCoordinatorHumanBridge(sk);
        if (denied) return denied;
        const body = (await readJSON(req)) as
          | { toolName?: unknown; input?: unknown; toolUseId?: unknown; legMs?: unknown }
          | null;
        const toolName = typeof body?.toolName === "string" ? body.toolName : "";
        const toolUseId = typeof body?.toolUseId === "string" && body.toolUseId ? body.toolUseId : "";
        if (!toolName || !toolUseId) {
          return json({ error: "toolName and toolUseId are required" }, 400);
        }
        // 1. Una regola lo copre già? Allora non si disturba nessuno. Qui dentro
        //    c'è anche `mcp__topics__*`: sono le mani di Topics, e il 7 agosto
        //    una richiesta di permesso è arrivata proprio su
        //    `ask_user_question` — serviva il permesso di mostrare un pannello
        //    per poter mostrare un pannello.
        if (decideGrantForTool(toolName) === "allow") {
          return json({ decision: "allow" });
        }

        // 1-bis. Questa CHAT è passata a libera? Allora non c'è niente da
        //    chiedere: si consente e basta, senza aprire un pannello.
        //
        //    È la seconda metà di «Passa a libero» (vedi lib/session-free-mode.ts).
        //    La prima — il livello scritto sul topic — vale dal prossimo spawn,
        //    perché `--permission-mode` si decide alla nascita del figlio CLI: il
        //    processo che sta girando ADESSO è nato in una modalità che chiede e
        //    continuerà a chiedere fino a che non muore. Senza questa riga
        //    «passa a libero» avrebbe liberato la sessione DOPO il turno in cui
        //    è stato premuto, cioè non avrebbe fatto quello che dice.
        //
        //    Vale per QUESTA sessione, letta dal suo topic: nessuna regola
        //    globale, nessuna altra chat toccata.
        if (sessionIsFree(getTopicBySessionKey(sk)?.autonomyLevel)) {
          return json({ decision: "allow" });
        }

        const legMs = typeof body?.legMs === "number" && Number.isFinite(body.legMs)
          ? Math.min(Math.max(body.legMs, 100), 60_000)
          : undefined;

        if (!beginPermission(sk, toolUseId)) {
          cancelPermission(sk, toolUseId, "no answer: the request expired");
          return json({ cancelled: true, reason: "permission: the request expired with no answer" });
        }

        // 2. Il pannello si dipinge finché non è a schermo — non «una volta».
        //
        // Dipingerlo solo alla PRIMA gamba lo rende irrecuperabile: se quella
        // scrittura si perde (i blocchi hanno un altro proprietario dentro lo
        // stream, e `persistBlocks` può passarci sopra), oppure se il server si
        // riavvia mentre la richiesta è aperta, la riga resta a girare per
        // sempre sotto un piede che dice «in attesa della tua risposta». È
        // successo al primo permesso vero, il 7 agosto.
        //
        // Quindi: si guarda la riga com'è ADESSO, e si ridipinge se non mostra
        // già questo pannello. Una lettura ogni 25 secondi per richiesta
        // aperta, e nessuno stato che possa restare perso.
        {
          const request: ToolPermissionRequest = {
            toolName,
            input: (body?.input ?? {}) as Record<string, unknown>,
            requestedAt: Date.now(),
          };
          // Quale riga, e ci sta già: è politica, e ora vive in
          // `lib/permission-paint.ts` con i suoi test (ripiego per nome, i
          // blocchi che battono `tool_calls`, «nel dubbio si ridipinge»). Qui
          // restano la lettura e gli effetti.
          let row: { tool_calls?: string | null; blocks?: string | null } | undefined;
          try {
            const rawRow = ctx.db
              .prepare("SELECT tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
              .get(sk) as { tool_calls?: unknown; blocks?: unknown } | undefined;
            if (rawRow) {
              row = { tool_calls: decodeCol(rawRow.tool_calls), blocks: decodeCol(rawRow.blocks) };
            }
          } catch { /* riga illeggibile: si ridipinge */ }
          const { targetId, aliasTo, alreadyPainted } = decidePermissionPaint(row, toolUseId, toolName);
          // Il click arriverà con l'id della RIGA: la corrispondenza si SCRIVE
          // adesso, invece di indovinarla al ritorno.
          if (aliasTo) aliasPermission(sk, toolUseId, aliasTo);

          if (!alreadyPainted) {
            const topic = getTopicBySessionKey(sk);
            updateToolCallFields(sk, targetId, {
              status: "awaiting_permission",
              permissionRequest: request,
              permissionOutcome: undefined,
            });
            broadcastToAll({
              type: "stream:tool_permission_required",
              sessionKey: sk,
              topicId: topic?.id,
              toolCallId: targetId,
              request,
            });
          }
        }

        // 3. Aspetta che qualcuno prema.
        try {
          const decision = await waitForDecision(sk, toolUseId, legMs !== undefined ? { timeoutMs: legMs } : {});
          return json({ decision });
        } catch (err: any) {
          if (err instanceof PermissionWaitError && err.code === "timeout") {
            return json({ pending: true });
          }
          return json({ cancelled: true, reason: err?.message ?? String(err) });
        }
      }
    }

    // POST /api/sessions/:sessionKey/permission-response
    //
    // La decisione umana su UN permesso. Endpoint suo, e non un ramo dentro
    // `/api/chat/tool-response`: lì la risposta è un `ToolUserResponse` — una
    // mappa domanda→testo, pensata per essere riletta da un MODELLO. Un
    // permesso ha tre esiti esatti, li rilegge il SERVER, e uno dei tre scrive
    // una regola permanente. Farli viaggiare sullo stesso tubo voleva dire
    // riconoscere la decisione per prefisso di stringa dentro una chiave in
    // prosa: reggeva finché nessuno toccava un'etichetta.
    {
      const respM = matchRoute(pathname, "/api/sessions/:sessionKey/permission-response");
      if (respM && method === "POST") {
        const sk = decodeURIComponent(respM.sessionKey);
        const denied = denyGlobalCoordinatorHumanBridge(sk);
        if (denied) return denied;
        const body = (await readJSON(req)) as { toolCallId?: unknown; decision?: unknown } | null;
        const toolCallId = typeof body?.toolCallId === "string" ? body.toolCallId : "";
        if (!toolCallId) return json({ error: "toolCallId is required" }, 400);
        // Sul confine si valida, non si spera: un valore che non riconosciamo
        // NON diventa un sì per inerzia, e nemmeno un no silenzioso — è un 400,
        // e chi ha premuto lo vede.
        if (!isPermissionDecision(body?.decision)) {
          return json({ error: "decision must be allow | allow_always | deny | allow_free", code: "invalid_decision" }, 400);
        }
        const decision: PermissionDecision = body.decision;

        const openId = resolvePendingPermission(sk, toolCallId);
        if (!openId) {
          // Il pannello è a schermo ma sotto non c'è più nessuno: turno morto,
          // server riavviato, richiesta scaduta. Dirlo è meglio che accettare
          // un click che non arriverà da nessuna parte.
          return json({ error: "no permission request is open for this row", code: "permission_not_pending" }, 409);
        }

        const decidedAt = new Date().toISOString();
        const topic = getTopicBySessionKey(sk);
        // Il nome dello strumento, letto dalla riga: è l'unica cosa che sappiamo
        // per certo di questa richiesta una volta che il click è arrivato.
        // Illeggibile è una risposta legittima — nessuna delle due decisioni che
        // lo usano dipende da lui per essere presa.
        const toolNameOnRow = (): string | null => {
          try {
            const row = ctx.db
              .prepare("SELECT tool_calls FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
              .get(sk) as { tool_calls?: unknown } | undefined;
            const decoded = decodeCol(row?.tool_calls);
            const calls = decoded ? (JSON.parse(decoded) as { id?: string; name?: string }[]) : [];
            return calls.find((c) => c?.id === toolCallId)?.name ?? null;
          } catch {
            return null;
          }
        };
        if (decision === "allow_always") {
          // Il pattern è il nome dello strumento: scriverne uno più largo (tutto
          // il server MCP) sarebbe concedere qualcosa che nessuno ha premuto.
          // Se la riga è illeggibile, la concessione di QUESTA volta vale comunque.
          const name = toolNameOnRow();
          if (name) addToolGrant(name, sk);
        }

        const outcome: ToolPermissionOutcome = { decision, decidedAt };

        // «Passa a libero»: la stessa pressione consente QUESTA richiesta e
        // cambia il regime della chat. Prima il regime, poi la consegna: se il
        // passaggio non riesce (una sessione senza topic non ha un livello dove
        // scriverlo) chi ha premuto deve vedere un errore, non un permesso
        // concesso e una promessa di libertà che nessuno ha mantenuto.
        let freed = false;
        if (decisionFreesSession(decision)) {
          const change = switchSessionToFree({ getTopicBySessionKey, saveSingleTopic, broadcastToAll }, sk);
          if (!change) {
            return json(
              { error: "this session has no topic: there is nowhere to write the mode", code: "no_topic_for_session" },
              409,
            );
          }
          freed = true;
          // CHI l'ha fatto resta scritto sulla riga — la traccia nel thread —
          // e nel registro, che è dove si va a guardare quando la domanda è
          // «da quando questa chat non chiede più, e chi l'ha deciso».
          outcome.actor = etichettaAutore(ctx.db as never, ctx.requestIdentity?.(req) ?? null);
          logActivity({
            category: "permission",
            level: "warn",
            title: "session switched to free mode from the permission panel",
            detail: `tool allowed: ${toolNameOnRow() ?? "unknown"} · previous level: ${change.previous ?? "not chosen"}`,
            entityType: "topic",
            entityId: change.topic.id,
            actor: outcome.actor,
            sessionKey: sk,
          });
        }

        deliverDecision(sk, openId, cliDecisionFor(decision));
        // La riga torna a girare, e l'esito RESTA: chi rilegge la chat vede chi
        // ha detto cosa, non solo che a un certo punto il tool è partito.
        updateToolCallFields(sk, toolCallId, { status: "running", permissionOutcome: outcome });
        broadcastToAll({
          type: "stream:tool_permission_resolved",
          sessionKey: sk,
          topicId: topic?.id,
          toolCallId,
          outcome,
        });

        // La sessione è libera: ogni ALTRO pannello aperto su questa chat non ha
        // più niente da chiedere. Chiuderli qui — invece di lasciarli morire di
        // TTL — è ciò che impedisce a un turno di restare «in attesa di una
        // persona» (e quindi fuori dalla vista di watchdog e reaper) mentre la
        // persona ha già risposto per tutti.
        if (freed) {
          for (const served of allowPendingPermissions(sk)) {
            const alsoOutcome: ToolPermissionOutcome = { decision: "allow", decidedAt, actor: outcome.actor };
            for (const rowId of [served.toolUseId, ...served.rowIds]) {
              updateToolCallFields(sk, rowId, { status: "running", permissionOutcome: alsoOutcome });
              broadcastToAll({
                type: "stream:tool_permission_resolved",
                sessionKey: sk,
                topicId: topic?.id,
                toolCallId: rowId,
                outcome: alsoOutcome,
              });
            }
          }
        }
        return json({ ok: true, decidedAt, ...(freed ? { autonomyLevel: "yolo" } : {}) });
      }
    }

    // GET/POST/DELETE /api/tool-grants — le regole di «Consenti sempre».
    //
    // Un consenso permanente che non si può rileggere né togliere è una porta
    // che si apre e basta. Qui si leggono, si aggiungono a mano e si revocano.
    {
      if (pathname === "/api/tool-grants" && method === "GET") {
        return json({ grants: listToolGrants() });
      }
      if (pathname === "/api/tool-grants" && method === "POST") {
        const body = (await readJSON(req)) as { pattern?: unknown } | null;
        const pattern = typeof body?.pattern === "string" ? body.pattern.trim() : "";
        if (!pattern) return json({ error: "pattern is required" }, 400);
        if (!addToolGrant(pattern)) {
          return json({ error: "invalid pattern (a bare '*' is not a rule)", code: "invalid_pattern" }, 400);
        }
        return json({ ok: true, grants: listToolGrants() });
      }
      const grantM = matchRoute(pathname, "/api/tool-grants/:pattern");
      if (grantM && method === "DELETE") {
        const removed = removeToolGrant(decodeURIComponent(grantM.pattern));
        return json({ ok: true, removed, grants: listToolGrants() });
      }
    }
    return null;
  };
}
