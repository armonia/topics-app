import { PARKED_WAITED_OUT } from "../../shared/board";
import { commentAuthorLabel } from "../../shared/comment-author";
import { CHECKS_LEG_MS } from "../services/checks-gate";
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";
import { ASK_RETRY_BACKOFF_MS, ASK_TRANSPORT_GRACE_MS, sleep } from "./ask-calls";

/**
 * Response shapes returned by the topics-app HTTP surface for the Phase-1
 * bridge tools. These live at a trust boundary (a remote process with no tsc
 * gate), so callers declare the field they read rather than passing `any`
 * around. Fields stay optional — the parsed body is still untrusted input and
 * each caller guards what it actually uses.
 */
export interface RunScriptResp { processId?: string; pid?: number }
interface ScriptRow {
  status?: string;
  scriptName?: string;
  processId?: string;
  pid?: number;
  ports?: number[];
  exitCode?: number | null;
}
interface ScriptsResp { scripts?: ScriptRow[] }
interface ProcessOutputResp {
  output?: string;
  offset?: number;
  status?: string;
  done?: boolean;
  exitCode?: number | null;
}
interface ProcessWaitResp extends ProcessOutputResp {
  reason?: string;
  waitedMs?: number;
  truncatedLines?: number;
  scriptName?: string;
}
interface TaskRow {
  status?: string;
  text?: string;
  id?: string;
  projectId?: string;
  project_id?: string;
  priority?: number;
  assignedTo?: string;
  assigned_to?: string;
  parentTaskId?: string | null;
  parent_task_id?: string | null;
}
interface TasksResp { tasks?: TaskRow[] }
/**
 * `pending` = i check pre-review stanno ancora girando (202). Non e' un esito:
 * il task non si e' mosso, e sta a noi rimetterci in fila con un'altra gamba.
 */
interface UpdateTaskResp { status?: string; id?: string; pending?: boolean }
interface CommentRow { id?: string; author?: string; content?: string }
interface GetTaskResp { task?: TaskRow; comments?: CommentRow[] }
interface CreateTaskResp { id?: string; status?: string }
interface CommentResp { id?: string }

/**
 * Shared HTTP helper for the Phase-1 bridge tools. Sends an optionally-bodied
 * request to topics-app, parses JSON tolerantly, and turns non-2xx / `{error}`
 * responses into thrown Errors (surfaced to the model as isError content).
 * Generic in the expected body shape `T` so each caller declares what it reads
 * instead of passing `any` across the trust boundary.
 * `callOpenBrowserPane` keeps its own bespoke impl for backwards compatibility.
 */

/**
 * Il sottoinsieme di `ResolvedTab` (server/lib/tab-resolver.ts) su cui questo
 * handler fa una guardia. Il corpo viene poi rigirato al modello tale e quale,
 * quindi non serve ricopiare qui l'intero tipo — e non lo si importa per la
 * stessa ragione delle altre righe qui sopra: questo processo vive dall'altra
 * parte di un confine di fiducia, senza un tsc che leghi le due parti.
 */
interface ResolveTabResp { kind?: unknown; state?: unknown }

/**
 * `GET /api/tabs/resolve` — da un permalink incollato dall'umano a «di quale tab
 * si parla e come se ne legge il contenuto». Un `ref` per chiamata, come la
 * rotta: l'alternativa (elencare tutte le tab) riverserebbe nel contesto url,
 * titoli e cwd di ogni finestra aperta.
 *
 * Un ref che la grammatica non riconosce è un 400 della rotta, che `httpJson`
 * trasforma in throw → il modello lo vede come tool error con il messaggio del
 * server («ref is not a tab permalink»), che è esattamente l'informazione utile.
 */
export async function callResolveTab(
  args: ParsedArgs,
  toolArgs: { ref?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.ref !== "string" || !toolArgs.ref.trim()) {
    throw new Error("resolve_tab: 'ref' (string) is required");
  }
  const path = `/api/tabs/resolve?ref=${encodeURIComponent(toolArgs.ref.trim())}`;
  const body = await httpJson<ResolveTabResp>(args, "GET", path, undefined, fetchImpl);
  if (!body || typeof body.kind !== "string") {
    throw new Error("resolve_tab: server did not return a resolved tab");
  }
  return JSON.stringify(body, null, 2);
}

export async function callListProcesses(
  args: ParsedArgs,
  _toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts`;
  const body = await httpJson<ScriptsResp>(args, "GET", path, undefined, fetchImpl);
  const scripts = Array.isArray(body?.scripts) ? body.scripts : [];
  if (!scripts.length) return "No processes running or recent.";
  return scripts.map((s: ScriptRow) => {
    const ports = Array.isArray(s.ports) && s.ports.length ? ` ports=${s.ports.join(",")}` : "";
    const exit = s.exitCode !== undefined && s.exitCode !== null ? ` exit=${s.exitCode}` : "";
    return `[${s.status}] ${s.scriptName} id=${s.processId} pid=${s.pid ?? "?"}${ports}${exit}`;
  }).join("\n");
}

export async function callReadProcessOutput(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown; offset?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("read_process_output: 'process_id' (string) is required");
  }
  const offset = typeof toolArgs.offset === "number" ? toolArgs.offset : 0;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/output?offset=${offset}`;
  const body = await httpJson<ProcessOutputResp>(args, "GET", path, undefined, fetchImpl);

  let output = typeof body?.output === "string" ? body.output : "";
  const MAX = 8000;
  let head = "";
  if (output.length > MAX) {
    output = output.slice(-MAX);
    head = "…(truncated, showing tail; call again with the returned offset to page)\n";
  }
  const exit = body?.exitCode !== undefined && body?.exitCode !== null ? ` exit=${body.exitCode}` : "";
  const footer = `[offset=${body?.offset ?? 0} status=${body?.status ?? "?"}${body?.done ? " done" : ""}${exit}]`;
  return `${head}${output}\n${footer}`;
}

/**
 * L'attesa vista dal ponte MCP. Il lavoro vero e' della rotta, che tiene aperta
 * la richiesta; qui si compone la risposta in modo che una scadenza si legga
 * come «ancora vivo» e non come un guasto — la differenza fra un agente che
 * richiama con il cursore giusto e uno che si ferma credendo di aver rotto
 * qualcosa.
 */
export async function callWaitForProcess(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown; until?: unknown; timeout_ms?: unknown; offset?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("wait_for_process: 'process_id' (string) is required");
  }
  const qs = new URLSearchParams();
  if (typeof toolArgs.offset === "number") qs.set("offset", String(toolArgs.offset));
  if (typeof toolArgs.timeout_ms === "number") qs.set("timeout_ms", String(toolArgs.timeout_ms));
  if (typeof toolArgs.until === "string" && toolArgs.until) qs.set("until", toolArgs.until);
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/wait?${qs}`;

  // Il margine sopra il tetto della rotta: se scade questo vuol dire che a non
  // rispondere e' il server, non il processo atteso.
  const budget = (typeof toolArgs.timeout_ms === "number" ? Math.min(toolArgs.timeout_ms, 240_000) : 120_000) + 20_000;
  // A stopped turn of the native runtime closes the request: left open, the
  // loop sat in it for minutes and the route's watch still counted the wake
  // as taken.
  const deadline = AbortSignal.timeout(budget);
  const signal = args.turnSignal ? AbortSignal.any([deadline, args.turnSignal]) : deadline; // allow-any: the method that joins two signals, not the type
  const body = await httpJson<ProcessWaitResp>(args, "GET", path, undefined, fetchImpl, signal);

  let output = typeof body?.output === "string" ? body.output : "";
  const MAX = 8000;
  let head = "";
  if (output.length > MAX) {
    output = output.slice(-MAX);
    head = "…(truncated, showing tail; re-read from the returned offset to page)\n";
  }
  const reason = body?.reason ?? "timeout";
  const secs = Math.round((body?.waitedMs ?? 0) / 1000);
  const exit = body?.exitCode !== undefined && body?.exitCode !== null ? ` exit=${body.exitCode}` : "";
  // A match on the last lines of a process that has ended: the route settles
  // its wake on this answer, so the outcome has to be in it.
  const ended = body?.status !== undefined && body.status !== "running";
  const verdict = reason === "exit"
    ? `finished after ${secs}s · status=${body?.status ?? "?"}${exit}`
    : reason === "match"
      ? `matched after ${secs}s · ${ended ? `finished · status=${body.status}${exit}` : "still running"}`
      : `STILL RUNNING after ${secs}s (not an error) · call wait_for_process again with offset=${body?.offset ?? 0}`;
  const lost = body?.truncatedLines ? ` dropped=${body.truncatedLines}` : "";
  return `${head}${output}\n[reason=${reason} offset=${body?.offset ?? 0}${lost}] ${verdict}`;
}

export async function callStopProcess(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("stop_process: 'process_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/stop`;
  await httpJson<{ ok?: boolean }>(args, "POST", path, {}, fetchImpl);
  return `stopped ${toolArgs.process_id}`;
}

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
  toolArgs: { task_id?: unknown; status?: unknown; priority?: unknown; assignee?: unknown; output_url?: unknown; text?: unknown; description?: unknown; preview_image?: unknown; previewImage?: unknown; summary?: unknown; stage?: unknown; human_ask?: unknown; bar?: unknown; source?: unknown },
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
  if (typeof toolArgs.stage === "string" && toolArgs.stage) patch.stage = toolArgs.stage;
  if (typeof toolArgs.human_ask === "string") patch.humanAsk = toolArgs.human_ask;
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
  toolArgs: { text?: unknown; description?: unknown; priority?: unknown; assignee?: unknown; idempotency_key?: unknown; parent_task_id?: unknown; allow_duplicate?: unknown; bar?: unknown },
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
  // La scappatoia del cancello sui doppioni deve passare da QUI: questa è la
  // porta da cui gli agenti aprono le card, e senza inoltro l'unico modo di
  // scavalcare un falso positivo è riscrivere il titolo storto finché passa,
  // cioè esattamente il guasto che il cancello doveva impedire.
  if (typeof toolArgs.bar === "string" && toolArgs.bar.trim()) reqBody.bar = toolArgs.bar;
  if (toolArgs.allow_duplicate === true) reqBody.allow_duplicate = true;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/tasks`;
  const res = await httpJson<CreateTaskResp>(args, "POST", path, reqBody, fetchImpl);
  const nested = typeof toolArgs.parent_task_id === "string" && toolArgs.parent_task_id
    ? ` (subtask of ${toolArgs.parent_task_id})`
    : "";
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
  toolArgs: { task_id?: unknown; status?: unknown; priority?: unknown; assignee?: unknown; text?: unknown; description?: unknown; summary?: unknown; stage?: unknown; human_ask?: unknown; bar?: unknown; source?: unknown },
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
    ...(typeof toolArgs.stage === "string" ? { stage: toolArgs.stage } : {}),
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
