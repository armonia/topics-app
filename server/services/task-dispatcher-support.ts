/** Module-level constants and pure helpers of the dispatcher, split out of task-dispatcher.ts (move only). */
import { DISPATCH_CHIP_QUEUED, PARKED_WAITED_OUT } from "../../shared/board";
import { type ResourceFloorKind } from "./dispatch-capacity";
import { type DispatchBlockKind } from "./dispatch-block-signal";
import { providerHoldLabel } from "../../shared/provider-hold";
import { languageDirective } from "../lib/topics-agent-prompt";
import { resolveOutputLanguage } from "./app-settings";
import { OUTPUT_LANGUAGES, type OutputLanguage } from "../../shared/types";
import { hasCommandShell } from "../lib/command-process";


/** Fallback retry cap when a board's setting can't be read (default 2). */
/** A mirror card: the local copy of a run another server (the primary) handed to this node. */
export const MIRROR_KEY_PREFIX = "node-run:";

export function isMirrorCard(t: { claudeTaskId?: string | null } | null | undefined): boolean {
  return !!t?.claudeTaskId?.startsWith(MIRROR_KEY_PREFIX);
}

export const DEFAULT_RETRY_CAP = 2;
export const WAITING_MEMORY = "waiting-memory" as const;
/** The closing sentence of a spent plan's hold: the self-check tells it from a window that resets by itself. */
export const PLAN_SPENT_NOTE = "Le card non ripartono da sole: serve cambiare il modello della board o l'account."; // allow-italian: task queue reason

/**
 * Prefix of every dispatcher stdout line. The server log carries no timestamps,
 * so without this a wait ("held", "waiting-memory") cannot be dated afterwards.
 */
export function dispatcherLogLine(message: string): string {
  return `${new Date().toISOString()} [dispatcher] ${message}`;
}

/**
 * Working rule for every kickoff: Topics is a product for anybody, so no single
 * person's data is hard-coded. Exported so the unit test reads the same sentence
 * the agent receives; `docs/board-protocol.md` carries the human copy.
 */
export const GENERIC_PRODUCT_RULE =
  "- Topics is a product for ANYONE: never write one person's names, paths, IPs, accounts or servers into the code. " +
  "What varies between users lives in settings, in the machines table or in a configurable adapter. " +
  "Does a personal value look needed? It goes into configuration, with an empty default that works.";



/** How much of a tool input travels on the wire: the card cuts further. */
const LIVE_TOOL_INPUT_CHARS = 200;

/**
 * The ONE line that says what a tool is doing, taken from its input.
 *
 * A tool input is an object shaped by the tool, and the card wants a string:
 * the command for Bash, the path for the file tools, the pattern for a search.
 * Anything else falls back to the first string field, then to nothing, never
 * to a JSON dump. Pure and exported so the mapping is tested on its own.
 */
export function summarizeToolInput(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return typeof input === "string" ? cut(input) : null;
  const o = input as Record<string, unknown>;
  const keys = /^bash$/i.test(name) ? ["command", "description"]
    : /^(edit|write|read|notebookedit|multiedit)$/i.test(name) ? ["file_path", "notebook_path", "path"]
    : /^(grep|glob|websearch|webfetch)$/i.test(name) ? ["pattern", "query", "url"]
    : /^(task|agent)$/i.test(name) ? ["description", "prompt"]
    : ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return cut(v);
  }
  for (const v of Object.values(o)) if (typeof v === "string" && v.trim()) return cut(v);
  return null;
}
function cut(v: string): string {
  const one = v.trim().replace(/\s+/g, " ");
  return one.length > LIVE_TOOL_INPUT_CHARS ? one.slice(0, LIVE_TOOL_INPUT_CHARS) : one;
}


/**
 * Dove cade l'effort quando la board dice "auto" ma il classificatore non
 * risponde. NON e' una preferenza: e' cio' che la board faceva prima che l'auto
 * esistesse, quindi un giudice muto lascia le cose esattamente come stavano
 * invece di spostarle di nascosto.
 */
/** Quanti errori del provider di fila si perdonano prima di ricominciare a
 *  pagare tentativi. Tre: una raffica si assorbe, un guasto cronico no. */
/**
 * Dove cade l'effort quando la board dice "auto" ma il classificatore non
 * risponde. NON è una preferenza: è ciò che la board faceva prima che l'auto
 * esistesse, quindi un giudice muto lascia le cose come stavano.
 *
 * Vive solo su questo ramo: su main l'effort automatico non c'è (scelta del
 * cherry-pick di `ed607a5a`, per non portare metà di una feature).
 */
export const DEFAULT_AUTO_EFFORT = "medium";

export const FREE_PROVIDER_ERRORS = 3;

/** How long the post-turn git stat may take before the slot is released without it. */
export const ATTEMPT_STATS_DEADLINE_MS = 15_000;
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([p, late]); }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * Sotto quale carico PER CORE la macchina è «scarica» abbastanza da far partire
 * un task pesante.
 *
 * 1.0, cioè il punto in cui la coda del processore è ancora dentro il numero di
 * core: sopra di lì i processi si aspettano già a vicenda, ed è esattamente lo
 * stato in cui una compilazione fa male a tutti gli altri. È più severo dell'1,5
 * della modalità notturna (`night-mode.ts`) di proposito: lì la domanda è «la
 * persona sta lavorando?», qui è «c'è margine per un lavoro che si prende tutto?»
 * — e la seconda vuole un margine vero, non l'assenza di un intralcio.
 */
export const HEAVY_MAX_LOAD_PER_CORE = 1.0;

/**
 * Lo stesso margine, ma misurato su NOI (`DispatcherDeps.ownLoad`): sopra metà
 * dei core occupati dalla nostra flotta un task pesante non si prenderebbe la
 * macchina da solo, che è l'unica cosa che il peso esiste per garantire.
 *
 * Più severo dell'1,0 sul load di sistema, e deve esserlo: quello contava anche
 * i processi di chiunque altro, quindi la stessa soglia applicata a una misura
 * che vede solo noi sarebbe un freno che non frena quasi mai. Su questo host
 * (12 core) sono 6 core-unità, cioè 600% nella scala di `ps`, contro le 0,75
 * misurate la notte del 12/08 con la board ferma: due ordini di grandezza di
 * margine, che è quanto serviva e non c'era.
 *
 * PERCHÉ FINO AL 13/08 QUESTO RAMO NON POTEVA MORDERE, e non è colpa del conto.
 * La soglia è tarata su metà dei core della macchina, ma la flotta quei core
 * non li poteva prendere: il job launchd del server non dichiarava
 * `ProcessType`, e senza quella chiave launchd applica limiti di risorsa
 * ridotti al job e a tutto il suo albero, fino a ogni `claude`. Misurato quel
 * giorno con lo stesso banco eseguito dentro e fuori il clamp, a parità di
 * carico: la flotta si fermava fra 3,6 e 4,4 core-unità mentre un processo non
 * clampato ne prendeva 10, e un `tsc` costava 4,63 s contro 2,65. Sotto la
 * soglia di 6 non ci si arrivava mai, quindi il ramo `ownLoad` restava aperto
 * per costruzione. La chiave la scrive ora
 * `scripts/apply-topics-host-plist.sh`, e questo numero torna raggiungibile
 * solo dopo che il server è ripartito con quel plist. Se un giorno il freno
 * ricominciasse a non frenare, si guarda prima il plist e poi questa soglia.
 */
export const HEAVY_MAX_OWN_LOAD_PER_CORE = 0.5;

/**
 * Quanto può durare l'attesa di un task pesante prima che parta comunque.
 *
 * Senza scadenza la guardia non era una precedenza, era un blocco: la coda è
 * ordinata per priorità e poi per anzianità, il ramo trattenuto fa `break`, e
 * un pesante con priorità alta si piazza in testa e ferma la board INTERA.
 * Misurato il 12/08: due `in_progress` col tetto a 9, per ore, finché non si è
 * abbassata a mano la priorità delle due card pesanti.
 *
 * Quindici minuti perché l'attesa deve poter servire a qualcosa (un turno che
 * finisce libera la macchina in quell'ordine di grandezza) senza mai diventare
 * indefinita. Scaduto il tetto il task parte lo stesso, e il thread dice perché.
 */
export const HEAVY_HOLD_MAX_MS = 15 * 60_000;

/** Ogni quanto un resume in attesa ricontrolla se si è liberato un posto. */
export const RESUME_SLOT_RETRY_MS = 5_000;

/**
 * How often a held resume may rewrite the SAME hold just to refresh its numbers.
 *
 * Measured on 15/09/2026: every retry rewrote `dispatch_error` with the memory
 * reading of that instant (5.7, 5.9, 6.0 GB), touched `updated_at` and sent
 * `task:updated` to every client. Seven held cards made about 70 frames a
 * minute, and each frame re-rendered the app tree and rebuilt the tray menu.
 * A different hold is written at once; the same hold with other numbers waits
 * this long, so the card is never stale for more than a minute.
 */
export const HELD_RESUME_REFRESH_MS = 60_000;

/**
 * Which WAIT a held resume's sentence describes: two sentences with the same key
 * are the same wait, and the second one is only a refresh.
 *
 * Figures never count: "5.9 GB" and "6.0 GB" say the same thing. And for the
 * machine floor (`resources`) the words do not count either, only the RESOURCE,
 * the same key `admissionBlock` logs by. One memory episode goes through three
 * sentences (under the floor, reserved for the agents starting, climbing back
 * towards the restart line), and with the hysteresis holding the composer turns
 * "under" into "climbing" exactly at the floor: on the 15/09 readings (5.7, 5.9,
 * 6.0, 5.8) a key on the words still rewrote the card about every other retry.
 *
 * THE RESOURCE COMES FROM THE VERDICT, NOT FROM THE FIRST WORD, and that is the
 * whole of KANBAN-91. "Memoria: la sto misurando da 11 s su 120" and "Memoria
 * quasi finita: la lettura più bassa…" share their first word, so they shared
 * this key - and the warm-up is a 120 s state guaranteed at every boot, so it
 * always wrote first and the real reason never reached the card at all: 80
 * comments out of 80 after 15/09/2026 17:49 carried the warm-up, zero carried
 * the floor, while `dispatch_error` beside them was refreshed every 60 s with
 * the right text. Reading the resource from `ResourceFloorVerdict.kind` splits
 * the two WITHOUT going back to keying on the words, which PR #63 removed
 * because the app names inside the memory sentence rewrote the card at every
 * retry.
 */
export function holdKey(kind: DispatchBlockKind | null, reason: string | null, floor: ResourceFloorKind | null = null): string {
  if (reason == null) return `${kind}:`;
  if (kind === "resources") return `${kind}:${floor ?? "?"}`;
  return `${kind}:${reason.replace(/\d+(?:[.,]\d+)*/g, "#")}`;
}

/**
 * THE NOTE A HELD RESUME WRITES IN THE THREAD IS A STATE, ONE SLOT PER CARD.
 *
 * Its register (`waitingForSlot`) lives in memory and is born empty at every
 * boot, and the `addComment` dedupe window is 10 s: on this machine boots are
 * 35+ minutes apart, so every boot said the wait again. Measured on 24/09/2026:
 * 17 identical Codex-wall notes on 89919742, and 33 memory-floor notes on 13
 * cards (6 on bab77cb3 in three hours) that differ only in their figures, so no
 * identical-text guard could catch them.
 *
 * These are the openings of every sentence `resumeHold` can return (the floor,
 * the 24h and per-card spend, the pressure budget, the drain, the provider
 * wall) plus the cap-only line and the sentences older code wrote, so a pile
 * already in a thread is emptied by the next note. The tick's note on a todo
 * card says the same machine state in the same words, so it shares the slot.
 * `replaces` only touches rows
 * by the same author and kind (`system`, `service`): a person or an agent
 * starting a comment with the same words is never touched.
 */
export const RESUME_WAIT_OPENINGS: readonly string[] = [
  // allow-italian: openings of the Italian wait sentences this slot replaces
  "Memoria quasi finita:", "Memoria in risalita:", "Memoria: la sto misurando", "Memoria oltre la soglia", // allow-italian: sentence openings
  "Disco quasi pieno:", "Tetto di spesa giornaliero raggiunto", "Tetto di spesa per card raggiunto:", // allow-italian: sentence openings
  "Topics usa ", "Topics è al tetto di memoria", "Non c'è memoria per un altro agent:", // allow-italian: sentence openings
  "Riavvio del server in arrivo (", "In attesa di uno slot:", "In pausa:", // allow-italian: sentence openings
  `${providerHoldLabel("claude")}: `, `${providerHoldLabel("codex")}: `,
];

/**
 * The boot note of a card that was waiting for a seat, as a slot. The claim
 * window of `claimInterruption` is three minutes and guards concurrent writers
 * within one boot: across boots it let one copy through each time (15 on
 * 89919742). The card is still waiting for the same seat, so one row says it.
 */
export const BOOT_QUEUED_NOTE = "Server ripartito mentre la card aspettava uno slot"; // allow-italian: opening of the boot note

/**
 * La stessa lista, ma cominciando dall'elemento `cursor`-esimo.
 *
 * Serve a far girare l'ordine dei board a ogni reconcile. Il tetto dei posti è
 * GLOBALE: chi viene interrogato per primo li riempie, e chi sta in fondo non
 * ne trova mai. Misurato l'11/08 sul DB vivo: una board 26 claim su 31 in
 * un'ora, un'altra con tre card in coda ZERO — non per priorità, per posizione.
 */
export function rotateFrom<T>(items: readonly T[], cursor: number): T[] {
  if (items.length < 2) return [...items];
  const da = ((cursor % items.length) + items.length) % items.length;
  return [...items.slice(da), ...items.slice(0, da)];
}

export const CHIP_QUEUED = DISPATCH_CHIP_QUEUED;
export const CHIP_WORKING = "working";
export const CHIP_NEEDS_INPUT = "needs_input";
// Review, but with a difference the human cares about: "serve te" = the agent
// ASKED something (its last word is a question block, answer required);
// "delivered" = clean hand-off, the agent believes the work is done.
export const CHIP_DELIVERED = "delivered";
// Park states (task lands in backlog). Distinct on purpose so the board doesn't
// read every stop as a neutral manual "fermato":
//  - failed  = the agent genuinely failed (timeout without review after the cap,
//              repeated setup errors) → red "fallito" chip, the human decides.
//  - blocked = a config issue the human must fix before it can run at all
//              (no worktree, project path unresolvable) → amber "da sistemare".
export const CHIP_FAILED = "failed";
export const CHIP_BLOCKED = "blocked";
/** Why a dependent parks when its blocker's session runs with the other Topics
 *  routing switch, or with the same one OFF on another runtime than the one the
 *  dependent names (reusedSessionRouteConflict). */
export const REUSED_SESSION_ROUTE_REASON = {
  "switch-on": "This task has Topics routing off, but the previous session runs with the switch on, through the Topics engine. Turn the switch on or turn off session reuse before starting the task.",
  "switch-off": "This task has Topics routing on, but the previous session runs with the switch off. Turn the switch off or turn off session reuse before starting the task.",
  engine: "This task has Topics routing off and asks for a direct run, but the previous session runs on the Topics engine. Turn off session reuse before starting the task.",
  direct: "This task names the Topics engine as its runtime, but the previous session runs directly on its provider. Turn off session reuse before starting the task.",
} as const;
// The agent DECLARED an external-condition wait (wait_for_condition): the task is
// back in `todo`, its slot freed, and a deferral window keeps it out of the claim
// until it elapses — then the tick re-dispatches it. It never produced output, so
// it must never read as a delivery.
export const CHIP_WAITING = "waiting";
// Consecutive sweeps that must all say "the process is gone" before the liveness
// net closes a turn. Two, not one: a single sweep can catch a legitimate blind
// spot (a child mid-respawn, a probe that answered during a restart window), and
// killing a live turn is far worse than recovering one sweep later.
export const LIVENESS_DEAD_SWEEPS = 2;
// The two states that mean "a dispatch turn is genuinely live" — reconcile only
// resumes IN PLACE from these, so a human dragging a review/done task into
// In Progress (dispatch_state null/needs_input) is never falsely "orphaned".
const ACTIVE_DISPATCH_STATES = new Set([CHIP_WORKING, "starting"]);
// Gli stati da cui un task in_progress SENZA turno vivo va recuperato — cioè i
// tre che solo il dispatcher scrive. `queued` è il terzo, e per un pezzo non
// c'era: un'attesa che vive in memoria (il rinvio del resume a tetto pieno)
// muore col processo e lascia la card in_progress col chip «aspetto il turno».
// Da fuori sembra occupata, e per l'umano lo è; dentro non c'è più nessuno che
// la riprenda. Misurate l'11/08: sette card ferme così da 40 minuti su una
// board che ne faceva girare una sola.
//
// Restano fuori i chip che scrive UNA PERSONA (null, needs_input, delivered):
// lì il task è in mano sua e recuperarlo sarebbe rubarglielo.
export const RECOVERABLE_DISPATCH_STATES = new Set([...ACTIVE_DISPATCH_STATES, CHIP_QUEUED]);

/**
 * Human phrasing for the external-session guard: how many sessions, where, and
 * on which branch — enough for the human to recognise their own terminal.
 * Pure (exported for the dispatcher tests).
 */
export function describeIntruders(intruders: Array<{ cwd: string; branch: string | null }>): string {
  const n = intruders.length;
  const head = intruders[0];
  const where = head ? `${head.cwd}${head.branch ? ` (branch ${head.branch})` : ""}` : "";
  if (n === 1) return `c'è una sessione Claude esterna viva su ${where}`;
  return `ci sono ${n} sessioni Claude esterne vive su questo repo (la più recente su ${where})`;
}

/**
 * LONG COMMANDS, AS A BOARD AGENT RUNS THEM: started as a Topics process and
 * waited for inside the turn, in the kickoff and in the fan-out kickoff alike.
 *
 * The board judges a turn when it ends. `run_command` tells an ordinary chat
 * it may end its turn and be woken; a card that did so spent an attempt, or
 * met its wake between two reads of the dispatcher, and a fan-out attempt was
 * compared without the outcome (verifiers of 28/09). The advice before this,
 * `run_script` or `&` and a poll now and then, left the command outside the
 * turn too. Where the bridge offers no `run_command` (Windows,
 * `hasCommandShell`) it names `run_script`, as the system prompt does.
 *
 * A dev server left up for the reviewer's tab is not one of these commands:
 * read against «never end your turn while a command you started still runs»,
 * the agent had to stop the server the tab it delivers needs (verifiers of
 * 28/09, third round).
 */
export function longCommandsRule(platform: NodeJS.Platform = process.platform): string {
  const cmd = hasCommandShell(platform);
  const start = cmd ? "run_command (run_script for a script the manifest declares)" : "run_script";
  return `LONG COMMANDS (build, test, install >~2 min): start them with ${start}, never with \`&\` or a background Bash, and get their outcome with wait_for_process in this SAME turn, calling it again while it answers 'timeout'. `
    + "Never end your turn while one of them still runs, even when the tool says it will wake you: the board reads the end of your turn as the end of your work. "
    + `A dev server you leave up for the reviewer's tab is not one of them: it keeps serving after your turn${cmd ? " (started with run_command, pass wake=false)" : ""}.`;
}

/**
 * Il fronte terminale di FALLIMENTO, gemello di `emitReviewReadyEdge`.
 *
 * Il taglio è `requeue === false`: solo lì il task si ferma e resta fermo. Un
 * requeue NON si annuncia — il task riparte da solo e un banner sarebbe rumore
 * su un ritentativo che si auto-guarisce; i siti che passano `requeue:
 * !exhausted` diventano terminali quando i tentativi finiscono, e allora il
 * fronte parte da sé senza che nessuno debba ricordarsene.
 *
 * Pura ed esportata per il test dell'edge: la decisione è una sola riga, ma è
 * la differenza fra "ti avviso quando serve" e "ti avviso a ogni ritentativo".
 */
export function parkedEdgeEvent(
  task: { id: string; projectId: string; text?: string | null },
  args: { requeue: boolean; reason?: string; parkState?: string | null },
): { type: "task:parked"; projectId: string; taskId: string; taskTitle: string; state: "failed" | "blocked" | "waited_out"; reason?: string } | null {
  if (args.requeue !== false) return null;
  return {
    type: "task:parked",
    projectId: task.projectId,
    taskId: task.id,
    taskTitle: task.text || "Task",
    // 'blocked' = configurazione da sistemare, 'failed' = l'agent non ha
    // prodotto niente, 'waited_out' = la serie di attese ha sfondato il tetto.
    // Sono tre domande diverse per l'umano, e il chip è l'unica cosa che le
    // distingue: la copy del banner e della push si legge di qui.
    state: args.parkState === CHIP_BLOCKED
      ? "blocked"
      : args.parkState === PARKED_WAITED_OUT
        ? "waited_out"
        : "failed",
    ...(args.reason ? { reason: args.reason } : {}),
  };
}

/**
 * Persistent role for the task-scoped topic (the per-turn task rides in the
 * user message).
 *
 * Era una costante, e la sua lingua era l'italiano perché così l'aveva scritta
 * chi l'ha scritta: un agente kanban rispondeva in italiano anche con
 * l'interfaccia in inglese, mentre la stessa persona in chat veniva servita in
 * inglese perché LÌ la costante era inglese. Due bocche, due lingue, nessuna
 * scelta. Adesso il ruolo resta italiano — è il testo del protocollo di board,
 * e quello non si traduce a ogni giro — ma la LINGUA DELLE RISPOSTE la decide
 * `languageDirective`, la stessa che serve chat e terminale.
 */
export function rolePrompt(lang?: OutputLanguage): string {
  const base =
    "You are an agent working ONE SINGLE task of a Kanban board, in the current working directory, " +
    "up to the `review` state. Minimal communication: short status comments at the milestones. " +
    "You cannot take the task to `done` (that needs the human's ok).";
  const directive = lang ? languageDirective(lang) : languageDirective();
  return directive ? `${base} ${directive}` : base;
}

/**
 * La lingua EFFETTIVA di una board: il suo override, se ne ha uno, altrimenti
 * la preferenza globale — la stessa che serve chat e terminale.
 *
 * È qui e non nel chiamante perché «uguali» (l'impostazione in Preferenze e
 * quella sulla board) deve voler dire lo STESSO VALORE EFFETTIVO, non due
 * valori da tenere allineati a mano: se la risoluzione vivesse in due punti,
 * il primo giorno che uno dei due dimentica il ripiego le due superfici
 * mostrerebbero la stessa scelta e produrrebbero lingue diverse.
 */
export function boardLanguage(settings: { language?: string } | null | undefined): OutputLanguage {
  const raw = (settings?.language ?? "").trim().toLowerCase();
  if (raw && raw !== "inherit" && (OUTPUT_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as OutputLanguage;
  }
  return resolveOutputLanguage();
}
