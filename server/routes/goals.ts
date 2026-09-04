/**
 * REST del goal di una chat (3.4). La logica sta in `services/goals.ts`; qui
 * ci sono solo le rotte e l'UNICA cosa che il servizio non fa apposta: il
 * broadcast.
 *
 * Perché il broadcast è qui e non nel servizio: il servizio lo chiamano anche
 * l'envelope (in sola lettura) e il traduttore ACP, che gira dentro lo stream
 * di un turno. Un servizio che notifica da sé finirebbe per mandare eventi da
 * dentro un handler di stream, con l'ordine dei frame deciso dal caso. Chi
 * cambia lo stato annuncia il cambiamento — e qui il chiamante è uno solo.
 */

import type { AppContext, RouteHandler } from "../types";
import {
  closeGoal,
  getActiveGoal,
  getGoal,
  listGoals,
  reopenGoal,
  replaceSteps,
  setGoal,
  setGoalLoop,
} from "../services/goals";

export function createGoalsRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcast } = ctx;

  /** Annuncia lo stato ATTUALE della topic, non quello del goal toccato: chi
   *  ascolta vuole sapere cosa perseguiamo adesso, e dopo un `close` la
   *  risposta giusta è `null`, non il goal appena chiuso. */
  function announce(topicId: string): void {
    broadcast({ type: "goal:updated", topicId, goal: getActiveGoal(db, topicId) });
  }

  return async function goalsRouter(
    req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    // GET /api/topics/:id/goal → il goal attivo (o null) + lo storico.
    {
      const params = matchRoute(pathname, "/api/topics/:id/goal");
      if (params && method === "GET") {
        return json({ goal: getActiveGoal(db, params.id), history: listGoals(db, params.id) });
      }

      // PUT /api/topics/:id/goal → dichiara il goal (chiude il precedente).
      if (params && method === "PUT") {
        const body = await readJSON(req);
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) return errorResponse(400, "content required");
        const createdBy = body?.createdBy === "agent" ? "agent" : "human";
        const goal = setGoal(db, { topicId: params.id, content, createdBy });
        announce(params.id);
        return json({ goal }, 201);
      }

      // DELETE /api/topics/:id/goal → chiude quello attivo.
      // `status` distingue «fatto» da «lasciato perdere»: default `abandoned`,
      // perché è quello che significa una chiusura senza spiegazioni.
      if (params && method === "DELETE") {
        const active = getActiveGoal(db, params.id);
        if (!active) return errorResponse(404, "no active goal");
        const body = await readJSON(req).catch(() => null);
        const status = body?.status === "achieved" ? "achieved" : "abandoned";
        const goal = closeGoal(db, active.id, status);
        announce(params.id);
        return json({ goal });
      }
    }

    // POST /api/topics/:id/goal/loop -> stop (or restart) the auto-continuation.
    //
    // A DIFFERENT thing from closing the goal, which is why it has a route of
    // its own: "stop chasing it by yourself" is not "drop the objective". The
    // objective stays in the context of every turn, nobody just buys turns for
    // it any more. That is what somebody pressing Stop on the bar is asking
    // for while they carry on working on it by hand.
    {
      const params = matchRoute(pathname, "/api/topics/:id/goal/loop");
      if (params && method === "POST") {
        const active = getActiveGoal(db, params.id);
        if (!active) return errorResponse(404, "no active goal");
        const body = await readJSON(req).catch(() => null);
        const state = body?.state === "running" ? "running" : "stopped";
        // Restarting zeroes the counters: whoever puts the loop back in motion
        // expects the whole ceiling, not what was left of the previous run.
        const goal = setGoalLoop(db, active.id, {
          state,
          ...(state === "running" ? { continuations: 0, idleTurns: 0 } : {}),
        });
        announce(params.id);
        return json({ goal });
      }
    }

    // GET/DELETE /api/sessions/:sessionKey/goal: the same two calls, addressed
    // the way an agent knows itself. A tool running inside a session has its
    // session key, not the topic id; making it look the id up first is a round
    // trip and one more chance to act on the wrong topic. Added on 2026-09-03
    // for `get_goal` / `close_goal`: until then an agent could be handed a goal
    // and had no way to say it was done.
    {
      const params = matchRoute(pathname, "/api/sessions/:sessionKey/goal");
      if (params && (method === "GET" || method === "DELETE")) {
        const topic = ctx.getTopicBySessionKey(decodeURIComponent(params.sessionKey));
        if (!topic) return errorResponse(404, "no topic for this session");
        if (method === "GET") {
          return json({ goal: getActiveGoal(db, topic.id), history: listGoals(db, topic.id) });
        }
        const active = getActiveGoal(db, topic.id);
        if (!active) return errorResponse(404, "no active goal");
        const body = await readJSON(req).catch(() => null);
        const status = body?.status === "achieved" ? "achieved" : "abandoned";
        const goal = closeGoal(db, active.id, status);
        announce(topic.id);
        return json({ goal });
      }
    }

    // POST /api/goals/:id/reopen
    {
      const params = matchRoute(pathname, "/api/goals/:id/reopen");
      if (params && method === "POST") {
        const existing = getGoal(db, params.id);
        if (!existing) return errorResponse(404, "goal not found");
        const goal = reopenGoal(db, params.id);
        announce(existing.topicId);
        return json({ goal });
      }
    }

    // PUT /api/goals/:id/steps → sostituisce l'elenco dei passi in blocco.
    {
      const params = matchRoute(pathname, "/api/goals/:id/steps");
      if (params && method === "PUT") {
        const existing = getGoal(db, params.id);
        if (!existing) return errorResponse(404, "goal not found");
        const body = await readJSON(req);
        const raw = Array.isArray(body?.steps) ? body.steps : null;
        if (!raw) return errorResponse(400, "steps array required");
        const steps = raw.map((s: unknown) =>
          typeof s === "string"
            ? { content: s }
            : {
                content: String((s as { content?: unknown })?.content ?? ""),
                status: (s as { status?: string })?.status,
              },
        );
        replaceSteps(db, params.id, steps);
        announce(existing.topicId);
        return json({ goal: getGoal(db, params.id) });
      }
    }

    return null;
  };
}
