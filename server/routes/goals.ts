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
  promoteGoal,
  reopenGoal,
  replaceSteps,
  setGoal,
  setGoalLoop,
} from "../services/goals";
import {
  isGlobalOrchestratorSession,
  isGlobalOrchestratorTopic,
} from "../services/global-orchestrator-session";

/** A step is a string or `{content, status}`: both shapes reach the same row. */
function normalizeSteps(raw: unknown[]): Array<{ content: string; status?: string }> {
  return raw.map((s) =>
    typeof s === "string"
      ? { content: s }
      : {
          content: String((s as { content?: unknown })?.content ?? ""),
          status: (s as { status?: string })?.status,
        },
  );
}

export function createGoalsRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcast } = ctx;

  // Goals are ordinary per-Topic conversation state.  The coordinator's
  // durable role is recognized from the registry even if its backing Topic is
  // corrupt/ineligible, and it must never regain this generic state surface.
  // Its intentionally small Codex profile contains only global task tools.
  function denyGlobalCoordinatorGoalAccess(topicId: string): Response | null {
    if (!isGlobalOrchestratorTopic(db, topicId)) return null;
    return globalCoordinatorGoalAccessResponse();
  }

  function globalCoordinatorGoalAccessResponse(): Response {
    return json({
      error: "the global coordinator cannot access generic topic goals",
      code: "orchestrator_topic_invariant",
    }, 403);
  }

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
        const denied = denyGlobalCoordinatorGoalAccess(params.id);
        if (denied) return denied;
        return json({ goal: getActiveGoal(db, params.id), history: listGoals(db, params.id) });
      }

      // PUT /api/topics/:id/goal → dichiara il goal (chiude il precedente).
      if (params && method === "PUT") {
        const denied = denyGlobalCoordinatorGoalAccess(params.id);
        if (denied) return denied;
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
        const denied = denyGlobalCoordinatorGoalAccess(params.id);
        if (denied) return denied;
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
        const denied = denyGlobalCoordinatorGoalAccess(params.id);
        if (denied) return denied;
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

    // PUT /api/sessions/:sessionKey/goal/steps: the agent rewrites the steps of
    // the goal being pursued, exactly as an ACP `plan` does. Whole list, one
    // transaction: a half-updated plan is worse than a replaced one.
    //
    // It works on a HUMAN goal too, and that is not a contradiction with the
    // refusal below: writing the plan of the objective you were given is doing
    // the job, replacing the objective is deciding it.
    {
      const params = matchRoute(pathname, "/api/sessions/:sessionKey/goal/steps");
      if (params && method === "PUT") {
        const sessionKey = decodeURIComponent(params.sessionKey);
        // Same registry-first check as the session goal route below: the raw
        // registry row is refused before the Topic resolver gets a say.
        if (isGlobalOrchestratorSession(db, sessionKey)) return globalCoordinatorGoalAccessResponse();
        const topic = ctx.getTopicBySessionKey(sessionKey);
        if (!topic) return errorResponse(404, "no topic for this session");
        const denied = denyGlobalCoordinatorGoalAccess(topic.id);
        if (denied) return denied;
        const active = getActiveGoal(db, topic.id);
        if (!active) return errorResponse(404, "no active goal");
        const body = await readJSON(req);
        const raw = Array.isArray(body?.steps) ? body.steps : null;
        if (!raw) return errorResponse(400, "steps array required");
        replaceSteps(db, active.id, normalizeSteps(raw));
        announce(topic.id);
        return json({ goal: getGoal(db, active.id) });
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
      if (params && (method === "GET" || method === "PUT" || method === "DELETE")) {
        const sessionKey = decodeURIComponent(params.sessionKey);
        // Check the raw registry join directly from the session key before
        // consulting the ordinary Topic resolver.  The latter must not become
        // the authority that decides whether this special session is ordinary.
        if (isGlobalOrchestratorSession(db, sessionKey)) return globalCoordinatorGoalAccessResponse();
        const topic = ctx.getTopicBySessionKey(sessionKey);
        if (!topic) return errorResponse(404, "no topic for this session");
        const denied = denyGlobalCoordinatorGoalAccess(topic.id);
        if (denied) return denied;
        // PUT: the agent declares the objective it is pursuing, so a job of
        // twenty steps shows above the chat instead of nothing.
        //
        // A goal the PERSON declared is never overwritten: they command, and an
        // agent that rewrites the objective it was given has changed the job
        // while looking like it is doing it. The refusal says what to do
        // instead, otherwise the model retries the same call.
        if (method === "PUT") {
          const body = await readJSON(req);
          const content = typeof body?.content === "string" ? body.content.trim() : "";
          if (!content) return errorResponse(400, "content required");
          const active = getActiveGoal(db, topic.id);
          if (active && active.createdBy === "human") {
            return errorResponse(
              409,
              `a goal declared by the person is active («${active.content}»): only they can replace it. Plan inside it with update_goal_steps, or close it with close_goal when it is met.`,
            );
          }
          // Re-declaring the same objective is a no-op, not a new goal: after a
          // compaction the model calls `set_goal` again with the same sentence,
          // and a fresh row would drop the steps it had already reported.
          if (active && active.content === content) return json({ goal: active });
          const goal = setGoal(db, { topicId: topic.id, content, createdBy: "agent" });
          announce(topic.id);
          return json({ goal }, 201);
        }
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
        const denied = denyGlobalCoordinatorGoalAccess(existing.topicId);
        if (denied) return denied;
        const goal = reopenGoal(db, params.id);
        announce(existing.topicId);
        return json({ goal });
      }
    }

    // POST /api/goals/:id/promote: the person adopts a goal the agent proposed.
    // It stays the SAME row, with its steps and its history: promoting is not
    // re-declaring, and re-declaring would abandon the proposal and lose the
    // plan already reported under it. After this the agent can no longer
    // replace it, which is the whole point of the button.
    {
      const params = matchRoute(pathname, "/api/goals/:id/promote");
      if (params && method === "POST") {
        const existing = getGoal(db, params.id);
        if (!existing) return errorResponse(404, "goal not found");
        const denied = denyGlobalCoordinatorGoalAccess(existing.topicId);
        if (denied) return denied;
        const goal = promoteGoal(db, params.id);
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
        const denied = denyGlobalCoordinatorGoalAccess(existing.topicId);
        if (denied) return denied;
        const body = await readJSON(req);
        const raw = Array.isArray(body?.steps) ? body.steps : null;
        if (!raw) return errorResponse(400, "steps array required");
        replaceSteps(db, params.id, normalizeSteps(raw));
        announce(existing.topicId);
        return json({ goal: getGoal(db, params.id) });
      }
    }

    return null;
  };
}
