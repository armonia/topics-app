/**
 * Request guards of the tasks routes: attachments, session resolution, review and fan-out gates.
 */
import { STAGE_AI_REVIEW } from "../../shared/workflow";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { TASK_STATUSES, type TaskStatus } from "../../shared/board";
import { AGENT_AUTHOR, AGENT_AUTHOR_PREFIX, isAgentAuthor } from "../../shared/comment-author";
import { sessionProof } from "../lib/session-token";
import { topicsHome } from "../services/daemon-state";
import { isPreviewablePath } from "../../shared/media-kind";
import { isBlankLikeImage } from "../services/image-shape";
import { parseTaskPatch, unapplicableFieldsBody, checkConstraintBody, type FieldRead } from "./task-patch";
import { getTerminalSessionById } from "./terminal";
import { AUTO_PROJECT_ID, commentAsksHuman, projectIdForPath, TaskServiceError, UNASSIGNED_PROJECT_ID, type Task } from "../services/tasks";
import { clampLegMs } from "../services/checks-gate";
import { type TaskAttempt } from "../services/task-attempts";
import { getEligibleGlobalOrchestratorSessionBySessionKey, isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { ERROR_STATUS, emitReviewReadyEdge, requestCardProcessStop } from "./tasks-shared";
import type { TasksCore, TasksLate } from "./tasks-scope";

export function createTasksGuards(core: TasksCore, late: TasksLate) {
  const { ctx, opts, svc, attempts, db, json, broadcastToAll, getTopicBySessionKey, isPathAllowed, dispatcher } = core;
  const { checksWaitSince, afterDelivery } = late;
  const triggerUrlProbe: TasksLate["triggerUrlProbe"] = (...args) => late.triggerUrlProbe(...args);
  const runChecksGate: TasksLate["runChecksGate"] = (...args) => late.runChecksGate(...args);
  const tellChatAboutChecksWait: TasksLate["tellChatAboutChecksWait"] = (...args) => late.tellChatAboutChecksWait(...args);
  const rememberDelivery: TasksLate["rememberDelivery"] = (...args) => late.rememberDelivery(...args);
  const enqueueLandOnDone: TasksLate["enqueueLandOnDone"] = (...args) => late.enqueueLandOnDone(...args);
  const forgetDeliveryMemo: TasksLate["forgetDeliveryMemo"] = (...args) => late.forgetDeliveryMemo(...args);
  const captureDelivery: TasksLate["captureDelivery"] = (...args) => late.captureDelivery(...args);

  /**
   * SECURITY: attachment paths are stored AND later handed to the agent as
   * "read these files" — so they must pass the same allowlist that gates
   * serving them (/api/media: uploads, context, workspace/media dirs). Without
   * this, a comment could reference ~/.ssh/id_rsa and the resume message would
   * happily instruct the agent to read it. Anything outside the allowlist is
   * silently dropped (the comment itself still lands).
   */
  function filterMedia(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((m): m is string => {
      if (typeof m !== "string" || !m.startsWith("/")) return false;
      if (typeof isPathAllowed !== "function") return true; // test ctx without the helper
      try { return isPathAllowed(m); } catch { return false; }
    });
  }

  /**
   * Il valore da scrivere in `previewImage`, o il MOTIVO del rifiuto. Due
   * cancelli, non uno:
   *
   *  · il PATH, come per ogni allegato (`filterMedia`, allowlist di sicurezza);
   *  · il TIPO — deve esistere un elemento che lo mostri. `PREVIEW_RULE` ne
   *    ammette tre (screenshot .png, video, diagramma .svg) e questa è la stessa
   *    frontiera vista dal rendering.
   *
   * Il secondo mancava, ed è così che un `.pdf` è diventato l'anteprima di una
   * card: passava l'allowlist, arrivava al ramo `<img>` del client e si vedeva
   * un'icona rotta. Il 200 diceva «consegnato», la card non mostrava niente.
   *
   * Stringa vuota = azzera (gesto esplicito, resta valido).
   */
  function acceptPreview(raw: unknown): FieldRead {
    if (raw === null) return { ok: true, value: null }; // azzera, come la stringa vuota
    if (typeof raw !== "string") return { ok: false, reason: "atteso il path (string) di uno screenshot, video o diagramma" };
    if (raw.trim() === "") return { ok: true, value: "" };
    if (!filterMedia([raw])?.length) {
      return { ok: false, reason: "path outside the allowed folders (~/.topics/media, the app data media folder, workspace)" };
    }
    if (!isPreviewablePath(raw)) {
      return { ok: false, reason: "extension not previewable: it takes a .png/.jpg, a video or an .svg" };
    }
    // IL DEFAULT E' LA COSA VERA, non un si'.
    //
    // Il seam esiste perche' un test possa dire «fingi che ci sia»; il suo
    // valore di riposo pero' deve restare `existsSync`, altrimenti qualunque
    // AppContext costruito senza quel campo perde il cancello SENZA dirlo — e
    // un cancello che sparisce in silenzio e' peggio di uno che non c'e' mai
    // stato. Con `?? (() => true)` bastava dimenticare una riga di cablaggio
    // per tornare al difetto di partenza: una card che punta a un'anteprima
    // cancellata e una PATCH che risponde 200.
    const checkExists = ctx.fileExistsSync ?? existsSync;
    if (!checkExists(raw)) {
      return { ok: false, reason: `file not found on disk: ${raw}` };
    }
    // A BLANK IMAGE IS NOT EVIDENCE, and this gate holds even on an explicit
    // gesture. The shape gate below was removed BECAUSE the crop already does
    // its job — but a flat, uniform image has no job left for the crop to do:
    // no layout choice makes an empty screenshot show the work. `isBlankLikeImage`
    // is the same measured floor already used for the auto-captured path
    // (`preview-manager.ts`); a card that could not be measured (unknown
    // format, unreadable header) still passes, same as every other gate here.
    try {
      const shape = ctx.imageShapeOf?.(raw);
      if (
        shape &&
        isBlankLikeImage({
          bytes: statSync(raw).size,
          width: shape.width,
          height: shape.height,
          vector: shape.vector,
        })
      ) {
        return { ok: false, reason: "image is blank (flat colour): not evidence of the work" };
      }
    } catch { /* unreadable ⇒ same as unmeasurable: promote, do not block */ }
    // NIENTE CANCELLO SULLA FORMA, e la ragione e' una misura.
    //
    // Ci avevo messo un terzo cancello: un'anteprima piu' alta che larga occupa
    // la card e spinge giu' il testo (misurato il 17/08: 255x397 alta 330px su
    // una card di 798). Il fatto e' vero, il rimedio era sbagliato, e l'ha
    // detto la suite - due tentativi, due rossi su `board-preview-cap.spec.ts`.
    //
    // Il riquadro della card RITAGLIA, sempre: `object-cover object-top` con
    // `max-h-[70cqw]`. Quella spec dichiara il contratto («il tetto taglia, non
    // deforma») e tiene apposta fra i casi buoni una quadrata E una 900x1800,
    // col commento «quella che il tetto deve tagliare». Rifiutarle qui vorrebbe
    // dire che la porta manuale non crede a cio' che la card fa un layer piu'
    // in la'.
    //
    // Il rifiuto per forma resta dov'era gia': nella promozione AUTOMATICA
    // (`tooTallForCard`), che sceglie da sola cosa mettere sulla card e nel
    // dubbio non sceglie. Qui c'e' un gesto esplicito - qualcuno dice «voglio
    // QUESTA» - e la risposta giusta e' mostrarla ritagliata, non rifiutarla.
    //
    // Cio' che ho sbagliato a fare qui e' documentato in
    // `shared/board.ts:PREVIEW_CARD_MAX_RATIO`.
    return { ok: true, value: raw };
  }

  /**
   * Lo SCATTO della consegna (`deliveryBranch` / `deliveryCommit`) non si
   * riscrive da una PATCH: torna la risposta 400 da restituire, o `null` se la
   * richiesta non lo tocca.
   *
   * È la descrizione di ciò che il reviewer ha guardato prima di cliccare «Landa
   * su main», e la deriva fra quello scatto e la punta del ramo è precisamente
   * ciò che il land mette nel thread — poterlo correggere vorrebbe dire
   * cancellare l'unica prova che le due cose differiscono.
   *
   * Ma un campo non applicabile va RIFIUTATO, non ignorato. Qui la PATCH
   * rispondeva 200 senza spostare niente (seconda occorrenza dello stesso
   * difetto, dopo `parentTaskId` sulla card `b06bb837`), e chi la chiamava per
   * «dire alla card che il ramo è andato avanti» credeva di esserci riuscito.
   * Serviva a un solo scopo, e quello scopo non esiste più: il land riallinea il
   * ramo su main da sé e pubblica la PUNTA quando il commit registrato è un suo
   * antenato. Una porta sola per tutte e due le PATCH (l'umana e quella degli
   * agenti): un campo rifiutato da una e ingoiato dall'altra è di nuovo il 200
   * muto, da un'altra parte.
   */
  function rejectDeliveryPatch(body: any): Response | null {
    const touched = ["deliveryCommit", "delivery_commit", "deliveryBranch", "delivery_branch"]
      .filter((k) => body?.[k] !== undefined);
    if (touched.length === 0) return null;
    return json({
      error:
        `${touched.join(", ")}: the delivery snapshot is not edited from here. It is what the reviewer ` +
        "approved, and the distance between it and the tip of the branch is information, not an error to " +
        "correct. If the branch moved on, or sits behind main, press \"Land on main\" again: the land " +
        "realigns the branch by itself and publishes the tip, saying in the thread what it realigned.",
      code: "invalid_input",
    }, 400);
  }

  /**
   * Resolve the board project id + the ACTOR behind a session key. Works for
   * BOTH a chat topic bound to a project and a Claude terminal tab (which has a
   * cwd but no chat topic). Returns null when the session is unbound.
   * `topicId` (chat sessions only) feeds the "own steps" carve-out: it lets the
   * service recognise subtasks of the task dispatched to THIS agent.
   *
   * ONE field, not two. This used to hand out a separate `author`, the topic
   * NAME, on the theory that a name is what reads well above a comment. For a
   * dispatched agent the topic name is the task title cut at 60 characters
   * (`task-dispatcher.ts`: `name: task.text.slice(0, 60)`), so what landed in
   * `task_comments.author` was half a sentence, and the card tooltip printed it
   * where a speaker's name belongs. The identity is the durable thing to store;
   * the label is derived when it is read (`shared/comment-author.ts`).
   */
  function resolveSession(sessionKey: string): { projectId: string; actor: string; topicId: string | null } | null {
    // The registry-backed coordinator never gains the ordinary session surface,
    // even if a stale/manual data mutation managed to add a project path. Its
    // only cross-board authority is the narrow wrapper below; this prevents a
    // special session from becoming a second project-scoped task principal.
    if (isGlobalOrchestratorSession(db, sessionKey)) return null;
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      // A dispatched agent's board is the board of the task bound to its topic,
      // NOT the topic's cwd: a catch-all ("generale") task runs in a per-task
      // private dir (<app data>/workspace/tasks/<id8>) that maps to no real
      // board, so cwd-derived scoping 404s every one of the agent's own task
      // ops. When the topic carries a bound task, scope to THAT board.
      const boundProject = topic.id ? svc.boardProjectForTopic(topic.id) : null;
      const projectId = boundProject ?? projectIdForPath(topic.projectPath);
      return {
        projectId,
        actor: topic.id ? `${AGENT_AUTHOR_PREFIX}${topic.id}` : AGENT_AUTHOR,
        topicId: topic.id ?? null,
      };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      // A terminal tab has no topic, so the actor is the session itself.
      return {
        projectId: projectIdForPath(term.cwd),
        actor: `${AGENT_AUTHOR_PREFIX}${sessionKey.slice(0, 16)}`,
        topicId: null,
      };
    }
    return null;
  }

  /**
   * The global board coordinator is an ordinary, unbound Topic. Its cross-board
   * authority does not come from its title, path, or an MCP policy: this
   * registry lookup is the sole role gate. Keep this separate from
   * `resolveSession`, which intentionally remains project-bound for every
   * ordinary session route below.
   */
  function resolveGlobalOrchestratorSession(sessionKey: string): { actor: string; topicId: string } | null {
    // The raw registry identity deliberately still blocks ordinary session
    // routes above. This *capability* route is stricter: a manually corrupted
    // bound/non-Codex row must not retain cross-board authority either.
    const registered = getEligibleGlobalOrchestratorSessionBySessionKey(db, sessionKey);
    if (!registered) return null;
    return {
      actor: `${AGENT_AUTHOR_PREFIX}${registered.topicId}`,
      topicId: registered.topicId,
    };
  }

  /**
   * The session a request speaks AS, which is not the session its URL names
   * (`lib/session-token.ts`, card cedadfc6). Every write below signs with the
   * returned actor and topic, never with `resolveSession`'s directly:
   *  - the session's token: the session itself;
   *  - someone else's token: 403, a forged signature is refused, not rewritten;
   *  - no token: an anonymous agent with no topic, so no comment, status row,
   *    step provenance or own-steps carve-out is credited to the topic in the
   *    path. The board scope stays the URL's: that is where, not who.
   */
  function provenSession(
    req: Request,
    sessionKey: string,
  ): { projectId: string; actor: string; topicId: string | null } | Response {
    const sess = resolveSession(sessionKey);
    if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
    const proof = sessionProof(req, topicsHome(), sessionKey);
    if (proof === "invalid") return sessionTokenRefusal();
    if (proof === "absent") return { projectId: sess.projectId, actor: AGENT_AUTHOR, topicId: null };
    return sess;
  }

  function sessionTokenRefusal(): Response {
    return json({
      error: "the session token does not belong to this session: an agent can only act as its own session",
      code: "session_token_mismatch",
    }, 403);
  }

  /**
   * The coordinator's cross-board surface is a capability, not a signature: a
   * caller that cannot prove it IS the registered coordinator gets nothing, so
   * here a missing token is a refusal too.
   */
  function provenGlobalOrchestrator(req: Request, sessionKey: string): { actor: string; topicId: string } | Response {
    const registered = resolveGlobalOrchestratorSession(sessionKey);
    if (!registered) {
      return json({ error: "global orchestrator session required", code: "global_orchestrator_required" }, 403);
    }
    if (sessionProof(req, topicsHome(), sessionKey) !== "valid") return sessionTokenRefusal();
    return registered;
  }

  /**
   * Global reads/mutations start from the task id and discover its board in
   * storage. A caller never supplies a project id for this path, so it cannot
   * turn a task id into cross-board authority by changing a request field.
   */
  function resolveGlobalTask(taskId: string) {
    const got = svc.get(taskId);
    return got ? { got, projectId: got.task.projectId } : null;
  }

  /**
   * The only caller-selected board is the target for a new task. Accept a
   * board id only when it is the id derived from one of this host's known
   * project directories. In particular, do not route through the historical
   * auto/catch-all resolver: a coordinator must name a real board explicitly.
   */
  function resolveExplicitGlobalBoard(rawBoardId: unknown): string | null {
    if (typeof rawBoardId !== "string") return null;
    const boardId = rawBoardId.trim();
    if (!boardId || boardId === AUTO_PROJECT_ID || boardId === UNASSIGNED_PROJECT_ID) return null;

    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { return null; }
    for (const rawPath of dirs) {
      if (typeof rawPath !== "string" || !rawPath.startsWith("/")) continue;
      const projectPath = rawPath.replace(/\/+$/, "") || "/";
      // `generale` is the old catch-all, not an explicit durable board target.
      if (basename(projectPath).toLowerCase() === "generale") continue;
      const knownBoardId = projectIdForPath(projectPath);
      if (knownBoardId === boardId) return knownBoardId;
    }
    return null;
  }

  /** Reject fields outside the focused global tool contract instead of ignoring them. */
  function rejectUnexpectedGlobalFields(
    body: unknown,
    allowed: readonly string[],
  ): Response | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const unexpected = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
    if (!unexpected.length) return null;
    return json({
      error: `global orchestrator does not accept: ${unexpected.join(", ")}`,
      code: "invalid_input",
    }, 400);
  }

  /**
   * `?status=` dal query string, SENZA `as any`.
   *
   * Il cast passava «in-progress» dritto al servizio, che lo metteva in un
   * `WHERE status = ?` dove non matcha niente: 200 con zero card. Una board
   * vuota è una risposta plausibilissima, quindi il refuso restava invisibile e
   * si andava a cercare il guasto nel dispatcher. Qui il dominio è chiuso e lo
   * sbaglio si dichiara — 400 con l'elenco degli stati veri. La stessa guardia
   * sta anche in `svc.list`, che è la porta comune: questa nomina il valore che
   * è arrivato dalla rete, quella copre chi il servizio lo chiama da dentro.
   */
  function asTaskStatus(raw: string | null | undefined): TaskStatus | undefined {
    if (!raw) return undefined;
    const found = TASK_STATUSES.find((s) => s === raw);
    if (!found) {
      throw new TaskServiceError("invalid_input", `stato "${raw}" inesistente: gli stati sono ${TASK_STATUSES.join(", ")}`);
    }
    return found;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
    // Un valore fuori da un dominio chiuso è colpa di chi chiama, non del
    // server: 400, e con la regola detta a parole. Prima usciva 500 col testo
    // grezzo di SQLite (`CHECK constraint failed: priority BETWEEN 0 AND 4`),
    // che manda a cercare un guasto dove non c'è e si legge solo sapendo che
    // esiste un CHECK. Vedi `checkConstraintBody` in task-patch.ts.
    const violated = checkConstraintBody(e);
    if (violated) return json(violated, 400);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  /**
   * Gate del fan-out sulla superficie AGENTE.
   *
   * Mentre N tentativi lavorano in parallelo lo STESSO task, il task appartiene
   * al GIRO, non a un agente: chi lo muove in review, lo rinomina o lo parcheggia
   * parlerebbe a nome di tutti — e il primo dei cinque a farlo deciderebbe per gli
   * altri quattro, prima ancora che l'umano veda un confronto. Il kickoff dei
   * tentativi lo dice a parole; questo lo rende vero anche se il modello legge di
   * fretta. Niente va perso: il dispatcher raccoglie l'ultima prosa di OGNI
   * tentativo e la mette nel confronto che scrive alla chiusura.
   *
   * Zero effetto sul dispatch normale: righe in `task_attempts` esistono solo per
   * un fan-out (`launch()` non ne crea nessuna).
   */
  /**
   * THE PRE-REVIEW CHECKS GATE, for the gestures that close a card.
   *
   * Not a ban: `force` overrides it, and it is there for the cases where you
   * know the red is harmless (a command that is beside the point, a known
   * failing test). Its job is to make the exception a CHOICE instead of the
   * silent default.
   *
   * It is one function because the gestures are TWO and for months it guarded
   * one: the gate lived inside the `approve` branch while `POST …/land` queued
   * the merge without looking at anything. Landing CONTAINS the acceptance and
   * puts the branch on main on top of it, so the less reversible of the two was
   * the only one with no gate. On a review card with a branch it was the green
   * button, too.
   *
   * The sentence is written for whoever reads it from the board: it names the
   * normal road, not a field of the JSON body. `force: true` stays in the code
   * comment (where it serves an API caller) and out of the message (where the
   * reader has no way to pass it).
   */
  function checksRedGate(projectId: string, taskId: string, force: unknown): Response | null {
    if (force === true) return null;
    let cur: { checksState?: string | null; checks?: Array<{ ok: boolean; name: string }> | null } | undefined;
    // The watchdog must never be able to block an acceptance: if the read
    // throws, the gesture goes through.
    try { cur = svc.get(taskId, { projectId })?.task; } catch { return null; }
    if (cur?.checksState !== "fail") return null;
    const red = (cur.checks ?? []).find((r) => !r.ok);
    return json({
      error:
        `the pre-review checks are RED${red ? ` (\`${red.name}\`)` : ""}. ` +
        "The normal road is to send it back to the agent; to accept it anyway use the card button that says \"anyway\".",
      code: "checks_failed",
    }, 409);
  }

  function fanOutGate(taskId: string, forbidden: string): Response | null {
    // A fan-out is recognised by its SIBLINGS: running rows on topics other
    // than the one the task is bound to. A single launch records its own row
    // as history, and counting that row gated every first turn with a 409.
    let running: TaskAttempt[] = [];
    try { running = attempts.list(taskId).filter((a) => a.state === "running"); } catch { return null; }
    const bound = svc.get(taskId)?.task.assignedTopicId ?? null;
    if (!running.some((a) => !bound || a.topicId !== bound)) return null;
    return json({
      error:
        `this task is in fan-out: ${running.length} parallel attempts are working the same task. ${forbidden}. ` +
        "work in YOUR worktree, commit everything on your branch, and end your turn with 2-3 sentences " +
        "describing what you did: the board composes the comparison from those.",
      code: "fanout_running",
    }, 409);
  }

  /**
   * The two structural gates a DELIVERY passes before the store sees the
   * PATCH, shared by the session route and the global coordinator route so
   * they cannot drift: (1) the worktree must be clean, or unreachable-but-
   * branchless; (2) the board's review checks must be green, with the 202
   * "still running" leg remembered in `pendingDeliveries` so the server can
   * re-issue THIS request on `pathname` when the run ends.
   *
   * The probe's `null` answer ("no branch worktree found") is refused when the
   * task has, or had, a branch: a worktree deleted before review or a topic
   * link broken by the release both mean "do not know", and in a gate that
   * means "no". A task that never had a branch (in-place work) passes.
   *
   * Questions are exempt: an agent asking mid-work legitimately has a dirty
   * worktree. "Is it a question" is `commentAsksHuman`, NOT the presence of
   * the ```question fence, which the server wraps around every options list
   * (measured 13/08: 331 of 437 fenced comments were deliveries).
   *
   * Returns the refusal (or the 202) to send, `null` when the PATCH may go on.
   */
  async function reviewDeliveryGate(
    taskId: string,
    projectId: string,
    body: Record<string, unknown> | null,
    legMs: number,
    pathname: string,
    chat: { sessionKey: string; topicId: string | null },
  ): Promise<Response | null> {
    if (body?.status !== "review") return null;
    let isDelivery = false;
    let reviewGateTask: ReturnType<typeof svc.get> | null = null;
    try {
      reviewGateTask = svc.get(taskId, { projectId });
      const lastOwn = reviewGateTask ? [...reviewGateTask.comments].reverse().find(
        (comment) => isAgentAuthor(comment.author) && comment.kind === "comment",
      ) : null;
      const isQuestion = commentAsksHuman(lastOwn?.content);
      isDelivery = !!reviewGateTask && reviewGateTask.task.status !== "review" && !isQuestion;
    } catch { /* best-effort: a store hiccup must never block a delivery */ }
    if (!isDelivery) return null;

    // THE USER'S OWN GATE COMES FIRST (HOOKS-02): a `task-deliver` hook that
    // exits non-zero refuses the move with a code of its own and its stderr
    // as the reason, the twin of the refusals below. It is the cheapest gate
    // of the chain, so it runs BEFORE the dirt probe and the checks: a rule
    // that says no must not cost a git status and a full check run first.
    // The command runs in the worktree of the card when there is one, else
    // in the repo root.
    if (opts?.hooks) {
      const ref = opts.taskCheckoutRef ? await opts.taskCheckoutRef(taskId).catch(() => null) : null;
      const cwd = ref?.cwd
        ?? opts.repoRootFor?.({ taskId, projectId, assignedTopicId: reviewGateTask?.task.assignedTopicId ?? null })
        ?? "";
      const verdict = await opts.hooks.run("task-deliver", {
        hook_event_name: "task-deliver",
        session_id: chat.sessionKey,
        cwd,
        task_id: taskId,
        project_id: projectId,
        commit: ref?.commit ?? null,
      });
      if (!verdict.ok) return json({ error: verdict.reason, code: "review_hook_refused" }, 409);
    }

    if (opts?.taskWorktreeDirtProbe) {
      try {
        const probe = await opts.taskWorktreeDirtProbe(taskId);
        if (probe === null) {
          const hasBranch =
            !!reviewGateTask?.task.deliveryBranch ||
            opts.taskHasBranchAttempt?.(taskId) === true;
          if (hasBranch) {
            return json({
              error:
                "cannot verify the worktree state: the branch worktree is no longer " +
                "reachable (the slot was released before review). " +
                "commit your work and ensure the worktree is still linked, " +
                "THEN set status='review'",
              code: "review_needs_commit",
            }, 409);
          }
        } else if (!probe.ok || probe.paths.length > 0) {
          const dirt = probe.paths;
          if (!probe.ok) {
            return json({
              error:
                "cannot read the worktree status (git status failed). " +
                "make sure your worktree has no uncommitted changes, " +
                "THEN set status='review'",
              code: "review_needs_commit",
            }, 409);
          }
          return json({
            error:
              `your worktree has ${dirt.length} uncommitted change${dirt.length === 1 ? "" : "s"} ` +
              `(${dirt.slice(0, 3).join(", ")}${dirt.length > 3 ? ", …" : ""}). ` +
              "commit them on your branch (or discard leftovers), THEN set status='review'",
            code: "review_needs_commit",
          }, 409);
        }
      } catch { /* best-effort: a git/store hiccup must never block a delivery */ }
    }

    // THE PREVIEW GATE, and it runs BEFORE the commands because it costs a
    // field read while they cost minutes: a delivery that cannot pass should
    // learn it now, not after the suite.
    //
    // It only ever looks at cards the board has ALREADY labelled `visibile`
    // (`deriveCloser`: they touch `client/src/**` outside the tests), which is
    // the narrow reading on purpose. A card whose label has not been derived
    // yet — the derivation happens further down the same delivery — is NOT
    // held back: the gate answers about what is written, never about what it
    // guesses will be written. `decisione` and `invisibile` pass untouched,
    // and so does a human moving a card by hand.
    //
    // Why only that class: asking every card for a preview manufactures
    // artefacts on deliveries with nothing to show, which is how a gate starts
    // producing evidence for itself instead of for the person reading it.
    const reviewLabels = reviewGateTask?.task.labels ?? [];
    if (reviewLabels.some((l) => l.label === "visibile")) {
      let preview = (reviewGateTask?.task.previewImage ?? "").trim();
      // AN AGENT ON THIS MACHINE CANNOT OPEN A BROWSER (kickoff rule), so it
      // can never produce the before/after shot itself. Before refusing, try
      // «Ricattura evidenza» (the same auto-capture the review edge and the
      // manual action use) ONCE: it boots the card's own worktree and shoots
      // it independently of any agent-side browser. Only if THAT still comes
      // back empty is the refusal the honest answer.
      if (!preview && opts?.preparePreview) {
        try { await opts.preparePreview(taskId); } catch { /* best-effort */ }
        preview = (svc.get(taskId, { projectId })?.task.previewImage ?? "").trim();
      }
      if (!preview) {
        return json({
          error:
            "this card is labelled `visibile` (it touches client/src), so the reviewer " +
            "opens it to LOOK at something. attach the durable evidence with " +
            "update_task(previewImage=<absolute path>): a screenshot of one state, a " +
            "clip of a behaviour, or a diagram. THEN set status='review'",
          code: "review_needs_preview",
        }, 409);
      }
    }

    // Second gate, AFTER the commit one: the commands run on committed code,
    // so it only makes sense once there is some. A red goes back to the agent
    // with the command output, the real reason, so the repair starts there.
    //
    // In LEGS, not in one breath: the run lives in the registry and this
    // request waits at most `legMs`. The 202 is not a verdict, it is "call
    // again": the task does not move until there is one, and the MCP client
    // (callUpdateTask) is the one that polls.
    const outcome = await runChecksGate(taskId, projectId, legMs).catch(() => null);
    const legInFlight = (task: Task | undefined) => json({
      pending: true,
      code: "review_checks_running",
      legMs,
      status: task?.status ?? null,
      checksState: task?.checksState ?? "running",
    }, 202);
    // THE SERVER STOPPED THE ROUND: nothing was measured, so this is neither a
    // red nor "no checks". Read as `null` it let the PATCH go on and the card
    // entered review with `checksState: running` on every watcher reload. The
    // answer is the one of a leg still in flight, not an error: the only
    // client (`callUpdateTask`) calls again, meets the closed socket and
    // retries it within its transport grace, and after the restart a fresh
    // round measures the delivery. A 503 was thrown at the agent instead, which
    // cannot wait a minute and called again into the dead server.
    if (outcome && "interrupted" in outcome) {
      // NOTHING WAS MEASURED, AND THE DELIVERY IS NOT LOST EITHER. The swap
      // brake's round restarts in THIS process (`settleDelivery`); the
      // shutdown's restarts in the NEXT one, from the row
      // (`resumePendingDeliveries`).
      //
      // A shutdown used to forget it here, and that was safe only while a card
      // turn held every planned reload back: the agent's leg came back after
      // the restart and asked again. Since 2026-09-16 a reload no longer waits
      // for a delivery whose checks are only waiting, so the leg may never come
      // back - the turn died with the process - and forgetting the delivery
      // would leave the card `in_progress` with nobody left to ask.
      if (body && typeof body === "object") rememberDelivery(taskId, pathname, body as Record<string, unknown>);
      return legInFlight(svc.get(taskId, { projectId })?.task);
    }
    if (outcome && "pending" in outcome) {
      // Remembered with the body as sent: the server re-issues THIS request
      // on the same path when the run ends, should the client stop polling -
      // or should the process itself go away first.
      if (body && typeof body === "object") rememberDelivery(taskId, pathname, body as Record<string, unknown>);
      const task = svc.get(taskId, { projectId })?.task;
      tellChatAboutChecksWait(chat.sessionKey, chat.topicId, taskId, projectId, task);
      return legInFlight(task);
    }
    forgetDeliveryMemo(taskId);
    checksWaitSince.delete(taskId);
    if (outcome && !outcome.ok) {
      return json({ error: outcome.comment, code: "review_needs_green_checks" }, 409);
    }
    return null;
  }

  /**
   * The global coordinator uses the same agent transition path as a normal
   * Topic session. It only differs in how the board and actor were resolved
   * (both server-side above), so review/done gates, delivery capture, checks,
   * and broadcasts cannot silently diverge from the ordinary task surface.
   */
  async function patchGlobalOrchestratorTask(
    taskId: string,
    projectId: string,
    session: { actor: string; sessionKey: string; topicId: string },
    body: Record<string, unknown> | null,
    pathname: string,
    origin: "mcp" | "api",
  ): Promise<Response> {
    const noDelivery = rejectDeliveryPatch(body);
    if (noDelivery) return noDelivery;
    const unexpected = rejectUnexpectedGlobalFields(
      body,
      ["status", "priority", "assignee", "text", "description", "summary", "legMs", "stage", "human_ask", "humanAsk", "bar", "source", "createdSource", "created_source"],
    );
    if (unexpected) return unexpected;
    // `legMs` is transport for the review-check polling loop, not a persisted
    // task field. Strip it before the normal agent patch parser sees the body.
    const legMs = clampLegMs(body?.legMs);
    if (body && typeof body === "object") delete body.legMs;

    const gatedDelivery = await reviewDeliveryGate(taskId, projectId, body, legMs, pathname, {
      sessionKey: session.sessionKey,
      topicId: session.topicId,
    });
    if (gatedDelivery) return gatedDelivery;

    const parsed = parseTaskPatch(body, "agent", acceptPreview);
    if (!parsed.ok) return json(unapplicableFieldsBody(parsed.errors), 400);
    try {
      // Re-read immediately before mutation. The project id used here came from
      // the task row, never from the caller, and this guard also handles a
      // concurrent removal/move as a normal not-found result.
      const prev = svc.get(taskId, { projectId })?.task;
      const prevStatus = prev?.status;
      let task = svc.update({
        taskId,
        actor: "agent",
        by: session.actor,
        origin,
        projectId,
        // Deliberately no `agentTopicId`: that ordinary dispatched-agent
        // ownership carve-out would make a registry-authorized cross-board
        // coordinator depend on whichever task happens to own its Topic.
        patch: parsed.patch,
        // What it has instead is the coordinator's own carve-out: closing a
        // card in AI review in place of an opener that has no chat to do it.
        asCoordinator: true,
      });
      if (prevStatus !== "done" && task.status === "done") requestCardProcessStop(opts, taskId);
      task = await captureDelivery(task, prevStatus);
      broadcastToAll({ type: "task:updated", projectId, task });
      if (task.status === "review" && prevStatus !== "review") void afterDelivery(projectId, taskId);
      // A registry-backed update changes a normal board card, not a parallel
      // status model. Preserve the board's queue accounting exactly: entering
      // Todo may be picked up by that board's configured dispatcher, while
      // leaving it cancels a queued grace timer. This is lifecycle accounting,
      // not a direct spawn/send/stop capability for the coordinator.
      if (dispatcher && prevStatus !== task.status) {
        if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
        else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
        if (task.status === "done") dispatcher.onBlockerDone(taskId);
      }
      // An AI review closed in the opener's place lands like a person's approval.
      if (prevStatus === "review" && prev?.stage === STAGE_AI_REVIEW && task.status === "done" && task.deliveryBranch) {
        enqueueLandOnDone(projectId, taskId, task.deliveryBranch);
      }
      emitReviewReadyEdge(broadcastToAll, projectId, task, prevStatus, undefined,
        () => svc.get(task.id)?.comments, prev?.stage ?? null);
      triggerUrlProbe(taskId, task.outputUrl ?? null, projectId);
      return json(task);
    } catch (e) { return fail(e); }
  }

  return { filterMedia, acceptPreview, rejectDeliveryPatch, resolveSession, resolveGlobalOrchestratorSession, provenSession, sessionTokenRefusal, provenGlobalOrchestrator, resolveGlobalTask, resolveExplicitGlobalBoard, rejectUnexpectedGlobalFields, asTaskStatus, fail, checksRedGate, fanOutGate, reviewDeliveryGate, patchGlobalOrchestratorTask };
}
