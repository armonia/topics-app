/**
 * Le due PORTE dell'orchestratore.
 *
 * Qui non c'è nessuna regola: tutto ciò che decide qualcosa sta in
 * `server/services/orchestrator.ts`. Questa rotta è la porta del COMPOSER della
 * board — risolve la sessione e le consegna il testo. L'altra porta, la chat, è
 * l'utente che scrive dentro quello stesso topic e passa da `/api/chat` come
 * qualunque conversazione.
 *
 * Che siano la stessa cosa non è una promessa: entrambe passano da
 * `orchestratorTurn`, che restituisce `sessionKey` + contenuto, e da lì in poi
 * il resto della pipeline non sa nemmeno da dove sia entrato il messaggio.
 */

import type { AppContext, RouteHandler, Topic } from "../types";
import {
  isOrchestratorTopic,
  orchestratorTurn,
  type OrchestratorSessionDeps,
} from "../services/orchestrator";

export interface OrchestratorRouterDeps {
  /** Da id di board a cartella del progetto (la stessa risoluzione del dispatcher). */
  resolveProject: (projectId: string) => { path: string } | null;
  /** Crea un topic scollegato (nessuna tab rubata all'utente). */
  createTopic: OrchestratorSessionDeps["createTopic"];
  /**
   * Fa girare UN turno sulla sessione. Iniettato perché vive in `server.ts`
   * (guida `/api/chat` dall'interno); qui serve solo poterlo chiamare.
   * Non lo aspettiamo: la risposta arriva al client via WebSocket sul topic,
   * come per qualunque altra chat.
   */
  runTurn: (sessionKey: string, content: string) => Promise<unknown>;
}

export function createOrchestratorRouter(ctx: AppContext, deps: OrchestratorRouterDeps): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse } = ctx;

  /** Il topic-orchestratore di questa cartella, se già esiste. */
  const findOrchestratorTopic = (projectPath: string): Topic | null => {
    const data = ctx.loadTopics();
    for (const t of Object.values(data.topics)) {
      if (!isOrchestratorTopic(t)) continue;
      if (t.projectPath !== projectPath) continue;
      // Archiviato NON vuol dire morto: un topic d'orchestratore nasce
      // `background` (fuori dalle tab) proprio per non rubare lo schermo, e
      // saltarlo qui vorrebbe dire fondarne uno nuovo a ogni messaggio dal
      // composer — cioè perdere la conversazione, che è metà del punto.
      return t;
    }
    return null;
  };

  const sessionDeps: OrchestratorSessionDeps = {
    findOrchestratorTopic,
    createTopic: deps.createTopic,
  };

  return async function orchestratorRouter(
    req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    // GET /api/orchestrator/:projectId → la sessione (creandola se non c'è).
    // Serve alla chat: è così che una superficie apre "la porta 1" sapendo che
    // è la STESSA sessione a cui parla il composer.
    {
      const params = matchRoute(pathname, "/api/orchestrator/:projectId");
      if (params && method === "GET") {
        const target = resolveTarget(params.projectId);
        if (!target) return errorResponse(404, "unknown project");
        const session = orchestratorTurn(sessionDeps, target, "(apertura)");
        return json({ topicId: session.topicId, sessionKey: session.sessionKey, created: session.created });
      }
    }

    // POST /api/orchestrator/:projectId/message → la porta del composer.
    {
      const params = matchRoute(pathname, "/api/orchestrator/:projectId/message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return errorResponse(400, "text required");
        const target = resolveTarget(params.projectId);
        if (!target) return errorResponse(404, "unknown project");

        const turn = orchestratorTurn(sessionDeps, target, text);
        // Non si aspetta il turno: una risposta d'orchestratore dura decine di
        // secondi e la porta HTTP del composer non è il posto dove tenerla
        // aperta. Il client segue lo stream sul topic come per ogni chat — che
        // è di nuovo lo stesso percorso della porta 1, non un secondo canale.
        deps.runTurn(turn.sessionKey, turn.content).catch((err) => {
          console.error("[orchestrator] turno fallito:", err);
        });
        return json({ topicId: turn.topicId, sessionKey: turn.sessionKey, created: turn.created }, 202);
      }
    }

    return null;
  };

  function resolveTarget(projectId: string): { projectPath: string; projectName: string } | null {
    const resolved = deps.resolveProject(projectId);
    if (!resolved?.path) return null;
    const projectName = resolved.path.replace(/\/+$/, "").split("/").pop() || projectId;
    return { projectPath: resolved.path, projectName };
  }
}
