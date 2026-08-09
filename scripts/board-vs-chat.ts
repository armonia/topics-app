#!/usr/bin/env bun
/**
 * board-vs-chat — la board Kanban costa meno di una chat, o no?
 *
 * ── La domanda ──────────────────────────────────────────────────────────────
 * «Da oggi il lavoro entra SOLO dalla board, invece di aprire una chat?» non è
 * una questione di gusto: o a parità di lavoro consegnato il giro board costa
 * meno token della stessa cosa fatta in chat, o non lo fa. Questo script è la
 * barra che lo dice, e ESCE NON-ZERO quando la parità non regge.
 *
 * ── I tre bracci ────────────────────────────────────────────────────────────
 *   board  task dispatchato a un agente kanban in worktree isolato
 *   chat   chat Topics normale — stesso server, stesso bridge MCP, quindi la
 *          differenza board−chat isola il costo del SOLO dispatch
 *   cli    `claude -p` nuda — il pavimento, non un concorrente: non consegna un
 *          task, non ha thread, non ha review. Serve a sapere quanto costa il
 *          guscio, e per questo NON è un cancello (vedi `cliOverhead`).
 *
 * ── Le due unità di misura, mai sommate in silenzio ─────────────────────────
 * `work`      = input + output + cache_creation, deduplicati per `message.id`.
 *               È esattamente ciò che finisce in `tasks.agent_tokens` e in
 *               `SessionUsage.billableTokens`: la stessa quantità sui due bracci.
 * `cacheRead` = `cache_read_input_tokens`, la quota DOMINANTE del consumo reale
 *               (~60% misurato) e quella che nessuna schermata sommava.
 * Il confronto gira su DUE assi separati e fallisce su ciascuno per conto suo.
 * Il totale `work+cacheRead` si stampa etichettato come tale, mai spacciato per
 * «i token».
 *
 * ── Da dove escono i numeri ─────────────────────────────────────────────────
 * Dal reader vero del server (`server/services/transcript-usage.ts`), lo stesso
 * che alimenta `tasks.agent_tokens` via `recordAgentUsage`, e dal listino vero
 * (`server/usage/pricing.ts`). Non c'è un secondo conto: se questo script e la
 * board divergono, è un bug del reader, non di due aritmetiche diverse.
 *
 * I task registrati PRIMA della migration 048 (2026-07-15T10:52) hanno
 * `agent_tokens` gonfiati ~2,4× (una riga di usage per content-block, non
 * deduplicata) e `agent_cache_read_tokens` a zero perché la colonna non esisteva.
 * Non sono comparabili: qui vengono ESCLUSI e contati a parte, mai mediati con
 * gli altri. La data non è cablata, si legge da `schema_migrations`.
 *
 * ── I tre cancelli ──────────────────────────────────────────────────────────
 *   1. parità di token   board.work > chat.work  oppure  board.cacheRead >
 *                        chat.cacheRead sullo STESSO lavoro → rosso.
 *                        Quando lo stesso `workId` compare in più file (repliche),
 *                        il cancello sta sulle MEDIANE del gruppo e le righe
 *                        per-replica diventano informative: tre verdetti a
 *                        tolleranza zero su un campione ciascuno, con il braccio
 *                        di paragone che varia 2,25× fra una corsa e l'altra,
 *                        sono tre lanci di moneta stampati come risultati.
 *   2. azioni umane      più di `--max-actions` (default 2) azioni umane MISURATE
 *                        per ciclo di feedback → rosso, e una volta sola per
 *                        `workId`. Il conto a mano del percorso in interfaccia
 *                        sta in `humanActionsStructural`: si stampa, non è un
 *                        cancello — è una costante scritta nel file, quindi il
 *                        confronto col tetto non potrebbe mai variare.
 *                        Sui dati storici la misura è (commenti umani +
 *                        decisioni di approvazione) / cicli di review, e il
 *                        cancello guarda la MEDIANA.
 *   3. casi limite       un caso marcato `uncovered` → rosso. E un caso marcato
 *                        coperto senza PROVA ESEGUITA (comando con esito e
 *                        output, o test) → rosso: «l'ho letto nel sorgente» non
 *                        è una prova.
 *
 * Un confronto non appaiato non è una parità: viene detto `unpaired` e non conta
 * come verde. Se si passa `--pair` e non ne esce nemmeno un confronto valutabile,
 * lo script esce non-zero — un'asserzione che non può fallire non è un cancello.
 *
 * ── I codici d'uscita rispondono a due domande diverse ──────────────────────
 *   0  l'attrezzo ha lavorato E la misura dice sì
 *   1  l'ATTREZZO è rotto (input malformato, matrice stantia, terne assenti):
 *      il verdetto stampato non è una misura, non fidarsene
 *   2  errore d'uso (flag sbagliato)
 *   3  l'attrezzo ha lavorato e la MISURA dice no
 *
 * La prima versione ne aveva uno solo, e questo rendeva la barra
 * insoddisfacibile: «deve uscire 0» diventava «la misura deve dare un certo
 * risultato», cioè la richiesta di un'asserzione che non può fallire
 * onestamente. Separandoli, «il rig è sano» e «la risposta è sì» restano due
 * domande, entrambe falsificabili. Chi sorveglia solo la salute del rig usa
 * `--gate harness`: il 3 diventa 0, il verdetto resta rosso nel report.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   bun scripts/board-vs-chat.ts                  # storico dal DB (sola lettura)
 *   bun scripts/board-vs-chat.ts --json           # stesso, per un altro programma
 *   bun scripts/board-vs-chat.ts --project topics-app-ar3jt5
 *   bun scripts/board-vs-chat.ts --pair run.json --cases cases.json
 *   bun scripts/board-vs-chat.ts --print-schema   # il contratto dei file in ingresso
 *
 * Senza `--pair` cerca da sé `docs/board-vs-chat/*.pair.json`, e come matrice
 * `docs/board-vs-chat/cases.json`. Assenti = non valutati, e lo dice.
 *
 * ── Cosa NON fa ─────────────────────────────────────────────────────────────
 * Non spende: non lancia `claude`, non dispatcha, non scrive. Il braccio CLI si
 * misura una volta con `bun scripts/prefix-budget.ts --probe` e si consegna qui
 * dentro un file `.pair.json`. Una barra che brucia richieste vere a ogni giro
 * non la lancia nessuno, e una barra che nessuno lancia non è una barra.
 *
 * Il DB si apre in SOLA LETTURA.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranscriptUsageReader, ZERO_USAGE, type SessionUsage } from "../server/services/transcript-usage";
import { contextWindowFor, windowModelFor } from "../server/usage/context-window";
import { calculateCostWithCache } from "../server/usage/pricing";
// La soglia della 048 ha UNA definizione sola, e sta in board-baseline: taglia
// sull'INIZIO del task. Riderivarla qui è come sono entrate le tre righe pre-048
// che gonfiavano la mediana dello storico — vedi il commento su
// `isComparableTaskRow`.
import { bracketCostUsd, isComparablePost048 } from "./board-baseline";

// ═══════════════════════════════════════════════════════════════════════════
// Tipi — il contratto pubblico, usato anche dal test
// ═══════════════════════════════════════════════════════════════════════════

export type Arm = "board" | "chat" | "cli";

/** Da dove viene una misura. `declared` = numeri già pronti nel file: si accetta
 *  ma si marca, perché non è passato dal reader. */
export type MeasureSource = "transcript" | "db" | "declared";

export interface CostEstimate {
  /** `exact` quando c'è la scomposizione input/output/cache; `bracket` quando si
   *  ha solo il totale di lavoro (una riga di `tasks`) e il prezzo è una forbice;
   *  `unknown` quando manca perfino il modello. */
  kind: "exact" | "bracket" | "unknown";
  lowUsd: number | null;
  highUsd: number | null;
}

export interface ArmMeasure {
  arm: Arm;
  label: string;
  model: string | null;
  source: MeasureSource;
  /** input+output+cache_creation deduplicati — `tasks.agent_tokens`. */
  workTokens: number;
  /** `cache_read_input_tokens` — tenuto SEPARATO, mai sommato in silenzio. */
  cacheReadTokens: number;
  /** La scomposizione, quando c'è. Senza, il costo è una forbice. */
  split: SessionUsage | null;
  /** Azioni umane MISURATE nella corsa di questo braccio. `null` = non misurata. */
  humanActions: number | null;
  /**
   * Il conto a mano del percorso in interfaccia. NON è una misura, ed è tenuto
   * fuori da `humanActions` di proposito: è una costante scritta da chi ha
   * preparato la terna, quindi confrontarla col tetto dà sempre lo stesso esito
   * — un'asserzione che non può variare, e che ripetuta su N repliche gonfia
   * una sola decisione in N fallimenti. Si stampa, non è un cancello.
   */
  humanActionsStructural: number | null;
  humanActionsStructuralBasis: string | null;
  delivered: boolean;
  wallMs: number | null;
  cost: CostEstimate;
  /** Finestra del modello, per sapere in che serbatoio sta il lavoro. */
  contextWindow: number | null;
  notes: string[];
}

export interface AxisComparison {
  axis: "work" | "cacheRead";
  board: number;
  chat: number;
  /** Quanto la board costa in più (positivo) o in meno (negativo), in %. */
  deltaPct: number | null;
  ok: boolean;
  /**
   * true = questo asse È il cancello (lavoro misurato una volta sola).
   * false = il lavoro ha più repliche: questa riga è UN CAMPIONE, e il cancello
   * sta sull'aggregato. Un verdetto a tolleranza zero su un campione singolo,
   * quando il braccio di paragone varia di più del delta che si sta giudicando,
   * non è un cancello: è il lancio di una moneta stampato come risultato.
   */
  gated: boolean;
}

export interface PairComparison {
  /** Chiave con cui le repliche dello STESSO lavoro si raggruppano. */
  workId: string;
  /** Quale ripetizione è, quando il file lo dichiara. */
  replicate: number | null;
  replicatesTotal: number | null;
  work: string;
  status: "evaluated" | "unpaired";
  /** Perché non è appaiato, quando non lo è. */
  reason: string | null;
  measures: ArmMeasure[];
  axes: AxisComparison[];
  /** Sovrapprezzo del guscio board sulla CLI nuda. Informativo, NON un cancello. */
  cliOverhead: { workPct: number | null; cacheReadPct: number | null } | null;
}

export interface Spread {
  min: number;
  median: number;
  max: number;
  /** max/min: quante VOLTE il braccio varia fra la corsa più magra e la più grassa. */
  ratio: number | null;
}

export interface AxisAggregate {
  axis: "work" | "cacheRead";
  samples: number;
  board: Spread;
  chat: Spread;
  cli: Spread | null;
  /** Il confronto che conta: mediana board contro mediana chat. */
  deltaPctMedian: number | null;
  /** Il delta di OGNI replica, in ordine: si vede subito se cambia segno. */
  deltaPctPerReplicate: number[];
  /** In quante repliche la board è risultata più economica. */
  boardCheaperIn: number;
  /**
   * true quando la forbice del braccio di paragone (chat max/min) è più larga
   * del delta che si sta giudicando: il verdetto per-replica è rumore.
   */
  comparatorNoisierThanDelta: boolean;
  ok: boolean;
}

export interface PairAggregate {
  workId: string;
  work: string;
  replicates: number;
  /** true = il cancello di parità sta QUI (più di una replica dello stesso lavoro). */
  gating: boolean;
  axes: AxisAggregate[];
  humanActions: {
    /** Il massimo MISURATO sul braccio board fra le repliche. */
    measuredMax: number | null;
    /** Il conto a mano dell'interfaccia, riportato una volta sola. */
    structuralMax: number | null;
    structuralBasis: string | null;
    ok: boolean;
  };
  notes: string[];
}

/** La variabilità che sta nel bundle delle corse, portata dentro il referto. */
export interface ArmsVariance {
  path: string;
  baseCommit: string | null;
  baseTreeSha: string | null;
  paired: boolean | null;
  summary: Array<{
    arm: string;
    runs: number;
    delivered: number;
    workTokens: Spread;
    cacheReadTokens: Spread;
    costUsd: Spread;
    wallClockMs: Spread;
  }>;
  /** L'ordine per costo DENTRO ogni terna: se non si ribalta, l'ordine regge. */
  costOrderingPerTriple: string[];
  pairingNotes: string[];
}

export type Coverage = "covered" | "workaround" | "uncovered";

export interface ProofRef {
  kind: "command" | "test" | "none" | "source";
  cmd?: string;
  /** Esito osservato del comando/test. */
  exitCode?: number;
  /** Esito ATTESO: 0 se non detto. Serve ai casi in cui la prova è un rifiuto. */
  expectExit?: number;
  /** L'output incollato. Un comando senza output non è una prova eseguita. */
  output?: string;
}

export interface EdgeCase {
  id: string;
  title: string;
  coverage: Coverage;
  proof: ProofRef;
  /** Azioni umane che il caso costa sulla board. `null` = non misurata. */
  humanActions?: number | null;
  note?: string;
}

export interface CaseVerdict {
  id: string;
  title: string;
  coverage: Coverage;
  ok: boolean;
  reasons: string[];
}

export type Gate = "token-parity" | "human-actions" | "edge-case" | "input" | "stale-matrix";

/**
 * I cancelli rispondono a DUE domande diverse, e confonderle è stato il difetto
 * della prima versione.
 *
 * - `harness`: l'attrezzo ha potuto lavorare? Input malformato, matrice stantia,
 *   terne assenti. Qui un rosso dice «non fidarti del verdetto», non «la board
 *   costa di più».
 * - `verdict`: l'attrezzo ha lavorato, e la MISURA dice no.
 *
 * Un solo exit code per entrambe rendeva la barra insoddisfacibile: pretendere
 * `exit 0` significava pretendere che la misura desse un certo risultato, cioè
 * un'asserzione che non può fallire onestamente. Ora sono due codici distinti
 * (vedi `EXIT`), così «l'attrezzo è sano» e «la risposta è sì» restano domande
 * separate — ed entrambe restano falsificabili.
 */
export const GATE_KIND: Record<Gate, "harness" | "verdict"> = {
  input: "harness",
  "stale-matrix": "harness",
  "token-parity": "verdict",
  "human-actions": "verdict",
  "edge-case": "verdict",
};

export const EXIT = {
  /** Attrezzo sano e verdetto verde. */
  ok: 0,
  /** L'attrezzo NON ha potuto lavorare: il verdetto non è affidabile. */
  harness: 1,
  /** Errore d'uso (flag sbagliato). */
  usage: 2,
  /** Attrezzo sano, misura NEGATIVA: la risposta è «no, a questo prezzo». */
  verdict: 3,
} as const;

export interface Failure {
  gate: Gate;
  id: string;
  message: string;
}

export interface HistoryStats {
  projectId: string | null;
  /** Task con token registrati DOPO la migration 048 — gli unici comparabili. */
  comparable: number;
  /** Task con token registrati PRIMA: gonfiati ~2,4×, esclusi da ogni media. */
  preMigration048: number;
  migration048At: string | null;
  /**
   * Il controllo che impedisce alla soglia di sbagliare in silenzio.
   *
   * Un turno di agente rilegge SEMPRE la cache: un task dichiarato comparabile
   * (post-048) con `agent_cache_read_tokens = 0` non esiste — è una riga pre-048
   * entrata dalla porta sbagliata, con `agent_tokens` gonfiato e una cache-read
   * inventata a zero. Se ne compare uno, questo non è un avviso: è un rosso
   * (gate `input`), perché quelle righe finiscono dritte nelle mediane qui sotto.
   */
  integrity: {
    rule: string;
    impossibleProfiles: number;
    offenders: Array<{ taskId: string; workTokens: number; inProgressAt: string | null; completedAt: string | null }>;
  };
  workTokens: { median: number; mean: number; p90: number; total: number };
  cacheReadTokens: { median: number; mean: number; p90: number; total: number };
  /** Costo dell'insieme comparabile, come forbice: il DB non tiene la
   *  scomposizione input/output, quindi un numero secco sarebbe inventato. */
  costUsd: { lowUsd: number; highUsd: number; pricedTasks: number; unpricedTasks: number };
  humanActions: {
    /** (commenti umani + decisioni di approvazione) / cicli di review, per task. */
    median: number;
    mean: number;
    p90: number;
    max: number;
    /** I task oltre soglia, per poterli guardare invece di credere alla media. */
    overLimit: Array<{ taskId: string; actionsPerCycle: number }>;
  } | null;
}

export interface Report {
  ok: boolean;
  /** L'attrezzo ha potuto lavorare (nessun cancello `harness` rosso). Quando è
   *  false, i numeri sotto NON sono una misura: sono ciò che si è riusciti a
   *  leggere da input incompleti. */
  harnessOk: boolean;
  /** La misura dice sì (nessun cancello `verdict` rosso). Ha senso solo se
   *  `harnessOk`. */
  verdictOk: boolean;
  /** Il codice con cui il processo esce: 0 verde · 1 attrezzo rotto · 3 misura
   *  negativa. Nel JSON perché chi legge il report non veda solo `ok:false`
   *  senza sapere QUALE delle due cose è andata storta. */
  exitCode: number;
  generatedAt: string;
  maxActions: number;
  tolerancePct: number;
  history: HistoryStats | null;
  comparisons: PairComparison[];
  /** Le repliche dello stesso lavoro, ridotte a un verdetto solo. */
  aggregates: PairAggregate[];
  /** La variabilità dichiarata dai bundle delle corse, quando ce n'è uno. */
  armsVariance: ArmsVariance[];
  cases: CaseVerdict[];
  failures: Failure[];
  /** Ciò che è stato saltato, per non scambiare un'assenza per un verde. */
  notEvaluated: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Formato dei file in ingresso — il contratto per il pezzo «t1-appaiato»
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Il file `.pair.json`: UN lavoro, gli stessi requisiti, fino a tre bracci.
 *
 * Ogni braccio dà i suoi numeri in uno di tre modi, in ordine di preferenza:
 *   1. `transcriptPath` — il .jsonl della sessione. È il migliore: i token li
 *      legge il reader del server, nessuno li ricopia a mano.
 *   2. `taskId` (solo `board`) — le colonne `agent_tokens` /
 *      `agent_cache_read_tokens`, che vengono dallo stesso reader. Senza
 *      scomposizione, quindi il costo esce come forbice.
 *   3. `usage` — numeri dichiarati. Accettati e MARCATI: non sono passati di qui.
 */
export interface PairRun {
  arm: Arm;
  label?: string;
  model?: string;
  transcriptPath?: string;
  taskId?: string;
  usage?: Partial<SessionUsage>;
  /** Azioni umane MISURATE nella corsa. Questo, e solo questo, è il cancello. */
  humanActions?: number | null;
  /** Il conto a mano del percorso in interfaccia: si stampa, non è un cancello. */
  humanActionsStructural?: number | null;
  humanActionsStructuralBasis?: string;
  /** false = il braccio non ha consegnato: il confronto non è appaiato. */
  delivered?: boolean;
  wallMs?: number | null;
  notes?: string[];
}

export interface PairFile {
  schemaVersion: 1;
  /** Chiave del LAVORO. Più file con lo stesso `workId` sono repliche, e la
   *  barra li giudica insieme invece di emettere N verdetti indipendenti. */
  workId?: string;
  replicate?: number | null;
  replicatesTotal?: number | null;
  /** Il bundle delle corse da cui questa terna esce, per portarne la varianza. */
  armsBundle?: string;
  work: string;
  generatedAt?: string;
  runs: PairRun[];
  cases?: EdgeCase[];
}

/**
 * L'impronta delle sorgenti su cui poggia la matrice congelata.
 *
 * `cases.json` porta l'esito OSSERVATO di ogni prova, e questa barra si fida di
 * quell'esito invece di rieseguire (rieseguire vuole ~5,5s e il server vivo,
 * mentre la barra deve poter girare ovunque). Senza un legame fra il file e le
 * sorgenti che copre, un refactor che rompe la matrice lascia la barra verde: è
 * la barra a doversene accorgere, non il lettore.
 *
 * Il legame è questo: `bun scripts/board-cases.ts --emit-cases` registra lo
 * sha256 di ogni file letto dalle prove; qui si rifà il conto. Un byte diverso
 * ⇒ cancello `stale-matrix`, e `--emit-cases` va rilanciato.
 */
export interface MatrixFingerprint {
  algo: "sha256";
  files: Record<string, string>;
}

export interface CasesFile {
  schemaVersion: 1;
  cases: EdgeCase[];
  fingerprint: MatrixFingerprint;
}

const SCHEMA_DOC = `
File in ingresso di scripts/board-vs-chat.ts — schemaVersion 1

── <nome>.pair.json ────────────────────────────────────────────────────────────
UN lavoro, gli stessi requisiti, fino a tre bracci. Cercato in
docs/board-vs-chat/*.pair.json quando non si passa --pair.

{
  "schemaVersion": 1,
  "workId": "token-live-json",             // repliche dello STESSO lavoro: stesso workId
  "replicate": 1, "replicatesTotal": 3,    // quale ripetizione e' (facoltativi)
  "armsBundle": "scripts/board-vs-chat.arms.json",  // da dove viene la varianza
  "work": "t1 — <la stessa richiesta, parola per parola, data ai tre bracci>",
  "generatedAt": "2026-08-09T10:00:00.000Z",
  "runs": [
    {
      "arm": "board",
      "label": "task dispatchato, agente kanban, worktree isolato",
      "taskId": "7af431e7-...",              // colonne agent_tokens/agent_cache_read_tokens
      "transcriptPath": "/Users/.../x.jsonl",// se c'e', VINCE: i token li legge il reader
      "model": "claude-opus-5[1m]",          // opzionale se il transcript lo dice
      "humanActions": 2,                     // MISURATE nella corsa. Questo e' il cancello.
      "humanActionsStructural": 3,           // conto a mano in UI: si stampa, NON e' un cancello
      "humanActionsStructuralBasis": "creare la card, dispatchare, approvare la review",
      "delivered": true,                     // false => confronto NON appaiato
      "wallMs": 812000,
      "notes": ["..."]
    },
    { "arm": "chat", "transcriptPath": "/Users/.../y.jsonl", "humanActions": 3, "delivered": true },
    { "arm": "cli",  "transcriptPath": "/Users/.../z.jsonl", "delivered": true }
  ],
  "cases": [ /* opzionale, stessa forma di cases.json */ ]
}

Ultimo ripiego, quando non c'e' ne' transcript ne' task: "usage" con i numeri
gia' pronti. Vengono accettati e MARCATI \`declared\` — non sono passati dal
reader, quindi non sono la stessa verita' degli altri.
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheWriteTokens": 0,
             "cacheWrite1hTokens": 0, "cacheReadTokens": 0 }

── cases.json ──────────────────────────────────────────────────────────────────
La matrice dei casi limite. Cercata in docs/board-vs-chat/cases.json.

{
  "schemaVersion": 1,
  "fingerprint": {                      // OBBLIGATORIA, la scrive --emit-cases
    "algo": "sha256",
    "files": { "scripts/board-cases.ts": "<sha256>", "server/...test.ts": "<sha256>" }
  },
  "cases": [
    {
      "id": "agent-question",
      "title": "L'agente fa una domanda a meta' turno",
      "coverage": "covered",            // covered | workaround | uncovered
      "humanActions": 1,
      "proof": {
        "kind": "command",              // command | test | none | source
        "cmd": "bun test server/services/tasks.test.ts -t domanda",
        "exitCode": 0,
        "expectExit": 0,                // opzionale: 0 se non detto
        "output": "<l'output incollato, non un riassunto>"
      },
      "note": "..."
    }
  ]
}

Cosa fa fallire un caso:
  · coverage "uncovered"                       -> il caso non ha strada sulla board
  · proof.kind "none" o "source"               -> letto nel sorgente non e' una prova
  · kind command/test senza exitCode           -> una prova senza esito
  · exitCode diverso da expectExit (default 0) -> la prova e' rossa
  · kind command/test con output vuoto         -> nessun output incollato
  · humanActions oltre --max-actions           -> il caso costa troppe azioni umane

E fa fallire l'INTERA matrice (cancello "stale-matrix"):
  · fingerprint assente                        -> non si potrebbe dichiarare stantia
  · un file dell'impronta con sha256 diverso   -> gli esiti registrati non coprono
    piu' le sorgenti che dichiarano: rieseguire
    bun scripts/board-cases.ts --emit-cases
`.trim();

// ═══════════════════════════════════════════════════════════════════════════
// Lettura e validazione dei file (nessun `any`: tutto entra come `unknown`)
// ═══════════════════════════════════════════════════════════════════════════

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class InputError extends Error {}

const ARMS: readonly Arm[] = ["board", "chat", "cli"];
const COVERAGES: readonly Coverage[] = ["covered", "workaround", "uncovered"];
const PROOF_KINDS: readonly ProofRef["kind"][] = ["command", "test", "none", "source"];

function parseUsage(v: unknown, where: string): Partial<SessionUsage> {
  if (!isRecord(v)) throw new InputError(`${where}: "usage" non è un oggetto`);
  const out: Partial<SessionUsage> = {};
  const keys = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheWrite1hTokens", "cacheReadTokens"] as const;
  for (const k of keys) {
    if (v[k] === undefined) continue;
    const n = asFiniteNumber(v[k]);
    if (n === null || n < 0) throw new InputError(`${where}: "usage.${k}" deve essere un numero >= 0`);
    out[k] = n;
  }
  return out;
}

export function parseEdgeCase(v: unknown, where: string): EdgeCase {
  if (!isRecord(v)) throw new InputError(`${where}: un caso non è un oggetto`);
  const id = asString(v.id);
  if (!id) throw new InputError(`${where}: caso senza "id"`);
  const title = asString(v.title) ?? id;
  const coverage = asString(v.coverage);
  if (!coverage || !COVERAGES.includes(coverage as Coverage)) {
    throw new InputError(`${where}/${id}: "coverage" deve essere uno di ${COVERAGES.join(" | ")}`);
  }
  if (!isRecord(v.proof)) throw new InputError(`${where}/${id}: manca "proof"`);
  const kind = asString(v.proof.kind);
  if (!kind || !PROOF_KINDS.includes(kind as ProofRef["kind"])) {
    throw new InputError(`${where}/${id}: "proof.kind" deve essere uno di ${PROOF_KINDS.join(" | ")}`);
  }
  const proof: ProofRef = { kind: kind as ProofRef["kind"] };
  const cmd = asString(v.proof.cmd);
  if (cmd) proof.cmd = cmd;
  const exitCode = asFiniteNumber(v.proof.exitCode);
  if (exitCode !== null) proof.exitCode = exitCode;
  const expectExit = asFiniteNumber(v.proof.expectExit);
  if (expectExit !== null) proof.expectExit = expectExit;
  if (typeof v.proof.output === "string") proof.output = v.proof.output;

  const humanActions = asFiniteNumber(v.humanActions);
  const note = asString(v.note);
  return {
    id,
    title,
    coverage: coverage as Coverage,
    proof,
    humanActions: v.humanActions === undefined || v.humanActions === null ? null : humanActions,
    ...(note ? { note } : {}),
  };
}

export function parsePairFile(raw: unknown, where: string): PairFile {
  if (!isRecord(raw)) throw new InputError(`${where}: il file non è un oggetto JSON`);
  if (raw.schemaVersion !== 1) throw new InputError(`${where}: "schemaVersion" deve essere 1 (visto ${JSON.stringify(raw.schemaVersion)})`);
  const work = asString(raw.work);
  if (!work) throw new InputError(`${where}: manca "work" — senza sapere QUALE lavoro, il confronto non è appaiato`);
  if (!Array.isArray(raw.runs) || raw.runs.length === 0) throw new InputError(`${where}: "runs" vuoto`);

  const runs: PairRun[] = raw.runs.map((r, i) => {
    const at = `${where}/runs[${i}]`;
    if (!isRecord(r)) throw new InputError(`${at}: non è un oggetto`);
    const arm = asString(r.arm);
    if (!arm || !ARMS.includes(arm as Arm)) throw new InputError(`${at}: "arm" deve essere uno di ${ARMS.join(" | ")}`);
    const run: PairRun = { arm: arm as Arm };
    const label = asString(r.label);
    if (label) run.label = label;
    const model = asString(r.model);
    if (model) run.model = model;
    const transcriptPath = asString(r.transcriptPath);
    if (transcriptPath) run.transcriptPath = transcriptPath;
    const taskId = asString(r.taskId);
    if (taskId) run.taskId = taskId;
    if (r.usage !== undefined) run.usage = parseUsage(r.usage, at);
    if (r.humanActions !== undefined) run.humanActions = asFiniteNumber(r.humanActions);
    if (r.humanActionsStructural !== undefined) run.humanActionsStructural = asFiniteNumber(r.humanActionsStructural);
    const basis = asString(r.humanActionsStructuralBasis);
    if (basis) run.humanActionsStructuralBasis = basis;
    if (r.delivered !== undefined) {
      if (typeof r.delivered !== "boolean") throw new InputError(`${at}: "delivered" deve essere booleano`);
      run.delivered = r.delivered;
    }
    if (r.wallMs !== undefined) run.wallMs = asFiniteNumber(r.wallMs);
    if (Array.isArray(r.notes)) run.notes = r.notes.filter((n): n is string => typeof n === "string");
    if (!run.transcriptPath && !run.taskId && !run.usage) {
      throw new InputError(`${at}: serve almeno "transcriptPath", "taskId" o "usage" — un braccio senza numeri non è un braccio`);
    }
    if (run.taskId && run.arm !== "board") {
      throw new InputError(`${at}: "taskId" vale solo per arm="board" (le colonne agent_* sono dei task)`);
    }
    return run;
  });

  const cases = Array.isArray(raw.cases) ? raw.cases.map((c, i) => parseEdgeCase(c, `${where}/cases[${i}]`)) : undefined;
  const generatedAt = asString(raw.generatedAt);
  const workId = asString(raw.workId);
  const armsBundle = asString(raw.armsBundle);
  const replicate = asFiniteNumber(raw.replicate);
  const replicatesTotal = asFiniteNumber(raw.replicatesTotal);
  return {
    schemaVersion: 1,
    work,
    runs,
    ...(workId ? { workId } : {}),
    ...(replicate === null ? {} : { replicate }),
    ...(replicatesTotal === null ? {} : { replicatesTotal }),
    ...(armsBundle ? { armsBundle } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    ...(cases ? { cases } : {}),
  };
}

/**
 * La varianza delle corse, presa dal bundle che le ha prodotte.
 *
 * Il difetto che chiude: il bundle CALCOLA min/mediana/max per braccio e
 * l'ordine per costo dentro ogni terna, e poi nessuno li leggeva — la barra
 * stampava tre verdetti a tolleranza zero senza mai dire che il braccio di
 * paragone varia 2,25× fra una corsa e l'altra. Un numero calcolato che non
 * arriva al referto è come non calcolato.
 *
 * Legge in modo difensivo: un bundle storto diventa `null`, non un'eccezione —
 * la varianza è un CORREDO del verdetto, non il verdetto.
 */
export function parseArmsVariance(raw: unknown, path: string): ArmsVariance | null {
  if (!isRecord(raw)) return null;
  const summaryRaw = Array.isArray(raw.summary) ? raw.summary : [];
  const asSpread = (v: unknown): Spread => {
    if (!isRecord(v)) return { min: 0, median: 0, max: 0, ratio: null };
    const min = asFiniteNumber(v.min) ?? 0;
    const max = asFiniteNumber(v.max) ?? 0;
    return { min, median: asFiniteNumber(v.median) ?? 0, max, ratio: min > 0 ? max / min : null };
  };
  const summary = summaryRaw.filter(isRecord).map((s) => ({
    arm: asString(s.arm) ?? "?",
    runs: asFiniteNumber(s.runs) ?? 0,
    delivered: asFiniteNumber(s.delivered) ?? 0,
    workTokens: asSpread(s.workTokens),
    cacheReadTokens: asSpread(s.cacheReadTokens),
    costUsd: asSpread(s.costUsd),
    wallClockMs: asSpread(s.wallClockMs),
  }));
  if (summary.length === 0) return null;
  return {
    path,
    baseCommit: asString(raw.baseCommit),
    baseTreeSha: asString(raw.baseTreeSha),
    paired: typeof raw.paired === "boolean" ? raw.paired : null,
    summary,
    costOrderingPerTriple: Array.isArray(raw.costOrderingPerTriple)
      ? raw.costOrderingPerTriple.filter((s): s is string => typeof s === "string")
      : [],
    pairingNotes: Array.isArray(raw.pairingNotes)
      ? raw.pairingNotes.filter((s): s is string => typeof s === "string")
      : [],
  };
}

export function parseCasesFile(raw: unknown, where: string): CasesFile {
  if (!isRecord(raw)) throw new InputError(`${where}: il file non è un oggetto JSON`);
  if (raw.schemaVersion !== 1) throw new InputError(`${where}: "schemaVersion" deve essere 1`);
  if (!Array.isArray(raw.cases)) throw new InputError(`${where}: manca "cases"`);
  return {
    schemaVersion: 1,
    cases: raw.cases.map((c, i) => parseEdgeCase(c, `${where}/cases[${i}]`)),
    fingerprint: parseFingerprint(raw.fingerprint, where),
  };
}

/**
 * L'impronta è OBBLIGATORIA e non ammette scorciatoie: assente o vuota ⇒
 * `InputError`. Renderla facoltativa sarebbe l'ennesimo cancello che si spegne
 * da solo — una matrice senza impronta è esattamente quella che non si può
 * dichiarare stantia.
 */
function parseFingerprint(v: unknown, where: string): MatrixFingerprint {
  if (!isRecord(v)) {
    throw new InputError(
      `${where}: manca "fingerprint". Senza l'impronta delle sorgenti la matrice non può essere ` +
        "dichiarata stantia, e un refactor la lascerebbe verde. Rigenerala con " +
        "`bun scripts/board-cases.ts --emit-cases`.",
    );
  }
  if (v.algo !== "sha256") throw new InputError(`${where}: "fingerprint.algo" deve essere "sha256"`);
  if (!isRecord(v.files)) throw new InputError(`${where}: manca "fingerprint.files"`);
  const files: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.files)) {
    const hex = asString(val);
    if (!hex) throw new InputError(`${where}: "fingerprint.files[${k}]" non è una stringa`);
    files[k] = hex;
  }
  if (Object.keys(files).length === 0) throw new InputError(`${where}: "fingerprint.files" è vuoto`);
  return { algo: "sha256", files };
}

/** Il timbro di un file assente, lo stesso che scrive `--emit-cases`. */
const FINGERPRINT_ABSENT = "ASSENTE";

/**
 * Rifà i conti dell'impronta contro il disco. Torna la lista delle derive, in
 * chiaro: `[]` = la matrice congelata copre ancora le sorgenti che dichiara.
 */
export function fingerprintDrift(fp: MatrixFingerprint, repoRoot: string): string[] {
  const drift: string[] = [];
  for (const [rel, expected] of Object.entries(fp.files)) {
    const abs = join(repoRoot, rel);
    const actual = existsSync(abs)
      ? createHash("sha256").update(readFileSync(abs)).digest("hex")
      : FINGERPRINT_ABSENT;
    if (actual === expected) continue;
    const say = (h: string) => (h === FINGERPRINT_ABSENT ? "assente" : h.slice(0, 12));
    drift.push(`${rel}: atteso ${say(expected)}, trovato ${say(actual)}`);
  }
  return drift;
}

// ═══════════════════════════════════════════════════════════════════════════
// Costo — sempre dal listino vero, mai da un moltiplicatore ricopiato
// ═══════════════════════════════════════════════════════════════════════════

/** Costo esatto quando si ha la scomposizione: è la stessa chiamata di token-live. */
export function exactCost(model: string | null, u: SessionUsage): CostEstimate {
  if (!model) return { kind: "unknown", lowUsd: null, highUsd: null };
  const usd = calculateCostWithCache({
    model,
    freshInputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    // Quote DISGIUNTE: ciò che non è a un'ora è a cinque minuti.
    cacheCreationTokens: Math.max(0, u.cacheWriteTokens - u.cacheWrite1hTokens),
    cacheCreation1hTokens: u.cacheWrite1hTokens,
  });
  return { kind: "exact", lowUsd: usd, highUsd: usd };
}

/**
 * La FORBICE, quando si ha solo il totale di lavoro (una riga di `tasks`).
 *
 * `agent_tokens` è input+output+cache_creation in un numero solo, e le tre voci
 * hanno tariffe che vanno da 1× a 5× l'input. Spacciare un numero secco sarebbe
 * inventare una precisione che il dato non ha — è la stessa ragione per cui la
 * Dashboard non tariffa affatto `agent_tokens`. Qui si dà l'intervallo: sotto,
 * tutto input fresco; sopra, tutto output. Il vero sta dentro, sempre.
 */
export function bracketCost(model: string | null, workTokens: number, cacheReadTokens: number): CostEstimate {
  // Una sola aritmetica: la forbice la calcola board-baseline, qui si veste.
  const b = bracketCostUsd(model, workTokens, cacheReadTokens);
  if (!b) return { kind: "unknown", lowUsd: null, highUsd: null };
  return { kind: "bracket", lowUsd: b.lowUsd, highUsd: b.highUsd };
}

// ═══════════════════════════════════════════════════════════════════════════
// Statistica minima — su liste vuote non inventa numeri
// ═══════════════════════════════════════════════════════════════════════════

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// Misura di un braccio
// ═══════════════════════════════════════════════════════════════════════════

/** Il nome del modello scritto nel transcript. NON conta token: quelli li conta
 *  il reader, e averne una seconda fonte è esattamente ciò che si vuole evitare. */
export function transcriptModel(path: string): string | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  let model: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes('"model"')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecord(parsed) || !isRecord(parsed.message)) continue;
    const m = asString(parsed.message.model);
    // `<synthetic>` non è un modello: è la riga che la CLI scrive per un errore
    // o un'interruzione. Prenderla perde il nome vero.
    if (m && m !== "<synthetic>") model = m;
  }
  return model;
}

export interface BoardTaskRow {
  id: string;
  agent_tokens: number;
  agent_cache_read_tokens: number;
  model: string | null;
  in_progress_at: string | null;
  updated_at: string;
  completed_at: string | null;
  status: string;
}

/**
 * Una riga di `tasks` è comparabile solo se il task è PARTITO dopo lo scorporo
 * della 048.
 *
 * Questa funzione non ha più una regola sua: delega a
 * `board-baseline.isComparablePost048` in modalità `start`. Prima tagliava su
 * `completed_at ?? updated_at` — la FINE — e su `topics-app-ar3jt5` faceva
 * entrare 3 task in più, due dei quali con `agent_cache_read_tokens = 0`, cioè
 * il profilo che la stessa baseline dichiara impossibile per un post-048:
 * `agent_tokens` gonfiato ~2,4× e cache-read inventata a zero, mediati dentro
 * `history.workTokens.median`. Due soglie non possono più divergere perché ora
 * è una sola.
 */
export function isComparableTaskRow(
  row: Pick<BoardTaskRow, "in_progress_at" | "completed_at">,
  migration048At: string | null,
): boolean {
  return isComparablePost048(row, migration048At, "start");
}

interface MeasureDeps {
  readTranscript(path: string): SessionUsage;
  boardTask(taskId: string): BoardTaskRow | null;
  migration048At: string | null;
}

export function measureRun(run: PairRun, deps: MeasureDeps): ArmMeasure {
  const notes: string[] = [...(run.notes ?? [])];
  let source: MeasureSource = "declared";
  let split: SessionUsage | null = null;
  let workTokens = 0;
  let cacheReadTokens = 0;
  let model = run.model ?? null;

  if (run.transcriptPath) {
    if (!existsSync(run.transcriptPath)) {
      notes.push(`transcript assente: ${run.transcriptPath}`);
    } else {
      const usage = deps.readTranscript(run.transcriptPath);
      split = usage;
      source = "transcript";
      workTokens = usage.billableTokens;
      cacheReadTokens = usage.cacheReadTokens;
      model = windowModelFor(transcriptModel(run.transcriptPath), run.model ?? null);
    }
  }

  if (split === null && run.taskId) {
    const row = deps.boardTask(run.taskId);
    if (!row) {
      notes.push(`task ${run.taskId} assente dal DB`);
    } else if (!isComparableTaskRow(row, deps.migration048At)) {
      notes.push(
        `task ${run.taskId} è ANTERIORE alla migration 048 (${deps.migration048At ?? "data ignota"}): ` +
        `agent_tokens gonfiati ~2,4× e cache-read a zero — non comparabile`,
      );
    } else {
      source = "db";
      workTokens = row.agent_tokens;
      cacheReadTokens = row.agent_cache_read_tokens;
      model = windowModelFor(row.model, run.model ?? null);
      notes.push("dal DB: nessuna scomposizione input/output, il costo è una forbice");
    }
  }

  if (split === null && source === "declared" && run.usage) {
    const u = run.usage;
    split = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      cacheWrite1hTokens: u.cacheWrite1hTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      billableTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0),
    };
    workTokens = split.billableTokens;
    cacheReadTokens = split.cacheReadTokens;
    notes.push("numeri DICHIARATI nel file, non letti dal reader del server");
  }

  const cost = split ? exactCost(model, split) : bracketCost(model, workTokens, cacheReadTokens);
  const window = model ? contextWindowFor(model) : null;

  return {
    arm: run.arm,
    label: run.label ?? run.arm,
    model,
    source,
    workTokens,
    cacheReadTokens,
    split,
    humanActions: run.humanActions ?? null,
    humanActionsStructural: run.humanActionsStructural ?? null,
    humanActionsStructuralBasis: run.humanActionsStructuralBasis ?? null,
    delivered: run.delivered ?? true,
    wallMs: run.wallMs ?? null,
    cost,
    contextWindow: window ? window.tokens : null,
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Il confronto appaiato
// ═══════════════════════════════════════════════════════════════════════════

function pct(board: number, chat: number): number | null {
  if (chat <= 0) return null;
  return ((board - chat) / chat) * 100;
}

export function comparePair(file: PairFile, deps: MeasureDeps, tolerancePct: number): PairComparison {
  const measures = file.runs.map((r) => measureRun(r, deps));
  const board = measures.find((m) => m.arm === "board") ?? null;
  const chat = measures.find((m) => m.arm === "chat") ?? null;
  const cli = measures.find((m) => m.arm === "cli") ?? null;

  const workId = file.workId ?? file.work;
  const ident = {
    workId,
    replicate: file.replicate ?? null,
    replicatesTotal: file.replicatesTotal ?? null,
    work: file.work,
  };
  const unpaired = (reason: string): PairComparison => ({
    ...ident, status: "unpaired", reason, measures, axes: [], cliOverhead: null,
  });

  if (!board) return unpaired("manca il braccio board");
  if (!chat) return unpaired("manca il braccio chat — senza il termine di paragone non c'è parità, c'è un numero solo");
  if (!board.delivered) return unpaired("il braccio board non ha consegnato: il lavoro non è lo stesso");
  if (!chat.delivered) return unpaired("il braccio chat non ha consegnato: il lavoro non è lo stesso");
  if (board.workTokens === 0 && board.cacheReadTokens === 0) return unpaired("braccio board a zero token: misura mancante, non parità");
  if (chat.workTokens === 0 && chat.cacheReadTokens === 0) return unpaired("braccio chat a zero token: misura mancante, non parità");

  const factor = 1 + tolerancePct / 100;
  const axes: AxisComparison[] = [
    {
      axis: "work",
      board: board.workTokens,
      chat: chat.workTokens,
      deltaPct: pct(board.workTokens, chat.workTokens),
      ok: board.workTokens <= chat.workTokens * factor,
      gated: true,
    },
    {
      axis: "cacheRead",
      board: board.cacheReadTokens,
      chat: chat.cacheReadTokens,
      deltaPct: pct(board.cacheReadTokens, chat.cacheReadTokens),
      ok: board.cacheReadTokens <= chat.cacheReadTokens * factor,
      gated: true,
    },
  ];

  const cliOverhead = cli
    ? { workPct: pct(board.workTokens, cli.workTokens), cacheReadPct: pct(board.cacheReadTokens, cli.cacheReadTokens) }
    : null;

  return { ...ident, status: "evaluated", reason: null, measures, axes, cliOverhead };
}

// ═══════════════════════════════════════════════════════════════════════════
// Le repliche dello stesso lavoro — un verdetto solo, non N
// ═══════════════════════════════════════════════════════════════════════════

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return { min, median: median(values), max, ratio: min > 0 ? max / min : null };
}

/**
 * Riduce le repliche di uno stesso `workId` a UN verdetto per asse, e toglie il
 * cancello alle righe per-replica.
 *
 * Il difetto che chiude: con tre terne dello stesso lavoro la barra emetteva sei
 * verdetti indipendenti a tolleranza zero. Due erano verdi — ma il braccio di
 * paragone (chat) varia 2,25× fra la corsa più magra e la più grassa, cioè più
 * del delta che quei verdi stavano giudicando. Un verde così non è un verde: è
 * la corsa fortunata. La mediana di tre corse appaiate è ancora poca roba, ma
 * almeno è UNA affermazione, dichiarata come tale e con la forbice accanto.
 */
export function aggregateComparisons(
  comparisons: PairComparison[],
  tolerancePct: number,
  maxActions: number,
): { comparisons: PairComparison[]; aggregates: PairAggregate[] } {
  const groups = new Map<string, PairComparison[]>();
  for (const c of comparisons) {
    if (c.status !== "evaluated") continue;
    const list = groups.get(c.workId);
    if (list) list.push(c);
    else groups.set(c.workId, [c]);
  }

  const multi = new Set([...groups].filter(([, v]) => v.length > 1).map(([k]) => k));
  const rewritten = comparisons.map((c) =>
    multi.has(c.workId) && c.status === "evaluated"
      ? { ...c, axes: c.axes.map((a) => ({ ...a, gated: false })) }
      : c,
  );

  const factor = 1 + tolerancePct / 100;
  const aggregates: PairAggregate[] = [];
  for (const [workId, list] of groups) {
    const gating = list.length > 1;
    const armOf = (c: PairComparison, arm: Arm) => c.measures.find((m) => m.arm === arm) ?? null;
    const axes: AxisAggregate[] = (["work", "cacheRead"] as const).map((axis) => {
      const pick = (m: ArmMeasure | null) => (m === null ? null : axis === "work" ? m.workTokens : m.cacheReadTokens);
      const boardVals = list.map((c) => pick(armOf(c, "board")) ?? 0);
      const chatVals = list.map((c) => pick(armOf(c, "chat")) ?? 0);
      const cliVals = list.map((c) => pick(armOf(c, "cli"))).filter((v): v is number => v !== null);
      const perReplicate = list.map((c) => c.axes.find((a) => a.axis === axis)?.deltaPct ?? 0);
      const boardMedian = median(boardVals);
      const chatMedian = median(chatVals);
      const chatSpread = spread(chatVals);
      const deltaPctMedian = pct(boardMedian, chatMedian);
      const worstDelta = Math.max(...perReplicate.map((d) => Math.abs(d)), 0);
      return {
        axis,
        samples: list.length,
        board: spread(boardVals),
        chat: chatSpread,
        cli: cliVals.length === list.length ? spread(cliVals) : null,
        deltaPctMedian,
        deltaPctPerReplicate: perReplicate,
        boardCheaperIn: list.filter((c) => {
          const b = pick(armOf(c, "board"));
          const ch = pick(armOf(c, "chat"));
          return b !== null && ch !== null && b <= ch;
        }).length,
        comparatorNoisierThanDelta:
          chatSpread.ratio !== null && (chatSpread.ratio - 1) * 100 > worstDelta,
        ok: boardMedian <= chatMedian * factor,
      };
    });

    const boards = list.map((c) => armOf(c, "board")).filter((m): m is ArmMeasure => m !== null);
    const measured = boards.map((m) => m.humanActions).filter((v): v is number => typeof v === "number");
    const structural = boards.map((m) => m.humanActionsStructural).filter((v): v is number => typeof v === "number");
    const measuredMax = measured.length ? Math.max(...measured) : null;
    const structuralMax = structural.length ? Math.max(...structural) : null;

    const notes: string[] = [];
    if (gating) {
      notes.push(`${list.length} repliche dello stesso lavoro: il cancello di parità è QUI, sulle mediane. Le righe per-replica sono campioni singoli.`);
    }
    if (structuralMax !== null) {
      notes.push(
        `azioni umane: ${measuredMax === null ? "non misurate" : measuredMax} misurate nella corsa; ${structuralMax} è il conto a mano del percorso in interfaccia — ` +
          "non è passato di qui e non è un cancello, sta nella matrice dei casi limite.",
      );
    }

    aggregates.push({
      workId,
      work: list[0]?.work ?? workId,
      replicates: list.length,
      gating,
      axes,
      humanActions: {
        measuredMax,
        structuralMax,
        structuralBasis: boards.find((m) => m.humanActionsStructuralBasis)?.humanActionsStructuralBasis ?? null,
        ok: measuredMax === null || measuredMax <= maxActions,
      },
      notes,
    });
  }

  return { comparisons: rewritten, aggregates };
}

// ═══════════════════════════════════════════════════════════════════════════
// I casi limite
// ═══════════════════════════════════════════════════════════════════════════

export function evaluateCase(c: EdgeCase, maxActions: number): CaseVerdict {
  const reasons: string[] = [];

  if (c.coverage === "uncovered") {
    reasons.push("marcato scoperto: sulla board questo caso non ha strada");
  } else {
    // Bar: una riga sostenuta solo dalla lettura del sorgente è bocciata.
    if (c.proof.kind === "none" || c.proof.kind === "source") {
      reasons.push(`prova "${c.proof.kind}": leggere il sorgente non è una prova eseguita`);
    } else {
      const expect = c.proof.expectExit ?? 0;
      if (typeof c.proof.exitCode !== "number") {
        reasons.push("prova senza esito: manca proof.exitCode");
      } else if (c.proof.exitCode !== expect) {
        reasons.push(`prova rossa: exitCode ${c.proof.exitCode}, atteso ${expect}`);
      }
      if (!c.proof.output || c.proof.output.trim().length === 0) {
        reasons.push("prova senza output incollato");
      }
      if (c.proof.kind === "command" && !c.proof.cmd) {
        reasons.push("prova di tipo command senza il comando");
      }
    }
  }

  if (typeof c.humanActions === "number" && c.humanActions > maxActions) {
    reasons.push(`${c.humanActions} azioni umane, oltre il tetto di ${maxActions}`);
  }

  return { id: c.id, title: c.title, coverage: c.coverage, ok: reasons.length === 0, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════
// Il verdetto
// ═══════════════════════════════════════════════════════════════════════════

export interface VerdictInput {
  comparisons: PairComparison[];
  /** Gli aggregati per `workId`. Quando un lavoro ha più repliche, il cancello
   *  di parità sta qui e le righe per-replica non sono cancelli. */
  aggregates?: PairAggregate[];
  cases: CaseVerdict[];
  history: HistoryStats | null;
  maxActions: number;
  /** true quando l'utente ha CHIESTO un confronto appaiato: allora zero
   *  confronti valutabili è un fallimento, non un silenzio. */
  pairRequested: boolean;
}

export function collectFailures(input: VerdictInput): Failure[] {
  const failures: Failure[] = [];

  // Le azioni umane sono una proprietà del LAVORO, non della singola ripetizione:
  // contarle una volta per replica gonfia una sola misura in N fallimenti.
  const humanActionsSeen = new Set<string>();
  for (const c of input.comparisons) {
    if (c.status !== "evaluated") continue;
    for (const axis of c.axes) {
      if (axis.ok || !axis.gated) continue;
      failures.push({
        gate: "token-parity",
        id: `${c.workId} · ${axis.axis}`,
        message:
          `board ${axis.board.toLocaleString("it-IT")} > chat ${axis.chat.toLocaleString("it-IT")} ` +
          `token ${axis.axis === "work" ? "di lavoro" : "di rilettura cache"}` +
          (axis.deltaPct === null ? "" : ` (+${axis.deltaPct.toFixed(1)}%)`),
      });
    }
    for (const m of c.measures) {
      if (m.arm !== "board") continue;
      if (typeof m.humanActions !== "number" || m.humanActions <= input.maxActions) continue;
      if (humanActionsSeen.has(c.workId)) continue;
      humanActionsSeen.add(c.workId);
      failures.push({
        gate: "human-actions",
        id: `${c.workId} · board`,
        message: `${m.humanActions} azioni umane MISURATE per ciclo di feedback, tetto ${input.maxActions}`,
      });
    }
  }

  // Il cancello di parità quando il lavoro è stato ripetuto: una affermazione
  // sola, sulle mediane, con la forbice del braccio di paragone accanto.
  for (const a of input.aggregates ?? []) {
    if (!a.gating) continue;
    for (const axis of a.axes) {
      if (axis.ok) continue;
      failures.push({
        gate: "token-parity",
        id: `${a.workId} · ${axis.axis} (mediana di ${axis.samples})`,
        message:
          `mediana board ${axis.board.median.toLocaleString("it-IT")} > mediana chat ${axis.chat.median.toLocaleString("it-IT")} ` +
          `token ${axis.axis === "work" ? "di lavoro" : "di rilettura cache"}` +
          (axis.deltaPctMedian === null ? "" : ` (+${axis.deltaPctMedian.toFixed(1)}%)`) +
          ` · la board è più economica in ${axis.boardCheaperIn}/${axis.samples} repliche` +
          (axis.chat.ratio === null ? "" : ` · forbice del braccio chat ${axis.chat.ratio.toFixed(2)}×`),
      });
    }
  }

  if (input.pairRequested && input.comparisons.filter((c) => c.status === "evaluated").length === 0) {
    failures.push({
      gate: "input",
      id: "no-comparable-pair",
      message:
        "è stato chiesto un confronto appaiato e non ne è uscito nemmeno uno valutabile: " +
        input.comparisons.map((c) => `«${c.work}» ${c.reason ?? "?"}`).join(" · "),
    });
  }

  for (const c of input.cases) {
    if (c.ok) continue;
    failures.push({
      gate: c.reasons.some((r) => r.includes("azioni umane")) ? "human-actions" : "edge-case",
      id: c.id,
      message: c.reasons.join(" · "),
    });
  }

  // Le mediane dello storico valgono solo se ciò che ci entra è davvero
  // post-048. Una riga con cache-read a zero è la firma di un pre-048 sfuggito
  // alla soglia: il numero che ne esce sarebbe gonfiato, quindi rosso.
  const integrity = input.history?.integrity;
  if (integrity && integrity.impossibleProfiles > 0) {
    failures.push({
      gate: "input",
      id: "storico · profilo impossibile",
      message:
        `${integrity.impossibleProfiles} task dichiarati comparabili hanno agent_cache_read_tokens = 0 — ` +
        `${integrity.rule} Primi: ` +
        integrity.offenders
          .slice(0, 5)
          .map((o) => `${o.taskId} (work ${o.workTokens}, start ${o.inProgressAt ?? "?"})`)
          .join(" · "),
    });
  }

  const ha = input.history?.humanActions;
  if (ha && ha.median > input.maxActions) {
    failures.push({
      gate: "human-actions",
      id: "storico",
      message: `mediana ${ha.median.toFixed(2)} azioni umane per ciclo di review, tetto ${input.maxActions} (p90 ${ha.p90.toFixed(2)}, max ${ha.max.toFixed(2)})`,
    });
  }

  return failures;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lo storico, dal DB in sola lettura
// ═══════════════════════════════════════════════════════════════════════════

interface TaskRowRaw {
  id: string;
  agent_tokens: number;
  agent_cache_read_tokens: number;
  model: string | null;
  in_progress_at: string | null;
  updated_at: string;
  completed_at: string | null;
  status: string;
  human_comments: number;
  approval_decisions: number;
  review_cycles: number;
}

export function migration048Timestamp(db: Database): string | null {
  try {
    const row = db
      .prepare("SELECT applied_at FROM schema_migrations WHERE name LIKE '048-%' ORDER BY version LIMIT 1")
      .get() as { applied_at?: string } | null;
    return row?.applied_at ?? null;
  } catch {
    return null;
  }
}

/** Le azioni umane di UN task, come le racconta il DB: quello che un umano ha
 *  DIGITATO (un commento suo) più le decisioni di approvazione, diviso i cicli
 *  di review. Le righe `kind='status'` non si contano: sono il registro dei
 *  cambi di stato, non un gesto in più. */
export function actionsPerCycle(row: Pick<TaskRowRaw, "human_comments" | "approval_decisions" | "review_cycles">): number {
  const cycles = Math.max(1, row.review_cycles);
  return (row.human_comments + row.approval_decisions) / cycles;
}

export function loadHistory(db: Database, projectId: string | null, maxActions: number): HistoryStats {
  const migration048At = migration048Timestamp(db);
  const rows = db
    .prepare(
      `SELECT t.id, t.agent_tokens, t.agent_cache_read_tokens, t.model,
              t.in_progress_at, t.updated_at, t.completed_at, t.status,
              COALESCE(hc.n, 0) AS human_comments,
              COALESCE(ap.decisions, 0) AS approval_decisions,
              COALESCE(ap.cycles, 0) AS review_cycles
         FROM tasks t
         LEFT JOIN (SELECT task_id, COUNT(*) AS n FROM task_comments
                     WHERE author = 'user' AND kind = 'comment' GROUP BY task_id) hc ON hc.task_id = t.id
         LEFT JOIN (SELECT task_id,
                           SUM(CASE WHEN status IN ('approved','rejected') THEN 1 ELSE 0 END) AS decisions,
                           SUM(CASE WHEN approval_type = 'review' THEN 1 ELSE 0 END) AS cycles
                      FROM approvals GROUP BY task_id) ap ON ap.task_id = t.id
        WHERE t.agent_tokens > 0
          AND (? IS NULL OR t.project_id = ?)`,
    )
    .all(projectId, projectId) as unknown as TaskRowRaw[];

  const comparable = rows.filter((r) => isComparableTaskRow(r, migration048At));
  const stale = rows.length - comparable.length;

  // Il profilo impossibile: comparabile ma con zero riletture di cache.
  const offenders = comparable
    .filter((r) => r.agent_cache_read_tokens === 0)
    .map((r) => ({
      taskId: r.id,
      workTokens: r.agent_tokens,
      inProgressAt: r.in_progress_at,
      completedAt: r.completed_at,
    }));

  const work = comparable.map((r) => r.agent_tokens);
  const cacheRead = comparable.map((r) => r.agent_cache_read_tokens);

  let lowUsd = 0;
  let highUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of comparable) {
    const c = bracketCost(r.model, r.agent_tokens, r.agent_cache_read_tokens);
    if (c.kind === "unknown" || c.lowUsd === null || c.highUsd === null) { unpriced++; continue; }
    priced++;
    lowUsd += c.lowUsd;
    highUsd += c.highUsd;
  }

  const perCycle = comparable.map((r) => ({ taskId: r.id, actionsPerCycle: actionsPerCycle(r) }));
  const apcValues = perCycle.map((p) => p.actionsPerCycle);

  return {
    projectId,
    comparable: comparable.length,
    preMigration048: stale,
    migration048At,
    integrity: {
      rule:
        "un task comparabile (post-048) DEVE avere agent_cache_read_tokens > 0: un turno di agente rilegge " +
        "sempre la cache. Zero riletture = riga pre-048 entrata dalla porta sbagliata.",
      impossibleProfiles: offenders.length,
      offenders: offenders.slice(0, 10),
    },
    workTokens: { median: median(work), mean: mean(work), p90: percentile(work, 90), total: work.reduce((a, b) => a + b, 0) },
    cacheReadTokens: {
      median: median(cacheRead), mean: mean(cacheRead), p90: percentile(cacheRead, 90),
      total: cacheRead.reduce((a, b) => a + b, 0),
    },
    costUsd: { lowUsd, highUsd, pricedTasks: priced, unpricedTasks: unpriced },
    humanActions: comparable.length === 0 ? null : {
      median: median(apcValues),
      mean: mean(apcValues),
      p90: percentile(apcValues, 90),
      max: apcValues.reduce((a, b) => Math.max(a, b), 0),
      overLimit: perCycle.filter((p) => p.actionsPerCycle > maxActions).sort((a, b) => b.actionsPerCycle - a.actionsPerCycle).slice(0, 10),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

interface Options {
  json: boolean;
  pairPaths: string[];
  casesPath: string | null;
  pairRequested: boolean;
  projectId: string | null;
  dbPath: string;
  maxActions: number;
  tolerancePct: number;
  noHistory: boolean;
  printSchema: boolean;
  /** Che cosa deve far uscire non-zero. `all` (default): anche un verdetto
   *  negativo. `harness`: solo un attrezzo rotto — il verdetto resta un campo
   *  rosso nel report, per chi vuole sorvegliare la salute del rig senza che il
   *  «no» della misura suoni come un guasto. */
  gate: "all" | "harness";
}

const DEFAULT_PAIR_DIR = "docs/board-vs-chat";

export function parseArgs(argv: string[], repoRoot: string): Options {
  const opts: Options = {
    json: false,
    pairPaths: [],
    casesPath: null,
    pairRequested: false,
    projectId: null,
    dbPath: process.env.DATA_DIR ? join(process.env.DATA_DIR, "topics.db") : join(repoRoot, "data", "topics.db"),
    maxActions: 2,
    tolerancePct: 0,
    noHistory: false,
    printSchema: false,
    gate: "all",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InputError(`${a}: manca il valore`);
      return v;
    };
    switch (a) {
      case "--json": opts.json = true; break;
      case "--pair": opts.pairPaths.push(next()); opts.pairRequested = true; break;
      case "--cases": opts.casesPath = next(); break;
      case "--project": opts.projectId = next(); break;
      case "--db": opts.dbPath = next(); break;
      case "--max-actions": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) throw new InputError("--max-actions vuole un numero >= 0");
        opts.maxActions = n; break;
      }
      case "--tolerance-pct": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) throw new InputError("--tolerance-pct vuole un numero >= 0");
        opts.tolerancePct = n; break;
      }
      case "--gate": {
        const v = next();
        if (v !== "all" && v !== "harness") throw new InputError('--gate vuole "all" o "harness"');
        opts.gate = v; break;
      }
      case "--no-history": opts.noHistory = true; break;
      case "--print-schema": opts.printSchema = true; break;
      case "--help": case "-h": opts.printSchema = true; break;
      default:
        // Anche un argomento NUDO è un errore: `board-vs-chat.ts run.pair.json`
        // è la svista naturale, e ingoiarla in silenzio farebbe uscire 0 su un
        // file che nessuno ha letto — il modo più elegante di mentire.
        if (a !== undefined) {
          throw new InputError(
            a.startsWith("--") ? `opzione sconosciuta: ${a}` : `argomento nudo "${a}": i file si passano con --pair o --cases`,
          );
        }
    }
  }
  return opts;
}

function discoverPairFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, DEFAULT_PAIR_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".pair.json")).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

const fmtUsd = (c: CostEstimate): string => {
  if (c.kind === "unknown" || c.lowUsd === null || c.highUsd === null) return "modello ignoto";
  if (c.kind === "exact") return `$${c.lowUsd.toFixed(2)}`;
  return `$${c.lowUsd.toFixed(2)}–${c.highUsd.toFixed(2)} (forbice)`;
};

function renderText(report: Report): string {
  const out: string[] = [];
  out.push("");
  out.push("board-vs-chat — la board costa meno di una chat, a parità di lavoro?");
  out.push("");

  const h = report.history;
  if (h) {
    out.push(`STORICO${h.projectId ? ` · progetto ${h.projectId}` : " · tutti i progetti"}`);
    out.push(`  task comparabili (post-048) ....... ${h.comparable}`);
    out.push(`  esclusi, pre-migration 048 ........ ${h.preMigration048}   (agent_tokens gonfiati ~2,4×, cache-read a zero)`);
    out.push(`  soglia 048 ........................ ${h.migration048At ?? "ignota — nessuna riga in schema_migrations"}`);
    if (h.comparable > 0) {
      out.push(`  token di LAVORO per task .......... mediana ${fmtTok(h.workTokens.median)} · media ${fmtTok(h.workTokens.mean)} · p90 ${fmtTok(h.workTokens.p90)} · totale ${fmtTok(h.workTokens.total)}`);
      out.push(`  token di RILETTURA cache per task . mediana ${fmtTok(h.cacheReadTokens.median)} · media ${fmtTok(h.cacheReadTokens.mean)} · p90 ${fmtTok(h.cacheReadTokens.p90)} · totale ${fmtTok(h.cacheReadTokens.total)}`);
      out.push(`  (i due NON si sommano qui: work+cacheRead = ${fmtTok(h.workTokens.total + h.cacheReadTokens.total)}, ed è un totale LETTO, non «i token»)`);
      out.push(`  costo dell'insieme ................ $${h.costUsd.lowUsd.toFixed(2)}–${h.costUsd.highUsd.toFixed(2)} · forbice su ${h.costUsd.pricedTasks} task${h.costUsd.unpricedTasks ? `, ${h.costUsd.unpricedTasks} senza modello` : ""}`);
    }
    if (h.humanActions) {
      const a = h.humanActions;
      out.push(`  azioni umane per ciclo di review .. mediana ${a.median.toFixed(2)} · media ${a.mean.toFixed(2)} · p90 ${a.p90.toFixed(2)} · max ${a.max.toFixed(2)}   (tetto ${report.maxActions})`);
      if (a.overLimit.length > 0) {
        out.push(`     oltre il tetto: ${a.overLimit.map((o) => `${o.taskId.slice(0, 8)}=${o.actionsPerCycle.toFixed(1)}`).join(" ")}`);
      }
    }
    out.push("  Lo storico NON è appaiato: dice quanto costa la board, non se costa meno della chat.");
    out.push("");
  }

  if (report.comparisons.length === 0) {
    out.push("CONFRONTI APPAIATI — nessuno.");
    out.push(`  Metti un file <nome>.pair.json in ${DEFAULT_PAIR_DIR}/ o passa --pair.`);
    out.push("  Contratto del file: bun scripts/board-vs-chat.ts --print-schema");
    out.push("");
  } else {
    out.push("CONFRONTI APPAIATI");
    // Il testo integrale del lavoro va detto UNA volta: ripeterlo per ogni
    // replica seppelliva i numeri sotto dieci righe di prompt identico.
    const seenWork = new Set<string>();
    for (const c of report.comparisons) {
      const head =
        `${c.workId}${c.replicate === null ? "" : ` · replica ${c.replicate}${c.replicatesTotal === null ? "" : `/${c.replicatesTotal}`}`}`;
      out.push(`  ${c.status === "evaluated" ? "▸" : "○"} ${head}`);
      if (!seenWork.has(c.workId)) {
        seenWork.add(c.workId);
        const firstLine = c.work.split("\n")[0] ?? c.work;
        out.push(`      lavoro: ${firstLine}${c.work.includes("\n") ? " […testo integrale nel .pair.json]" : ""}`);
      }
      for (const m of c.measures) {
        const win = m.contextWindow ? ` · finestra ${fmtTok(m.contextWindow)}` : "";
        out.push(
          `      ${m.arm.padEnd(6)} work ${fmtTok(m.workTokens).padStart(8)} · cacheRead ${fmtTok(m.cacheReadTokens).padStart(8)} · ` +
          `${fmtUsd(m.cost).padEnd(24)} [${m.source}]${m.model ? ` ${m.model}` : ""}${win}` +
          `${m.humanActions === null ? "" : ` · ${m.humanActions} azioni umane misurate`}` +
          `${m.humanActionsStructural === null ? "" : ` (${m.humanActionsStructural} a mano in UI, non un cancello)`}` +
          `${m.delivered ? "" : " · NON CONSEGNATO"}`,
        );
        for (const n of m.notes) out.push(`             ! ${n}`);
      }
      if (c.status === "unpaired") {
        out.push(`      NON APPAIATO: ${c.reason ?? "?"} — nessun verdetto, e non conta come parità.`);
      } else {
        for (const axis of c.axes) {
          const label = axis.axis === "work" ? "lavoro   " : "cacheRead";
          const delta = axis.deltaPct === null ? "n/d" : `${axis.deltaPct >= 0 ? "+" : ""}${axis.deltaPct.toFixed(1)}%`;
          // Senza questa etichetta la riga si legge come un verdetto. Non lo è
          // quando il lavoro è stato ripetuto: è UNA estrazione su N.
          const tag = axis.gated ? "" : "   ← campione singolo, non un cancello (vedi l'aggregato)";
          out.push(`      ${axis.gated ? (axis.ok ? "ok " : "NO ") : "·  "} ${label}  board vs chat: ${delta}${tag}`);
        }
        if (c.cliOverhead) {
          const w = c.cliOverhead.workPct;
          out.push(`      · sovrapprezzo sul pavimento CLI: ${w === null ? "n/d" : `${w >= 0 ? "+" : ""}${w.toFixed(1)}%`} di lavoro — informativo, non un cancello`);
        }
      }
    }
    out.push("");
  }

  const gatingAggregates = report.aggregates.filter((a) => a.gating);
  if (gatingAggregates.length > 0) {
    out.push("REPLICHE DELLO STESSO LAVORO — qui sta il cancello di parità");
    for (const a of gatingAggregates) {
      out.push(`  ▸ ${a.workId}   ${a.replicates} repliche`);
      for (const axis of a.axes) {
        const label = axis.axis === "work" ? "lavoro   " : "cacheRead";
        const d = axis.deltaPctMedian;
        const delta = d === null ? "n/d" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
        out.push(
          `      ${axis.ok ? "ok " : "NO "} ${label}  mediana board ${fmtTok(axis.board.median)} vs chat ${fmtTok(axis.chat.median)} → ${delta}` +
            `   · board più economica in ${axis.boardCheaperIn}/${axis.samples}`,
        );
        out.push(
          `             forbici: board ${fmtTok(axis.board.min)}–${fmtTok(axis.board.max)}` +
            `${axis.board.ratio === null ? "" : ` (${axis.board.ratio.toFixed(2)}×)`}` +
            ` · chat ${fmtTok(axis.chat.min)}–${fmtTok(axis.chat.max)}` +
            `${axis.chat.ratio === null ? "" : ` (${axis.chat.ratio.toFixed(2)}×)`}` +
            `${axis.cli === null ? "" : ` · cli ${fmtTok(axis.cli.min)}–${fmtTok(axis.cli.max)}`}`,
        );
        out.push(
          `             delta per replica: ${axis.deltaPctPerReplicate.map((v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`).join(" · ")}`,
        );
        if (axis.comparatorNoisierThanDelta) {
          out.push("             ⚠ il braccio di paragone varia PIÙ del delta giudicato: il verdetto per-replica è rumore, non un esito.");
        }
      }
      for (const n of a.notes) out.push(`      ! ${n}`);
    }
    out.push("");
  }

  if (report.armsVariance.length > 0) {
    out.push("VARIANZA DELLE CORSE (dal bundle che le ha prodotte)");
    for (const v of report.armsVariance) {
      out.push(`  ${v.path}${v.paired === null ? "" : `   paired=${String(v.paired)}`}`);
      if (v.baseCommit) out.push(`    baseCommit ${v.baseCommit.slice(0, 12)}${v.baseTreeSha ? ` · baseTreeSha ${v.baseTreeSha.slice(0, 12)}` : ""}`);
      for (const s of v.summary) {
        out.push(
          `    ${s.arm.padEnd(10)} ${s.runs} corse (${s.delivered} consegnate) · work ${fmtTok(s.workTokens.min)}/${fmtTok(s.workTokens.median)}/${fmtTok(s.workTokens.max)}` +
            `${s.workTokens.ratio === null ? "" : ` ${s.workTokens.ratio.toFixed(2)}×`}` +
            ` · cacheRead ${fmtTok(s.cacheReadTokens.min)}/${fmtTok(s.cacheReadTokens.median)}/${fmtTok(s.cacheReadTokens.max)}` +
            `${s.cacheReadTokens.ratio === null ? "" : ` ${s.cacheReadTokens.ratio.toFixed(2)}×`}`,
        );
      }
      out.push("    (min/mediana/max — i due assi non si sommano)");
      if (v.costOrderingPerTriple.length) {
        const distinct = new Set(v.costOrderingPerTriple);
        out.push(`    ordine per costo dentro ogni terna: ${v.costOrderingPerTriple.join(" | ")}`);
        out.push(
          distinct.size === 1
            ? "    l'ordine NON si ribalta fra le terne: è l'affermazione più solida che questi dati sostengono."
            : "    l'ordine SI RIBALTA fra le terne: la differenza fra i bracci è dentro il rumore.",
        );
      }
      for (const n of v.pairingNotes) out.push(`    ! ${n}`);
    }
    out.push("");
  }

  if (report.cases.length === 0) {
    out.push("CASI LIMITE — matrice ASSENTE: cancello ROSSO, non «non valutato».");
    out.push(`  Attesa in ${DEFAULT_PAIR_DIR}/cases.json, oppure --cases <file>.`);
    out.push("  Rigenerala con: bun scripts/board-cases.ts --emit-cases");
    out.push("");
  } else {
    out.push("CASI LIMITE");
    for (const c of report.cases) {
      out.push(`  ${c.ok ? "ok " : "NO "} ${c.id.padEnd(24)} ${c.coverage.padEnd(10)} ${c.title}`);
      for (const r of c.reasons) out.push(`         ${r}`);
    }
    out.push("");
  }

  if (report.notEvaluated.length > 0) {
    out.push("NON VALUTATO (un'assenza non è un verde)");
    for (const n of report.notEvaluated) out.push(`  · ${n}`);
    out.push("");
  }

  if (report.failures.length === 0) {
    out.push("VERDETTO: nessun cancello rotto fra quelli che c'erano da valutare.");
  } else {
    out.push(`VERDETTO: ${report.failures.length} cancello/i rotto/i`);
    for (const f of report.failures) out.push(`  ✗ [${f.gate}] ${f.id}: ${f.message}`);
    // Un rosso di parità NON è un guasto della barra: è la risposta. Senza
    // questa riga qualcuno prova ad «aggiustarlo» alzando la tolleranza.
    if (report.failures.some((f) => f.gate === "token-parity")) {
      out.push("");
      out.push("  Il rosso di [token-parity] è la MISURA, non un guasto: su questo lavoro la board");
      out.push("  costa di più della chat. Non si aggiusta con --tolerance-pct — o l'envelope di");
      out.push("  dispatch costa meno, o la domanda «da oggi solo board?» ha risposta «no, a questo");
      out.push("  prezzo», e va decisa da una persona. Un «sì» non dimostrato vale meno di un «no» misurato.");
      out.push("");
      out.push("  A QUALE effort, però: la board gira a medium (board_settings.dispatch_effort) e una");
      out.push("  chat senza override parte a xhigh (resolveClaudeEffort). Un confronto contro il braccio");
      out.push("  `chat` a medium tiene basso proprio il termine di paragone, quindi quel delta è un");
      out.push("  TETTO alla penalità della board, non la penalità. Il confronto onesto è `chat-xhigh`.");
    }
    out.push("");
    out.push(
      report.harnessOk
        ? "  L'attrezzo ha lavorato: questi numeri sono una misura (uscita 3 = misura negativa)."
        : "  L'attrezzo NON ha potuto lavorare (uscita 1): i numeri qui sopra non sono una misura,\n" +
            "  sono ciò che si è riusciti a leggere da input incompleti. Sistema l'attrezzo, poi rileggi.",
    );
  }
  out.push("");
  return out.join("\n");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function main(argv: string[], repoRoot: string): number {
  let opts: Options;
  try {
    opts = parseArgs(argv, repoRoot);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (opts.printSchema) {
    console.log(SCHEMA_DOC);
    return 0;
  }

  const notEvaluated: string[] = [];

  // ── DB, in sola lettura ───────────────────────────────────────────────────
  let db: Database | null = null;
  if (!existsSync(opts.dbPath)) {
    notEvaluated.push(`nessun DB in ${opts.dbPath}: storico e task-id non risolvibili (passa --db o DATA_DIR)`);
  } else {
    db = new Database(opts.dbPath, { readonly: true });
  }

  const reader = createTranscriptUsageReader();
  const migration048At = db ? migration048Timestamp(db) : null;
  const boardTaskStmt = db
    ? db.prepare(
        "SELECT id, agent_tokens, agent_cache_read_tokens, model, in_progress_at, updated_at, completed_at, status FROM tasks WHERE id = ?",
      )
    : null;

  const deps: MeasureDeps = {
    readTranscript: (p) => {
      try { return reader.read(p); } catch { return ZERO_USAGE; }
    },
    boardTask: (taskId) => (boardTaskStmt ? ((boardTaskStmt.get(taskId) as BoardTaskRow | null) ?? null) : null),
    migration048At,
  };

  // ── Confronti appaiati ────────────────────────────────────────────────────
  const pairPaths = opts.pairPaths.length > 0 ? opts.pairPaths : discoverPairFiles(repoRoot);
  const rawComparisons: PairComparison[] = [];
  const casesFromPairs: EdgeCase[] = [];
  const inputFailures: Failure[] = [];
  const bundlePaths = new Set<string>();

  for (const p of pairPaths) {
    try {
      const file = parsePairFile(readJson(p), p);
      rawComparisons.push(comparePair(file, deps, opts.tolerancePct));
      if (file.cases) casesFromPairs.push(...file.cases);
      if (file.armsBundle) bundlePaths.add(join(repoRoot, file.armsBundle));
    } catch (err) {
      inputFailures.push({ gate: "input", id: p, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (pairPaths.length === 0) {
    notEvaluated.push(`parità di token: nessun file appaiato (né --pair né ${DEFAULT_PAIR_DIR}/*.pair.json)`);
  }
  const { comparisons, aggregates } = aggregateComparisons(rawComparisons, opts.tolerancePct, opts.maxActions);

  // La varianza dei bracci, dal bundle che le corse hanno prodotto. Un file
  // dichiarato e assente non è un silenzio: è una riga in `notEvaluated`.
  const armsVariance: ArmsVariance[] = [];
  for (const bp of bundlePaths) {
    if (!existsSync(bp)) {
      notEvaluated.push(`varianza dei bracci: il bundle dichiarato dalle terne non esiste (${bp})`);
      continue;
    }
    try {
      const v = parseArmsVariance(readJson(bp), bp);
      if (v) armsVariance.push(v);
      else notEvaluated.push(`varianza dei bracci: ${bp} non ha un "summary" leggibile`);
    } catch (err) {
      notEvaluated.push(`varianza dei bracci: ${bp} illeggibile — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Matrice dei casi limite ───────────────────────────────────────────────
  const defaultCases = join(repoRoot, DEFAULT_PAIR_DIR, "cases.json");
  const casesPath = opts.casesPath ?? (existsSync(defaultCases) ? defaultCases : null);
  const cases: EdgeCase[] = [...casesFromPairs];
  if (casesPath) {
    try {
      const file = parseCasesFile(readJson(casesPath), casesPath);
      cases.push(...file.cases);
      // La matrice è CONGELATA: qui si legge l'esito che le prove hanno avuto
      // quando sono girate, non le si riesegue. Vale finché le sorgenti sotto
      // sono le stesse — appena una cambia, l'esito registrato è un ricordo, e
      // un ricordo non è un cancello.
      const drift = fingerprintDrift(file.fingerprint, repoRoot);
      if (drift.length) {
        inputFailures.push({
          gate: "stale-matrix",
          id: casesPath,
          message:
            `matrice STANTIA: ${drift.length} file su ${Object.keys(file.fingerprint.files).length} sono cambiati ` +
            "dopo che le prove sono state registrate, quindi gli esiti dentro cases.json non coprono più le " +
            "sorgenti che dichiarano. Rieseguila con `bun scripts/board-cases.ts --emit-cases`. Derive: " +
            drift.slice(0, 8).join(" · ") +
            (drift.length > 8 ? ` · (+${drift.length - 8} altri)` : ""),
        });
      }
    } catch (err) {
      inputFailures.push({ gate: "input", id: casesPath, message: err instanceof Error ? err.message : String(err) });
    }
  }
  // Il cancello dei casi limite non si auto-disattiva. Prima, se la matrice non
  // c'era, la riga finiva in `notEvaluated` — che NON è fatale — e il terzo
  // cancello spariva restando verde: un'asserzione che non può fallire. La
  // matrice è un file versionato (`docs/board-vs-chat/cases.json`, tenuto in
  // git da un'eccezione esplicita in .gitignore): assente = rosso, come per un
  // `--cases` illeggibile.
  if (cases.length === 0) {
    inputFailures.push({
      gate: "input",
      id: casesPath ?? join(DEFAULT_PAIR_DIR, "cases.json"),
      message:
        "casi limite: matrice assente o vuota. Il terzo cancello non può girare, e non va scambiato per un verde. " +
        `Attesa in ${DEFAULT_PAIR_DIR}/cases.json (rigenerabile con \`bun scripts/board-cases.ts --emit-cases\`), oppure --cases <file>.`,
    });
  }

  const caseVerdicts = cases.map((c) => evaluateCase(c, opts.maxActions));

  // ── Storico ───────────────────────────────────────────────────────────────
  let history: HistoryStats | null = null;
  if (opts.noHistory) {
    notEvaluated.push("storico: saltato con --no-history");
  } else if (db) {
    history = loadHistory(db, opts.projectId, opts.maxActions);
    if (history.migration048At === null) {
      notEvaluated.push("soglia della migration 048 non trovata: nessuna riga di tasks è stata giudicata comparabile");
    }
  }

  const failures = [
    ...inputFailures,
    ...collectFailures({ comparisons, aggregates, cases: caseVerdicts, history, maxActions: opts.maxActions, pairRequested: opts.pairRequested }),
  ];

  const harnessOk = !failures.some((f) => GATE_KIND[f.gate] === "harness");
  const verdictOk = !failures.some((f) => GATE_KIND[f.gate] === "verdict");
  const report: Report = {
    ok: failures.length === 0,
    harnessOk,
    verdictOk,
    exitCode: !harnessOk ? EXIT.harness : verdictOk ? EXIT.ok : opts.gate === "harness" ? EXIT.ok : EXIT.verdict,
    generatedAt: new Date().toISOString(),
    maxActions: opts.maxActions,
    tolerancePct: opts.tolerancePct,
    history,
    comparisons,
    aggregates,
    armsVariance,
    cases: caseVerdicts,
    failures,
    notEvaluated,
  };

  db?.close();

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));

  // Due domande, due codici. Un rosso di `harness` vince sempre su un rosso di
  // `verdict`: se l'attrezzo non ha potuto lavorare, il verdetto che ha
  // stampato non è una misura e non va trattato come tale.
  return report.exitCode;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), join(import.meta.dir, "..")));
}
