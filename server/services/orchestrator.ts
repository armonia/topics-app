/**
 * L'orchestratore: una SESSIONE con la board davanti, non un pannello.
 *
 * Il principio che tiene tutto: non è una superficie. Chat e composer della
 * board sono due PORTE sulla stessa cosa — un topic normale, con i suoi
 * messaggi e i suoi tool. Perciò tutto ciò che decide qualcosa sta QUI, e le
 * superfici si limitano a chiamare `orchestratorTurn`. Una terza porta domani
 * costa una riga.
 *
 * La decisione che costa: lo stato della board NON si accumula.
 * La conversazione persiste (ricorda cosa gli hai chiesto), lo snapshot della
 * board no: `boardSnapshotContent` viene rieseguito a OGNI turno e il suo
 * blocco viaggia nello slot volatile `board` (`server/context/adapt.ts`), che
 * per costruzione non si deduplica mai. Due ragioni, e la seconda pesa di più:
 *
 *  1. Costo — uno snapshot per turno che resta nella storia la gonfia senza
 *     limite, e la storia si rilegge a ogni chiamata (costo COMPOSTO).
 *  2. Verità — uno snapshot vecchio non è solo caro, MENTE. L'orchestratore
 *     ricorderebbe una card in `todo` quando è `done`, e agirebbe su quella.
 *
 * Le mani ce l'ha già: `list_tasks`/`get_task`/`create_task`/`update_task`/
 * `comment_task` sono tool MCP che ogni sessione ha. Quello che NON deve avere
 * sono i tool di sotto-agente (spawn/send/stop): un orchestratore che spawna
 * agenti fuori dalla board è un secondo dispatcher non governato. Il cancello
 * è il profilo `orchestrator` in `server/mcp/topics-mcp-server.ts`.
 */

import type { Task, TaskStatus } from "./tasks";
import type { Topic } from "../types";

/**
 * Il valore di `topics.mcp_policy` che dice «questa è LA sessione-orchestratore
 * di questo progetto».
 *
 * Una sola colonna per una sola decisione: la stessa riga sceglie il profilo di
 * tool del bridge MCP e l'iniezione dello snapshot di board. Tenerle su due
 * campi vorrebbe dire poterle far divergere — una sessione con lo snapshot e
 * senza le mani, o viceversa — e nessuno dei due stati ha senso. Se un giorno
 * servisse una colonna dedicata, `isOrchestratorTopic` è l'unico punto da
 * cambiare: nessun chiamante legge `mcpPolicy` da sé.
 */
export const ORCHESTRATOR_MCP_POLICY = "orchestrator";

/** Il nome del topic-orchestratore di un progetto. Anche la chiave di lookup. */
export function orchestratorTopicName(projectName: string): string {
  return `Orchestratore · ${projectName}`;
}

export function isOrchestratorTopic(topic: Topic | null | undefined): boolean {
  return !!topic && topic.mcpPolicy === ORCHESTRATOR_MCP_POLICY;
}

// ────────────────────────────────────────────────────────────────────────────
// Lo snapshot della board
// ────────────────────────────────────────────────────────────────────────────

/**
 * Quante card entrano nello snapshot. Oltre, si dichiara quante ne restano
 * fuori: un elenco troncato in silenzio è la stessa bugia di uno snapshot
 * vecchio — l'orchestratore concluderebbe «non c'è» da un elenco che non ha
 * mai visto per intero. Con quel numero davanti sa che deve chiamare
 * `list_tasks`.
 */
export const SNAPSHOT_MAX_TASKS = 60;

/** L'ordine in cui le colonne compaiono nello snapshot: quello della board. */
const STATUS_ORDER: TaskStatus[] = ["in_progress", "review", "todo", "backlog", "done"];

const PRIORITY_LABEL = ["minima", "bassa", "media", "alta", "urgente"];

export interface BoardSnapshotDeps {
  /** Le card ROOT del progetto, lette ADESSO. Mai una copia tenuta da parte. */
  listTasks: (projectId: string) => Task[];
}

/**
 * Lo stato della board in testo, LETTO IN QUESTO MOMENTO.
 *
 * Formato pensato per essere agito, non ammirato: ogni riga porta l'id, perché
 * la mossa successiva dell'orchestratore è `update_task(task_id=…)` e senza id
 * dovrebbe ri-listare per ogni card che tocca.
 *
 * `done` è nell'elenco ma in coda e senza dettagli: serve a rispondere «a che
 * punto siamo» (quante ne sono uscite) senza pagare la storia intera del
 * progetto a ogni turno.
 */
export function boardSnapshotContent(deps: BoardSnapshotDeps, projectId: string): string {
  const all = deps.listTasks(projectId);
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const t of all) {
    const list = byStatus.get(t.status);
    if (list) list.push(t);
    else byStatus.set(t.status, [t]);
  }

  const lines: string[] = [];
  lines.push(
    "STATO DELLA BOARD — letto adesso, non ricordato. Ciò che segue SOSTITUISCE",
    "qualunque stato di board tu abbia visto nei turni precedenti: quello è vecchio",
    "e potrebbe mentire. Agisci solo su ciò che leggi qui, o rileggi con `list_tasks`.",
    "",
  );

  let budget = SNAPSHOT_MAX_TASKS;
  let omitted = 0;
  for (const status of STATUS_ORDER) {
    const tasks = byStatus.get(status) ?? [];
    if (tasks.length === 0) continue;
    if (status === "done") {
      lines.push(`## done — ${tasks.length}`);
      lines.push("");
      continue;
    }
    lines.push(`## ${status} — ${tasks.length}`);
    // Priorità alta prima: è l'ordine in cui la coda di dispatch le serve, ed è
    // l'ordine in cui l'umano si aspetta di sentirsele raccontare.
    const sorted = [...tasks].sort((a, b) => b.priority - a.priority);
    for (const t of sorted) {
      if (budget <= 0) { omitted++; continue; }
      budget--;
      lines.push(taskLine(t));
    }
    lines.push("");
  }

  if (all.length === 0) lines.push("(nessuna card su questa board)", "");
  if (omitted > 0) {
    lines.push(
      `(altre ${omitted} card non elencate qui per limite di spazio — usa \`list_tasks\` per vederle tutte)`,
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

function taskLine(t: Task): string {
  const bits: string[] = [];
  bits.push(`- [${t.id}] ${t.text}`);
  const meta: string[] = [`prio ${PRIORITY_LABEL[t.priority] ?? t.priority}`];
  if (t.dispatchState) meta.push(`agente: ${t.dispatchState}`);
  if (t.assignedTo) meta.push(`assegnato: ${t.assignedTo}`);
  if (t.blockedByTaskId) meta.push(`bloccato da ${t.blockedByTaskId}`);
  if (t.subtaskCount > 0) meta.push(`step ${t.subtaskDoneCount}/${t.subtaskCount}`);
  if (t.userCommentCount > 0) meta.push(`${t.userCommentCount} msg dall'umano`);
  bits.push(`  (${meta.join(" · ")})`);
  return bits.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Il ruolo
// ────────────────────────────────────────────────────────────────────────────

/**
 * Il prompt di ruolo della sessione-orchestratore. Sta lato server, in un punto
 * solo, per lo stesso motivo di tutto il resto: se la stessa regola finisse in
 * due superfici le due porte comincerebbero a rispondere diverso.
 *
 * La regola che non è negoziabile è l'ultima: non agire mai in muto. Un
 * orchestratore che sposta sei card senza dirlo è indistinguibile da un guasto,
 * e per capire cos'è successo bisogna ricostruire la board a mano.
 */
export function orchestratorRolePrompt(projectName: string): string {
  return [
    `Sei l'ORCHESTRATORE della board Kanban del progetto "${projectName}".`,
    "",
    "Coordini più task a livello TESTUALE: leggi la board, rispondi a domande sullo",
    "stato, sposti/commenti/ripriorizzi/colleghi card, e inserisci task nuovi. NON",
    "entri nel merito tecnico di un singolo task e non scrivi codice: quello è il",
    "lavoro degli agenti che il dispatcher fa partire dalle card.",
    "",
    "COME LEGGI LO STATO",
    "A ogni turno ricevi lo stato della board qui sopra, riletto in quel momento.",
    "Rispondi SEMPRE da quello o da una `list_tasks`/`get_task` fatta adesso, MAI a",
    "memoria: ciò che ricordi di una card è vecchio di almeno un turno, e agire su",
    "un ricordo è il modo esatto in cui si sposta la card sbagliata.",
    "",
    "LE TUE MANI",
    "`list_tasks`, `get_task`, `create_task`, `update_task`, `comment_task`.",
    "Non hai — di proposito — i tool per far partire o guidare sotto-agenti: gli",
    "agenti nascono dalla board quando una card entra in Todo, non da te.",
    "",
    "COME AGISCI — mai in muto",
    "1. Se la richiesta tocca più di una card, prima PROPONI: elenca card per card",
    "   cosa cambieresti (da → a), in forma leggibile, e fermati lì.",
    "2. Applica solo dopo un ok esplicito.",
    "3. Ad applicazione fatta, riepiloga cosa è cambiato davvero, card per card, con",
    "   lo stato PRECEDENTE accanto a quello nuovo: è ciò che rende la mossa",
    "   reversibile con una frase («rimetti quelle tre in todo»).",
    "Una singola mossa ovvia e non distruttiva («commenta X», «alza la priorità di",
    "Y») puoi farla subito, ma dilla comunque.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// La porta unica
// ────────────────────────────────────────────────────────────────────────────

export interface OrchestratorSessionDeps {
  /** Il topic-orchestratore già esistente di questo progetto, se c'è. */
  findOrchestratorTopic: (projectPath: string) => Topic | null;
  /** Creazione di un topic scollegato (nessuna tab rubata). */
  createTopic: (opts: {
    name: string;
    projectPath: string;
    systemPrompt: string;
    mcpPolicy: string;
  }) => { topicId: string; sessionKey: string };
}

export interface OrchestratorTarget {
  projectPath: string;
  projectName: string;
}

/**
 * La sessione-orchestratore del progetto: una, riusata. Se non c'è, nasce.
 *
 * Una per progetto e non una per porta: è tutto il punto. Se il composer aprisse
 * la sua sessione, «ricorda cosa gli hai chiesto» varrebbe in chat e non dalla
 * board, e l'utente vedrebbe due orchestratori che non si parlano.
 */
export function resolveOrchestratorSession(
  deps: OrchestratorSessionDeps,
  target: OrchestratorTarget,
): { topicId: string; sessionKey: string; created: boolean } {
  const existing = deps.findOrchestratorTopic(target.projectPath);
  if (existing) return { topicId: existing.id, sessionKey: existing.sessionKey, created: false };
  const made = deps.createTopic({
    name: orchestratorTopicName(target.projectName),
    projectPath: target.projectPath,
    systemPrompt: orchestratorRolePrompt(target.projectName),
    mcpPolicy: ORCHESTRATOR_MCP_POLICY,
  });
  return { ...made, created: true };
}

/**
 * DA UN TESTO A UN TURNO — la funzione che entrambe le porte chiamano.
 *
 * Non manda niente: restituisce il turno da eseguire (`sessionKey` + contenuto),
 * che è ciò che rende identiche le due porte per costruzione invece che per
 * disciplina. La chat ci arriva perché l'utente scrive nel topic risolto qui; il
 * composer ci arriva via `POST /api/orchestrator/message`. Stesso input, stesso
 * `sessionKey`, stesso contenuto: il resto della pipeline (assemblaggio del
 * contesto, invio, streaming) non sa nemmeno da quale porta è entrato.
 */
export function orchestratorTurn(
  deps: OrchestratorSessionDeps,
  target: OrchestratorTarget,
  text: string,
): { topicId: string; sessionKey: string; content: string; created: boolean } {
  const content = text.trim();
  if (!content) throw new Error("orchestrator: empty message");
  const session = resolveOrchestratorSession(deps, target);
  return { ...session, content };
}
