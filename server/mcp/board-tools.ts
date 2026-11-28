/** Board tools: the task tools of a project session and the global coordinator task tools. */
import { PARKED_WAITED_OUT } from "../../shared/board";
import { commentAuthorLabel } from "../../shared/comment-author";
import { CHECKS_LEG_MS } from "../services/checks-gate";
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";
import { ASK_RETRY_BACKOFF_MS, ASK_TRANSPORT_GRACE_MS } from "./human-prompt-tools";
import { sleep, type CommentResp, type CreateTaskResp, type GetTaskResp, type TaskRow, type TasksResp, type UpdateTaskResp } from "./bridge-shared";

export async function callListTasks(
  args: ParsedArgs,
  toolArgs: { status?: unknown; scope?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const qs = new URLSearchParams();
  if (typeof toolArgs?.status === "string" && toolArgs.status) qs.set("status", toolArgs.status);
  // scope=all → the flat cross-project feed; default is the session's own project.
  if (toolArgs?.scope === "all") qs.set("scope", "all");
  const q = qs.toString() ? `?${qs}` : "";
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks${q}`;
  const body = await httpJson<TasksResp>(args, "GET", path, undefined, fetchImpl);
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  if (!tasks.length) return "No tasks.";
  // Uno STEP e' gia' in questa lista (la rotta non taglia le radici), ma finora
  // usciva identico a una card: stesso formato, nessun padre. Un agente che
  // rilegge la propria checklist dopo un cambio di sessione non poteva
  // distinguere i propri passi dalle card del board, e li leggeva come lavoro
  // di qualcun altro. Il padre e' l'unico dato che li separa: si stampa.
  return tasks.map((t: TaskRow) => {
    const parent = t.parentTaskId ?? t.parent_task_id ?? null;
    const meta = `id=${t.id} project=${t.projectId ?? t.project_id ?? "?"}${parent ? ` step of=${parent}` : ""}`;
    return `[${t.status}] ${t.text} (${meta})`;
  }).join("\n");
}

export async function callUpdateTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; status?: unknown; priority?: unknown; assignee?: unknown; output_url?: unknown; text?: unknown; description?: unknown; preview_image?: unknown; previewImage?: unknown; summary?: unknown; human_ask?: unknown; bar?: unknown; source?: unknown; blockedByTaskId?: unknown; blocked_by_task_id?: unknown },
  fetchImpl: typeof fetch = fetch,
  /**
   * Le manopole del ciclo a gambe: servono quando la consegna fa girare i check
   * pre-review, che durano minuti. I test le accorciano per non dormirci dentro.
   */
  opts: {
    legMs?: number;
    maxLegs?: number;
    transportGraceMs?: number;
    backoffMs?: number[];
    now?: () => number;
    /** Una riga per gamba mentre i check girano: e' cio' che tiene vivo il client. */
    onProgress?: (leg: number) => void;
  } = {},
  /** Narrow wrappers can reuse the same review-check polling protocol safely. */
  endpointPath?: string,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("update_task: 'task_id' (string) is required");
  }
  // Session-scoped: the server derives the project + agent identity from the
  // session key, so the caller never passes (or can spoof) project_id.
  const patch: Record<string, unknown> = {};
  if (typeof toolArgs.status === "string" && toolArgs.status) patch.status = toolArgs.status;
  if (typeof toolArgs.priority === "number") patch.priority = toolArgs.priority;
  if (typeof toolArgs.assignee === "string") patch.assignee = toolArgs.assignee;
  // Empty string is a meaningful value here (clears the output), so no truthiness guard.
  if (typeof toolArgs.output_url === "string") patch.output_url = toolArgs.output_url;
  if (typeof toolArgs.text === "string" && toolArgs.text.trim()) patch.text = toolArgs.text;
  if (typeof toolArgs.description === "string") patch.description = toolArgs.description;
  if (typeof toolArgs.bar === "string") patch.bar = toolArgs.bar;
  if (typeof toolArgs.source === "string") patch.source = toolArgs.source;
  // L'ANTEPRIMA. Mancava, e il protocollo la documentava: `docs/board-protocol.md`
  // dice `update_task(previewImage=…)` e l'envelope di dispatch porta quel testo a
  // ogni agente — ma lo schema di questo tool non aveva il campo, quindi il
  // parametro veniva scartato in SILENZIO. Tre consegne di fila hanno scritto
  // «anteprima allegata» con la card vuota, e sembravano bugie: erano agenti che
  // seguivano il protocollo mentre lo strumento buttava via il valore.
  // La rotta REST lo accettava gia' (routes/tasks.ts) e lo passa per l'allowlist
  // `filterMedia`, che resta l'unico cancello: qui non si valida il path, si
  // smette solo di perderlo per strada.
  // DUE nomi accettati, e non e' pigrizia. Il protocollo canonico e i due
  // envelope (kickoff e resume) insegnano `previewImage` in camelCase da sempre;
  // lo schema di questo tool usa snake_case come tutti i suoi parametri. Un
  // agente che obbedisce al testo che ha ricevuto scrive `previewImage`, e con
  // un solo nome accettato tornerebbe a perdersi in silenzio — lo stesso guasto
  // che ho appena chiuso, riaperto dal lato del nome. Il doctor l'ha trovato in
  // questa forma: «il protocollo insegna previewImage, lo schema dichiara
  // preview_image». Finche' le due parole convivono nei prompt, il tool le
  // accetta entrambe.
  const anteprima = typeof toolArgs.preview_image === "string" ? toolArgs.preview_image
    : typeof (toolArgs as { previewImage?: unknown }).previewImage === "string" ? (toolArgs as { previewImage?: string }).previewImage
    : undefined;
  if (anteprima !== undefined) patch.previewImage = anteprima;
  // THE DELIVERY IN WORDS. It travels only alongside a status: on its own it
  // describes nothing, and the server would refuse it as the only field of a
  // patch that does not move the card. An EMPTY summary is not dropped here —
  // the service gate refuses it and can say why it is needed; dropping it here
  // would answer "no field to change", which is the answer to another question.
  if (typeof toolArgs.summary === "string" && patch.status !== undefined) patch.summary = toolArgs.summary;
  // The workflow column and the question for the person (`shared/workflow.ts`).
  if (typeof toolArgs.human_ask === "string") patch.humanAsk = toolArgs.human_ask;
  // Same wiring, same reason, as `callCreateTask`: a future step is a card
  // with this field set, never a promise in a comment.
  const blockedBy = typeof toolArgs.blockedByTaskId === "string" ? toolArgs.blockedByTaskId
    : typeof toolArgs.blocked_by_task_id === "string" ? toolArgs.blocked_by_task_id
    : undefined;
  if (blockedBy !== undefined) patch.blockedByTaskId = blockedBy || null;
  if (Object.keys(patch).length === 0) {
    throw new Error("update_task: provide at least one of 'status', 'priority', 'assignee', 'output_url', 'text', 'description', 'bar', 'source', 'preview_image'");
  }
  const path = endpointPath
    ?? `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks/${encodeURIComponent(toolArgs.task_id)}`;
  // La gamba viaggia nel corpo e il server la strappa via prima di leggere la
  // patch: e' trasporto, non un campo del task.
  const legMs = opts.legMs ?? CHECKS_LEG_MS;
  // Solo la consegna può far girare i check, quindi solo la consegna porta la
  // gamba: ogni altra patch resta identica al byte a com'era prima.
  const payload = patch.status === "review" ? { ...patch, legMs } : patch;
  const maxLegs = opts.maxLegs ?? CHECKS_MAX_LEGS;
  const graceMs = opts.transportGraceMs ?? ASK_TRANSPORT_GRACE_MS;
  const backoff = opts.backoffMs ?? ASK_RETRY_BACKOFF_MS;
  const now = opts.now ?? Date.now;

  let transportFailures = 0;
  let firstFailureAt: number | null = null;
  for (let leg = 0; leg < maxLegs; leg++) {
    let body: UpdateTaskResp | undefined;
    try {
      body = await httpJson<UpdateTaskResp>(args, "PATCH", path, payload, fetchImpl);
      transportFailures = 0;
      firstFailureAt = null;
    } catch (err) {
      // Il server HA parlato (un 409 di check rossi, un 400): quello e' l'esito,
      // e ritentarlo sarebbe solo rumore. Si ritenta il silenzio, e solo mentre
      // c'e' una corsa da non buttare via: alla prima gamba il comportamento
      // resta quello di sempre, l'errore esce subito.
      const spoke = err instanceof Error && /^HTTP \d/.test(err.message);
      if (spoke || leg === 0) throw err;
      transportFailures++;
      if (firstFailureAt === null) firstFailureAt = now();
      const downMs = now() - firstFailureAt;
      if (downMs > graceMs) {
        throw new Error(
          `update_task: lost contact with topics-app for ${Math.round(downMs / 1000)}s over ${transportFailures} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await sleep(backoff[Math.min(transportFailures - 1, backoff.length - 1)] ?? 0);
      continue;
    }

    if (body?.pending) {
      // I check pre-review stanno ancora girando nel worktree. Dirlo AD ALTA
      // VOCE a ogni gamba: il silenzio e' cio' che un client MCP legge come
      // chiamata piantata, ed e' l'unica moneta con cui un gate da dieci minuti
      // si compra il tempo che gli serve.
      opts.onProgress?.(leg + 1);
      continue;
    }
    return `task ${toolArgs.task_id} → ${body?.status ?? (typeof patch.status === "string" ? patch.status : "updated")}`;
  }
  throw new Error(
    `update_task: i check pre-review girano da oltre ${Math.round((maxLegs * legMs) / 60_000)} minuti e non hanno ancora un esito. La consegna si completa DA SOLA quando finiscono: la card passa in review se sono verdi, resta in lavorazione con il rosso nel thread se no. Non richiamare update_task e non consegnare di nuovo: chiudi il turno.`,
  );
}

/**
 * Tetto ANTI-GIRO A VUOTO sulle gambe di `update_task`, non la vita dei check.
 *
 * A dire che i check sono finiti e' il SERVER, che risponde con l'esito (verde:
 * il task passa in review; rosso: un 409 con l'output). Questo numero esiste
 * solo perche' un server incastrato che risponde `pending` per sempre non faccia
 * girare qui dentro un ciclo eterno.
 *
 * 240 legs of 25 s are 100 minutes (15/09/2026): above the 60-minute deadline of
 * the pull request CI wait (`CI_E2E_DEADLINE_MS`, KANBAN-84) plus the slowest
 * local round measured between 08/09 and 15/09 (29.2 minutes), and below the
 * `MCP_TOOL_TIMEOUT` that `buildSafeEnv` gives the CLI (`ASK_TRANSPORT_CEILING_MS`), so
 * the agent gets the bridge's "it completes by itself" message, not a transport error.
 */
export const CHECKS_MAX_LEGS = 240;

export async function callCreateTask(
  args: ParsedArgs,
  toolArgs: { text?: unknown; description?: unknown; priority?: unknown; assignee?: unknown; idempotency_key?: unknown; parent_task_id?: unknown; allow_duplicate?: unknown; bar?: unknown; wait_reason?: unknown; wait_minutes?: unknown; blockedByTaskId?: unknown; blocked_by_task_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.text !== "string" || !toolArgs.text.trim()) {
    throw new Error("create_task: 'text' (string) is required");
  }
  const reqBody: Record<string, unknown> = { text: toolArgs.text };
  if (typeof toolArgs.description === "string") reqBody.description = toolArgs.description;
  if (typeof toolArgs.priority === "number") reqBody.priority = toolArgs.priority;
  if (typeof toolArgs.assignee === "string") reqBody.assignee = toolArgs.assignee;
  if (typeof toolArgs.idempotency_key === "string") reqBody.idempotency_key = toolArgs.idempotency_key;
  if (typeof toolArgs.parent_task_id === "string" && toolArgs.parent_task_id) reqBody.parent_task_id = toolArgs.parent_task_id;
  // A FUTURE STEP IS A CARD WITH A REAL LINK, NEVER A PROMISE IN A COMMENT
  // (task-dispatcher-kickoff.ts, docs/board-protocol.md). Without this, the
  // field was silently dropped: the card born here had no way to say what it
  // was waiting on, exactly what the 17-24/11 incident shipped. Two accepted
  // names for the same reason `previewImage`/`preview_image` both are: the
  // kickoff prose teaches `blockedByTaskId` camelCase, this tool's own
  // parameters are snake_case.
  const blockedBy = typeof toolArgs.blockedByTaskId === "string" ? toolArgs.blockedByTaskId
    : typeof toolArgs.blocked_by_task_id === "string" ? toolArgs.blocked_by_task_id
    : undefined;
  if (blockedBy) reqBody.blockedByTaskId = blockedBy;
  // La scappatoia del cancello sui doppioni deve passare da QUI: questa è la
  // porta da cui gli agenti aprono le card, e senza inoltro l'unico modo di
  // scavalcare un falso positivo è riscrivere il titolo storto finché passa,
  // cioè esattamente il guasto che il cancello doveva impedire.
  if (typeof toolArgs.bar === "string" && toolArgs.bar.trim()) reqBody.bar = toolArgs.bar;
  if (toolArgs.allow_duplicate === true) reqBody.allow_duplicate = true;
  if (typeof toolArgs.wait_reason === "string" && toolArgs.wait_reason.trim()) reqBody.wait_reason = toolArgs.wait_reason;
  if (typeof toolArgs.wait_minutes === "number") reqBody.wait_minutes = toolArgs.wait_minutes;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks`;
  const res = await httpJson<CreateTaskResp>(args, "POST", path, reqBody, fetchImpl);
  const nested = typeof toolArgs.parent_task_id === "string" && toolArgs.parent_task_id
    ? ` (subtask of ${toolArgs.parent_task_id})`
    : "";
  // A repeated request is ABSORBED into the open twin, not created new — say
  // so, or the caller believes a fresh card exists when none was made
  // (review feedback, 26/11, point 5).
  if (res?.deduped) return `deduplicated into existing task ${res?.id ?? "?"} [${res?.status ?? "backlog"}]${nested}: ${toolArgs.text}`;
  return `created task ${res?.id ?? "?"} [${res?.status ?? "backlog"}]${nested}: ${toolArgs.text}`;
}

export async function callGetTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("get_task: 'task_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks/${encodeURIComponent(toolArgs.task_id)}`;
  const res = await httpJson<GetTaskResp>(args, "GET", path, undefined, fetchImpl);
  const t = res?.task;
  if (!t) return `Task ${toolArgs.task_id} not found.`;
  const who = t.assignedTo ?? t.assigned_to;
  const head = `[${t.status}] ${t.text} (id=${t.id}${who ? ` @${who}` : ""})`;
  const parts = [head];
  const children = Array.isArray((res as { children?: TaskRow[] })?.children) ? (res as { children?: TaskRow[] }).children! : [];
  if (children.length) {
    parts.push("subtasks:");
    for (const c of children) parts.push(`  [${c.status}] ${c.text} (id=${c.id})`);
  }
  const comments = Array.isArray(res?.comments) ? res.comments : [];
  if (!comments.length) { parts.push("(no comments)"); return parts.join("\n"); }
  parts.push("comments:");
  // Same derived label the board prints. Reading the raw author here handed the
  // model a truncated task title as the name of the speaker, on every thread
  // written before 13/08/2026.
  for (const c of comments) parts.push(`  ${commentAuthorLabel(c.author).label}: ${c.content ?? ""}`);
  return parts.join("\n");
}

export async function callWaitForCondition(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; reason?: unknown; minutes?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("wait_for_condition: 'task_id' (string) is required");
  }
  if (typeof toolArgs?.reason !== "string" || !toolArgs.reason.trim()) {
    throw new Error("wait_for_condition: 'reason' (string) is required");
  }
  const reqBody: Record<string, unknown> = { reason: toolArgs.reason };
  if (typeof toolArgs.minutes === "number" && Number.isFinite(toolArgs.minutes)) reqBody.minutes = toolArgs.minutes;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks/${encodeURIComponent(toolArgs.task_id)}/defer`;
  const res = await httpJson<{ dispatchDeferredUntil?: string; dispatchState?: string }>(args, "POST", path, reqBody, fetchImpl);
  // Il server può RIFIUTARE l'attesa: troppe di fila sulla stessa condizione, o
  // una serie troppo lunga, e il task si parcheggia perché decida un umano.
  // Dirlo qui non è cortesia. La riga di prima prometteva «it will be
  // re-dispatched automatically» in ogni caso, e un agente che la legge dopo un
  // rifiuto crede di dover solo aspettare: chiude il turno convinto che il task
  // riparta da solo, e quello resta fermo in backlog senza che nessuno lo sappia.
  if (res?.dispatchState === PARKED_WAITED_OUT) {
    return `task ${toolArgs.task_id} has already waited on this same condition, so it is now PARKED in the backlog for a human to decide. It will NOT be re-dispatched automatically. Your turn is done: do not move it to review, and do not call wait_for_condition again.`;
  }
  const until = res?.dispatchDeferredUntil ? ` until ${res.dispatchDeferredUntil}` : "";
  return `task ${toolArgs.task_id} released to the queue, waiting${until}. It will be re-dispatched automatically. Your turn is done — do not move it to review.`;
}

export async function callWaitForMail(
  args: ParsedArgs,
  toolArgs: { mailbox?: unknown; from?: unknown; subject_contains?: unknown; thread_id?: unknown; in_reply_to?: unknown; since?: unknown; expires_at?: unknown; expires_in_minutes?: unknown; task_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  for (const name of ["mailbox", "from"] as const) {
    if (typeof toolArgs?.[name] !== "string" || !(toolArgs[name] as string).trim()) throw new Error(`wait_for_mail: '${name}' (string) is required`);
  }
  const body: Record<string, unknown> = { mailbox: toolArgs.mailbox, from: toolArgs.from };
  for (const name of ["subject_contains", "thread_id", "in_reply_to", "since", "expires_at", "task_id"] as const) {
    if (typeof toolArgs[name] === "string" && toolArgs[name]) body[name] = toolArgs[name];
  }
  if (typeof toolArgs.expires_in_minutes === "number" && Number.isFinite(toolArgs.expires_in_minutes)) body.expires_in_minutes = toolArgs.expires_in_minutes;
  if (!body.expires_at && body.expires_in_minutes === undefined) throw new Error("wait_for_mail: a deadline is required ('expires_at' or 'expires_in_minutes')");
  const res = await httpJson<{ waitId?: string; status?: string; parked?: boolean; expiresAt?: string }>(args, "POST", `/api/sessions/${encodeURIComponent(args.sessionKey)}/mail-waits`, body, fetchImpl);
  if (res?.status === "matched") {
    return `The mail had ALREADY arrived (wait ${res.waitId}). Nothing to wait for: carry on.`;
  }
  const tail = res?.parked
    ? "The task is parked on this wait until the mail arrives or the deadline passes. Your turn is done: do not move it to review, and do not call wait_for_condition."
    : "You will get ONE message in this chat when the mail arrives, or when the deadline passes without it. You may end your turn.";
  return `Waiting for the mail (wait ${res?.waitId}, until ${res?.expiresAt ?? "the deadline"}). ${tail}`;
}

export async function callCancelMailWait(
  args: ParsedArgs,
  toolArgs: { wait_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.wait_id !== "string" || !toolArgs.wait_id) throw new Error("cancel_mail_wait: 'wait_id' (string) is required");
  const res = await httpJson<{ cancelled?: boolean }>(args, "DELETE", `/api/sessions/${encodeURIComponent(args.sessionKey)}/mail-waits/${encodeURIComponent(toolArgs.wait_id)}`, undefined, fetchImpl);
  return res?.cancelled ? `Wait ${toolArgs.wait_id} cancelled: no wake will follow.` : `Wait ${toolArgs.wait_id} was not open any more (already completed or cancelled).`;
}

export async function callLabelTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; labels?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("label_task: 'task_id' (string) is required");
  }
  if (!Array.isArray(toolArgs?.labels)) {
    throw new Error("label_task: 'labels' (array of strings) is required — send the FULL set to keep");
  }
  const labels = toolArgs.labels.filter((l): l is string => typeof l === "string" && !!l.trim());
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks/${encodeURIComponent(toolArgs.task_id)}/labels`;
  // Il 403 di `invisibile` arriva da qui come errore del tool, con il testo del
  // server: l'agente deve LEGGERE perché è stato rifiutato, non ritentare.
  const res = await httpJson<{ labels?: Array<{ label: string }> }>(args, "PUT", path, { labels }, fetchImpl);
  const set = (res?.labels ?? []).map((l) => l.label);
  return set.length
    ? `task ${toolArgs.task_id} labels: ${set.join(", ")}`
    : `task ${toolArgs.task_id} has no labels`;
}

export async function callCommentTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; content?: unknown; mentions?: unknown; options?: unknown; media?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("comment_task: 'task_id' (string) is required");
  }
  if (typeof toolArgs?.content !== "string" || !toolArgs.content.trim()) {
    throw new Error("comment_task: 'content' (string) is required");
  }
  const reqBody: Record<string, unknown> = { content: toolArgs.content };
  if (Array.isArray(toolArgs.mentions)) reqBody.mentions = toolArgs.mentions;
  if (Array.isArray(toolArgs.media)) {
    const media = toolArgs.media.filter((m): m is string => typeof m === "string" && m.startsWith("/"));
    if (media.length > 0) reqBody.media = media;
  }
  // Human-decision request: pass the choices as data — the SERVER composes the
  // canonical question block, the model never hand-writes the markdown format.
  const options = Array.isArray(toolArgs.options)
    ? toolArgs.options.filter((o): o is string => typeof o === "string" && !!o.trim())
    : [];
  if (options.length > 0) reqBody.options = options;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks/${encodeURIComponent(toolArgs.task_id)}/comments`;
  const res = await httpJson<CommentResp>(args, "POST", path, reqBody, fetchImpl);
  const suffix = options.length > 0 ? ` with ${options.length} quick-reply options` : "";
  return `commented on ${toolArgs.task_id}${res?.id ? ` (${res.id})` : ""}${suffix}`;
}

function globalTasksCollectionPath(args: ParsedArgs): string {
  return `/api/orchestrator-sessions/${encodeURIComponent(args.sessionKey)}/tasks`;
}

function globalTaskItemPath(args: ParsedArgs, taskId: string): string {
  return `${globalTasksCollectionPath(args)}/${encodeURIComponent(taskId)}`;
}

/**
 * The registry-gated global profile uses different endpoints on purpose.  It
 * must never piggyback on the ordinary `/api/sessions/:key/tasks` contract,
 * whose authority remains a project-bound session.
 */
export async function callListGlobalTasks(
  args: ParsedArgs,
  toolArgs: { status?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const qs = new URLSearchParams();
  if (typeof toolArgs?.status === "string" && toolArgs.status) qs.set("status", toolArgs.status);
  const query = qs.toString();
  const body = await httpJson<TasksResp>(
    args,
    "GET",
    `${globalTasksCollectionPath(args)}${query ? `?${query}` : ""}`,
    undefined,
    fetchImpl,
  );
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  if (!tasks.length) return "No global tasks.";
  return tasks.map((t: TaskRow) => {
    const parent = t.parentTaskId ?? t.parent_task_id ?? null;
    const meta = `id=${t.id} board=${t.projectId ?? t.project_id ?? "?"}${parent ? ` step of=${parent}` : ""}`;
    return `[${t.status}] ${t.text} (${meta})`;
  }).join("\n");
}

export async function callGetGlobalTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("get_global_task: 'task_id' (string) is required");
  }
  const res = await httpJson<GetTaskResp>(
    args, "GET", globalTaskItemPath(args, toolArgs.task_id), undefined, fetchImpl,
  );
  const task = res?.task;
  if (!task) return `Task ${toolArgs.task_id} not found.`;
  const who = task.assignedTo ?? task.assigned_to;
  const lines = [
    `[${task.status}] ${task.text} (id=${task.id}${who ? ` @${who}` : ""})`,
  ];
  const children = Array.isArray((res as { children?: TaskRow[] })?.children)
    ? (res as { children?: TaskRow[] }).children!
    : [];
  if (children.length) {
    lines.push("subtasks:");
    for (const child of children) lines.push(`  [${child.status}] ${child.text} (id=${child.id})`);
  }
  const comments = Array.isArray(res?.comments) ? res.comments : [];
  if (!comments.length) return `${lines.join("\n")}\n(no comments)`;
  lines.push("comments:");
  for (const comment of comments) {
    lines.push(`  ${commentAuthorLabel(comment.author).label}: ${comment.content ?? ""}`);
  }
  return lines.join("\n");
}

export async function callCreateGlobalTask(
  args: ParsedArgs,
  toolArgs: { board_id?: unknown; text?: unknown; description?: unknown; priority?: unknown; assignee?: unknown; idempotency_key?: unknown; allow_duplicate?: unknown; bar?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.board_id !== "string" || !toolArgs.board_id.trim()) {
    throw new Error("create_global_task: 'board_id' (string) is required and must name an existing board");
  }
  if (typeof toolArgs?.text !== "string" || !toolArgs.text.trim()) {
    throw new Error("create_global_task: 'text' (string) is required");
  }
  const body: Record<string, unknown> = { board_id: toolArgs.board_id.trim(), text: toolArgs.text };
  if (typeof toolArgs.description === "string") body.description = toolArgs.description;
  if (typeof toolArgs.priority === "number") body.priority = toolArgs.priority;
  if (typeof toolArgs.assignee === "string") body.assignee = toolArgs.assignee;
  if (typeof toolArgs.idempotency_key === "string") body.idempotency_key = toolArgs.idempotency_key;
  if (typeof toolArgs.bar === "string" && toolArgs.bar.trim()) body.bar = toolArgs.bar;
  if (toolArgs.allow_duplicate === true) body.allow_duplicate = true;
  const result = await httpJson<CreateTaskResp>(args, "POST", globalTasksCollectionPath(args), body, fetchImpl);
  return `created task ${result?.id ?? "?"} [${result?.status ?? "backlog"}] on board ${toolArgs.board_id}: ${toolArgs.text}`;
}

export async function callUpdateGlobalTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; status?: unknown; priority?: unknown; assignee?: unknown; text?: unknown; description?: unknown; summary?: unknown; human_ask?: unknown; bar?: unknown; source?: unknown },
  fetchImpl: typeof fetch = fetch,
  opts: {
    legMs?: number;
    maxLegs?: number;
    transportGraceMs?: number;
    backoffMs?: number[];
    now?: () => number;
    onProgress?: (leg: number) => void;
  } = {},
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("update_global_task: 'task_id' (string) is required");
  }
  // Build a positive allowlist before delegating to the shared review/check
  // polling logic. A raw MCP caller cannot smuggle preview URLs or any future
  // ordinary-task-only field through this focused profile.
  const allowed = {
    task_id: toolArgs.task_id,
    ...(typeof toolArgs.status === "string" ? { status: toolArgs.status } : {}),
    ...(typeof toolArgs.priority === "number" ? { priority: toolArgs.priority } : {}),
    ...(typeof toolArgs.assignee === "string" ? { assignee: toolArgs.assignee } : {}),
    ...(typeof toolArgs.text === "string" ? { text: toolArgs.text } : {}),
    ...(typeof toolArgs.description === "string" ? { description: toolArgs.description } : {}),
    ...(typeof toolArgs.summary === "string" ? { summary: toolArgs.summary } : {}),
    ...(typeof toolArgs.human_ask === "string" ? { human_ask: toolArgs.human_ask } : {}),
    ...(typeof toolArgs.bar === "string" ? { bar: toolArgs.bar } : {}),
    ...(typeof toolArgs.source === "string" ? { source: toolArgs.source } : {}),
  };
  const result = await callUpdateTask(
    args,
    allowed,
    fetchImpl,
    opts,
    globalTaskItemPath(args, toolArgs.task_id),
  );
  return result.replace(/^task /, "global task ");
}

export async function callCommentGlobalTask(
  args: ParsedArgs,
  toolArgs: { task_id?: unknown; content?: unknown; options?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.task_id !== "string" || !toolArgs.task_id) {
    throw new Error("comment_global_task: 'task_id' (string) is required");
  }
  if (typeof toolArgs?.content !== "string" || !toolArgs.content.trim()) {
    throw new Error("comment_global_task: 'content' (string) is required");
  }
  const body: Record<string, unknown> = { content: toolArgs.content };
  if (Array.isArray(toolArgs.options)) {
    const options = toolArgs.options.filter((option): option is string => typeof option === "string" && !!option.trim());
    if (options.length) body.options = options;
  }
  const result = await httpJson<CommentResp>(
    args,
    "POST",
    `${globalTaskItemPath(args, toolArgs.task_id)}/comments`,
    body,
    fetchImpl,
  );
  return `commented on ${toolArgs.task_id}${result?.id ? ` (${result.id})` : ""}`;
}
