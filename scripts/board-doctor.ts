#!/usr/bin/env bun
/**
 * board-doctor — il sorvegliante della board: guarda, e PARLA PER PRIMO solo
 * quando c'e' qualcosa su cui agire.
 *
 * ── La disciplina, che conta piu' dei controlli ───────────────────────────────
 * Un sorvegliante proattivo diventa rumore di fondo dopo tre segnalazioni
 * inutili, e allora tanto vale non averlo. Le cinque regole non sono buone
 * intenzioni scritte in un commento: qui sono strutturali, e i test le
 * verificano una per una.
 *
 *   1. Parla SOLO quando un controllo FALLISCE. Non esiste un modo di emettere
 *      «controllo X: ok»: `runChecks` restituisce rilievi, e su una board sana
 *      restituisce l'array vuoto. Dove manca il dato per decidere il controllo
 *      TACE e finisce in `skipped` — il silenzio per ignoranza e' dichiarato,
 *      non spacciato per assoluzione. `skipped` vale pero' solo per il dato che
 *      PUO' mancare (una baseline non passata, un rosso mai misurato): un file
 *      VERSIONATO che non c'e' e' un guasto e va detto a voce alta, altrimenti
 *      e' la corsia in cui un controllo muore inosservato — vedi il nono.
 *   2. Ogni rilievo porta IL COMANDO CHE LO PROVA. `finding()` rifiuta di
 *      costruire un rilievo senza `proof`, e `assertProofIsReadOnly` rifiuta un
 *      comando che scrive: la prova si incolla in un terminale per NON credergli.
 *   3. Ogni rilievo nomina L'AZIONE. Anche questa e' obbligatoria: se non c'e'
 *      niente da fare non e' un rilievo, e' una curiosita'.
 *   4. Non agisce mai da solo. Questo file apre il DB `{ readonly: true }`, gira
 *      solo comandi git di lettura, e l'unica cosa che scrive e' il proprio
 *      registro — e solo con `--remember`.
 *   5. Lo dice UNA volta per occorrenza. Ogni rilievo ha una `occurrence`
 *      stabile finche' il fatto e' lo stesso e diversa quando il fatto cambia
 *      (un nuovo commit di consegna, un nuovo tentativo, il branch che si
 *      muove). Il registro filtra il resto.
 *
 * ── I controlli: solo guasti GIA' SUCCESSI ───────────────────────────────────
 * Nessun controllo su un guasto immaginato. Ognuno dei nove e' capitato
 * davvero su questa board, e ognuno porta il modo di provarlo. Si aggiungono
 * controlli quando succede qualcosa di nuovo, non quando viene in mente
 * qualcosa di nuovo — il settimo e l'ottavo sono entrati il 2026-08-10, il
 * giorno in cui i loro guasti sono stati trovati a mano; il nono il 2026-08-11,
 * quando si e' scoperto che il settimo era rimasto CIECO per settimane perche'
 * il documento che legge era in `.gitignore` e la sua assenza si limitava a
 * finire in `skipped`.
 *
 * ── Il controllo piu' difficile: quando NON allarmare ────────────────────────
 * Un task fermo puo' essere un cambio di turno, non un fantasma. Due trappole,
 * sbagliate entrambe a mano prima di scrivere questo file:
 *   · `topics.updated_at` e' scritto UTC ma SENZA zona (`2026-04-07 11:01:09`):
 *     `new Date()` lo legge come locale e in Europe/Rome d'estate lo invecchia
 *     di due ore. Un task appena toccato sembra fermo da un pezzo. Si legge solo
 *     con `parseDbTimestamp`.
 *   · l'assenza di movimento non e' una morte. Serve una PROVA POSITIVA:
 *     nessun figlio vivo E nessun avanzamento, per N sondaggi distinti
 *     (`isProvablyDead`). I sondaggi si accumulano fra un giro e l'altro nel
 *     registro: il doctor non dorme mai in attesa di una seconda misura.
 *
 * ── Quanto rumore fa, misurato ───────────────────────────────────────────────
 * Sulla board vera del 2026-08-10 (42 card attive, mai sorvegliate prima):
 *   · primo giro: 14 rilievi, che si LEGGONO come 8 blocchi — 10 branch che al
 *     land trascinerebbero lavoro altrui (ma raggruppati in 4 cause, perche' la
 *     linea ereditata e' la stessa) e 4 costi oltre 3× la mediana della loro
 *     classe. E' l'arretrato di una board mai guardata, non il ritmo;
 *   · secondo giro e successivi, a parita' di fatti: ZERO. Nessuna riga.
 * La misura ha prodotto DUE strette, che e' il motivo per cui si misura:
 *   1. il controllo sul land parlava anche delle card ancora in corso, e
 *      siccome l'occorrenza e' la punta del branch avrebbe riparlato a ogni
 *      commit di una cosa che nessuno stava per cliccare. Ora solo in `review`;
 *   2. dieci card ereditavano gli STESSI commit dallo stesso checkout sporco:
 *      dieci righe per una decisione sola. Ora si leggono in un blocco per
 *      causa (il registro resta per card: sono dieci fatti distinti).
 * Il ritmo, misurato su due ore di board viva, e' stato di 7 rilievi nuovi:
 *   alto, e non e' un difetto del doctor — e' che questa board sta davvero
 *   producendo branch contaminati, per un motivo solo (il checkout condiviso
 *   parcheggiato su un branch di lavoro).
 *
 *   bun scripts/board-doctor.ts                  # i rilievi nuovi, o niente
 *   bun scripts/board-doctor.ts --json           # il rapporto completo
 *   bun scripts/board-doctor.ts --all            # anche cio' che ha gia' detto
 *   bun scripts/board-doctor.ts --remember       # segna come detto
 *   bun scripts/board-doctor.ts --watch [--interval 120]   # una riga per rilievo nuovo
 *   bun scripts/board-doctor.ts --day 2026-08-09 # misura del rumore su un giorno
 *   bun scripts/board-doctor.ts --gate           # exit 1 se c'e' un rilievo nuovo
 *   bun scripts/board-doctor.ts --probe-red "<comando>" --task <id>
 *
 * `--watch` e' anche l'unico modo in cui il controllo sul «fermo» diventa vivo:
 * i sondaggi di vitalita' si accumulano fra un giro e l'altro, e servono tre
 * giri concordi prima che qualcuno venga dichiarato fermo.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PROJECT_ID, THRESHOLDS, type SizeClass } from "./board-baseline";
import { splitAheadCommits, type GitRunner } from "../server/services/own-commits";

// ── Parametri dichiarati ─────────────────────────────────────────────────────

/**
 * Le soglie stanno TUTTE qui, scelte prima di guardare la board, perche' una
 * soglia scelta dopo aver visto i dati produce sempre il numero di rilievi che
 * si voleva vedere.
 */
export const DOCTOR = {
  needsInput: {
    /** Un solo tentativo senza risposta e' un turno umano, non un guasto. */
    minAttempts: 2,
    /** Sotto i 45' la domanda e' semplicemente recente. */
    minAgeMs: 45 * 60_000,
    /** Sondaggi concordi richiesti prima di chiamarlo fermo. */
    minProbes: 3,
  },
  liveness: {
    /**
     * Una sessione in fase `running` il cui ultimo battito e' piu' vecchio di
     * questo non e' un figlio vivo: e' una fase rimasta appesa. La finestra e'
     * larga apposta — sbagliare qui produce falsi allarmi, che e' il difetto
     * che questo file esiste per evitare.
     */
    heartbeatMs: 10 * 60_000,
    /** Le fasi che significano «c'e' un processo che sta lavorando». */
    workingPhases: new Set(["running", "tool-running", "starting"]),
  },
  cost: {
    /** Quante volte la mediana della sua classe prima di chiamarlo fuori scala. */
    factor: 3,
    /** Sotto questa numerosita' la classe non ha una mediana: nessun allarme. */
    minClassN: 8,
  },
  /**
   * Le superfici che l'umano VEDE. Una consegna che le tocca ha prodotto un
   * comportamento, e un comportamento senza anteprima durevole non e'
   * verificabile fra un mese (protocollo #4).
   */
  visibleSurfaces: ["client/src/", "landing/", "public/"] as readonly string[],
  /**
   * Il tetto al rumore, in rilievi PER GIRO a regime — non al primo sguardo su
   * una board mai sorvegliata, dove esce l'arretrato. Misurato il 2026-08-10:
   * 7 al primo giro, 0 a tutti quelli dopo. Se un giorno il ritmo supera questa
   * soglia, la disciplina non regge e va stretta prima di spedire altro.
   */
  noiseCeiling: 5,
} as const;

export type CheckId =
  | "delivery-cites-absent-artifact"
  | "behaviour-without-preview"
  | "land-drags-foreign-commits"
  | "needs-input-unanswered"
  | "environmental-red"
  | "cost-out-of-class"
  | "documented-parameter-not-declared"
  | "delivery-commit-not-own"
  | "protocol-doc-missing";

// ── Il rilievo, e le regole che ne vietano uno inutile ───────────────────────

export interface Finding {
  check: CheckId;
  /**
   * La card, quando ce n'e' una. Due controlli guardano il REPOSITORY, non una
   * card (un parametro documentato e mai dichiarato non appartiene a nessuno):
   * li' resta vuoto e il soggetto e' `taskText`.
   */
  taskId?: string;
  /** Il soggetto del rilievo: il titolo della card, o cosa si stava guardando. */
  taskText: string;
  /** Che cosa e' successo, in una riga. */
  what: string;
  /** Il comando che lo prova. Si incolla, e si puo' non credergli. */
  proof: string;
  /** Che cosa fare. Decide l'umano: il doctor propone e basta. */
  action: string;
  /**
   * L'identita' del FATTO, non del rilievo. Due giri che vedono la stessa cosa
   * producono la stessa chiave (e il secondo tace); un fatto che cambia
   * davvero — nuovo commit, nuovo tentativo, branch che si e' mosso — ne
   * produce una nuova e torna a parlare.
   */
  occurrence: string;
  /**
   * La CAUSA condivisa, quando piu' card soffrono della stessa cosa.
   *
   * Misurato il 2026-08-10: dieci card in review avevano un branch che al land
   * avrebbe trascinato gli STESSI tredici commit, ereditati dallo stesso
   * checkout sporco. Dieci righe, dieci volte la stessa decisione da prendere.
   * Ogni riga era vera e nessuna andava tolta — ma dieci rilievi per un'azione
   * sola sono esattamente il rumore che fa disattivare un sorvegliante. Il
   * registro resta per CARD (ognuna e' una decisione a se'); e' la stampa che
   * li unisce in un blocco solo.
   */
  group?: string;
  /** Il fatto di QUESTA card in poche parole, per quando finisce in un elenco. */
  brief?: string;
}

/**
 * Una prova che scrive non e' una prova: e' un'azione mascherata da verifica, e
 * la regola 4 dice che il doctor non agisce.
 *
 * Il controllo guarda i VERBI, non il testo: cercare la parola «reset» ovunque
 * boccerebbe una prova onesta che nomina il branch `fix/reset-attempts`, e una
 * regola che boccia a caso viene disattivata al primo fastidio. Quindi il
 * comando si spezza nei suoi segmenti e di ognuno si guarda solo il primo
 * verbo (piu' il sottocomando, per `git`, e le parole chiave SQL per `sqlite3`).
 */
const SHELL_WRITERS = new Set([
  "rm", "mv", "cp", "trash", "tee", "dd", "chmod", "chown", "ln", "mkdir",
  "truncate", "install", "touch", "kill", "pkill", "launchctl", "npm", "bunx",
]);
const GIT_READ_VERBS = new Set([
  "rev-list", "rev-parse", "show", "log", "diff", "status", "for-each-ref",
  "worktree", "symbolic-ref", "cat-file", "branch", "describe", "blame", "shortlog",
  "check-ignore", "merge-base",
]);
const SQL_WRITERS = /\b(insert|update|delete|drop|alter|create|replace|attach|vacuum)\b/i;

export function isReadOnlyProof(proof: string): boolean {
  // Redirezione = scrittura. `>=` dentro una SQL non lo e': non va confuso.
  if (/(?<![<>=])>{1,2}(?!=)\s*\S/.test(proof)) return false;
  for (const rawSegment of proof.split(/&&|\|\||[;|]/)) {
    const seg = rawSegment.trim().replace(/^[$({\s]+/, "");
    if (!seg) continue;
    // Un percorso fra apici puo' contenere spazi (e parole qualsiasi): per
    // trovare i VERBI va tolto di mezzo, altrimenti `/Volumi/disco 2/repo`
    // diventa due parole e il sottocomando di git non si trova piu'. La SQL
    // invece si guarda sul testo intero: sta proprio dentro gli apici.
    const words = seg.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').split(/\s+/);
    let head = words[0] ?? "";
    if (head === "sudo" || head === "env") head = words[1] ?? "";
    if (SHELL_WRITERS.has(head)) return false;
    if (head === "git") {
      // Salta le opzioni globali (`-C <path>`, `-c k=v`) e trova il sottocomando.
      let i = words.indexOf("git") + 1;
      while (i < words.length && words[i]?.startsWith("-")) i += words[i] === "-C" || words[i] === "-c" ? 2 : 1;
      const verb = words[i] ?? "";
      if (!GIT_READ_VERBS.has(verb)) return false;
    }
    if (head === "sqlite3" && SQL_WRITERS.test(seg)) return false;
  }
  return true;
}

export function assertProofIsReadOnly(proof: string): void {
  if (!isReadOnlyProof(proof)) {
    throw new Error(`prova non di sola lettura (regola 4): ${proof}`);
  }
}

/**
 * L'unico costruttore di rilievi. Rifiuta cio' che le regole 2 e 3 vietano —
 * un rilievo senza prova o senza azione non e' pubblicabile, e il difetto esce
 * al primo test invece che davanti all'umano.
 */
export function finding(f: Finding): Finding {
  const missing = (["what", "proof", "action", "occurrence", "taskText"] as const)
    .filter((k) => !String(f[k] ?? "").trim());
  if (missing.length) {
    throw new Error(`rilievo incompleto (${f.check}): manca ${missing.join(", ")}`);
  }
  assertProofIsReadOnly(f.proof);
  return Object.freeze({ ...f });
}

// ── Il tempo, letto come lo scrive il DB ─────────────────────────────────────

/**
 * I timestamp del DB non hanno UN formato: `tasks.*` e `task_comments.*` sono
 * ISO con la `Z`, ma `topics.updated_at` e' `YYYY-MM-DD HH:MM:SS` — UTC senza
 * zona. `new Date("2026-04-07 11:01:09")` lo interpreta come LOCALE: in
 * Europe/Rome d'estate sono due ore di invecchiamento regalate, cioe' un task
 * appena toccato che sembra fermo. Qui la mancanza di zona vale UTC, sempre.
 *
 * Un timestamp che non si sa leggere torna `null` — e chi lo riceve tace,
 * perche' un'ora sbagliata e' peggio di nessun'ora.
 */
export function parseDbTimestamp(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s);
  if (!hasZone && !naive) return null;
  const iso = hasZone ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── La prova positiva di morte ───────────────────────────────────────────────

export interface LivenessProbe {
  /** Quando il sondaggio e' stato preso (ISO con zona). */
  at: string;
  /** Figli vivi in quel momento. >0 = c'e' un processo che sta lavorando. */
  liveChildren: number;
  /** Firma dell'avanzamento: se cambia fra due sondaggi, il task si e' mosso. */
  progress: string;
}

export interface DeathVerdict {
  dead: boolean;
  /** Perche' si e' deciso cosi'. Va nel rilievo: e' meta' della prova. */
  why: string;
}

/**
 * «Fermo» non e' «non l'ho visto muoversi». Serve che, per N sondaggi
 * DISTINTI, non ci sia stato nessun figlio vivo E nessun avanzamento. Un solo
 * sondaggio con un figlio vivo, o due firme di avanzamento diverse, e la
 * risposta e' no — anche se il task e' li' da ore: potrebbe essere un cambio di
 * turno, e gridare al lupo su un cambio di turno rende il doctor inutile in un
 * pomeriggio.
 */
export function isProvablyDead(
  probes: readonly LivenessProbe[],
  minProbes: number = DOCTOR.needsInput.minProbes,
): DeathVerdict {
  if (probes.length < minProbes) {
    return { dead: false, why: `solo ${probes.length} sondaggi su ${minProbes}: non basta per dire fermo` };
  }
  const window = probes.slice(-minProbes);
  const alive = window.filter((p) => p.liveChildren > 0).length;
  if (alive > 0) {
    return { dead: false, why: `${alive} sondaggi su ${minProbes} hanno visto un figlio vivo` };
  }
  const signatures = new Set(window.map((p) => p.progress));
  if (signatures.size > 1) {
    return { dead: false, why: `il task e' avanzato fra i sondaggi (${signatures.size} firme diverse)` };
  }
  const first = window[0]?.at ?? "?";
  const last = window[window.length - 1]?.at ?? "?";
  return {
    dead: true,
    why: `${minProbes} sondaggi fra ${first} e ${last}: zero figli vivi, firma di avanzamento invariata`,
  };
}

// ── I dati su cui i controlli decidono ───────────────────────────────────────

/** Una card, ridotta ai soli fatti che i controlli guardano. */
export interface DoctorTask {
  id: string;
  text: string;
  status: string;
  /** queued | starting | working | needs_input | delivered | failed | blocked | null */
  dispatchState: string | null;
  dispatchAttempts: number;
  previewImage: string | null;
  deliveryBranch: string | null;
  deliveryCommit: string | null;
  /** I file del commit di consegna. `null` = non interrogabile (commit assente). */
  deliveryFiles: readonly string[] | null;
  subtaskCount: number;
  /** L'ultimo commento dell'agente: la consegna. */
  lastAgentComment: { at: string; content: string } | null;
  /** L'ultimo commento umano, per sapere se una domanda ha avuto risposta. */
  lastHumanCommentAt: string | null;
  /** Lavoro + rilettura di cache, come li conta `board-baseline`. */
  readTotalTokens: number;
  sizeClass: SizeClass | null;
}

/** Cio' che il branch di una card porterebbe su main. Fatti di git, non stime. */
export interface BranchFacts {
  taskId: string;
  branch: string;
  defaultBranch: string;
  /** La punta del branch: se si muove, e' un'altra occorrenza. */
  headSha: string | null;
  /** Commit che `main` non ha. */
  aheadTotal: number;
  /** Di quelli, quanti sono nati dentro questo worktree (`--not <altri branch>`). */
  ownCount: number;
  /**
   * Il piu' recente dei commit ESTRANEI. E' l'impronta della causa: due card
   * che ereditano dalla stessa linea hanno lo stesso valore qui, ed e' cosi'
   * che il rapporto le mette in un blocco solo invece che in dieci.
   */
  foreignHead: string | null;
  /**
   * I commit che sono NATI in questo worktree, con lo SHA intero — la stessa
   * grafia con cui la consegna li registra (`own-commits.ts`), perche' e' con
   * quella che il controllo 8 li confronta. `null` = non elencabili, e allora
   * di chi sia la consegna non si sa: nessun allarme.
   */
  ownShas: readonly string[] | null;
  /**
   * La consegna registrata e' RAGGIUNGIBILE dalla punta di questo branch.
   *
   * Esiste perche' `ownShas` risponde a «cosa main non ha», e quella domanda
   * cambia risposta quando il lavoro ATTERRA: da quel momento `main..branch` e'
   * vuoto, il commit della card sparisce dall'insieme, e il controllo 8
   * concludeva «questa card non ha committato niente, il commit e' di
   * qualcun altro» — cioe' accusava di furto proprio le consegne andate a buon
   * fine. Un commit che sta nella storia del branch e' suo, atterrato o no.
   *
   * `null` = non c'era una consegna da verificare, o git non ha risposto.
   */
  deliveryInHistory: boolean | null;
  /** Gli altri branch (`refs/heads/…`) da cui si e' sottratto: servono alla prova. */
  otherBranches: readonly string[];
}

/** Lo stesso comando, girato in due posti. Senza il secondo non si dice niente. */
export interface RedObservation {
  taskId: string;
  command: string;
  worktreePath: string;
  worktreeExit: number;
  mainPath: string;
  /** `null` = nel checkout principale non e' stato girato: nessun confronto, nessun rilievo. */
  mainExit: number | null;
}

export interface ClassCostBaseline {
  median: number;
  n: number;
}
export type CostBaseline = Partial<Record<SizeClass, ClassCostBaseline>>;

export interface DoctorInput {
  nowMs: number;
  /** Il DB da citare nelle prove (le prove si incollano: devono puntare a un file vero). */
  dbPath: string;
  /** Il checkout da cui girano i comandi git delle prove. */
  repoPath: string;
  tasks: readonly DoctorTask[];
  branches: readonly BranchFacts[];
  reds: readonly RedObservation[];
  costBaseline: CostBaseline;
  /** I sondaggi accumulati nei giri precedenti, per task. */
  probes: Readonly<Record<string, readonly LivenessProbe[]>>;
  /** Cio' che i documenti di protocollo insegnano a passare ai tool. */
  documentedParams: readonly DocumentedParam[];
  /** I documenti di protocollo che il controllo 7 doveva leggere e non ha trovato. */
  missingProtocolDocs: readonly string[];
}

export interface DoctorCheck {
  id: CheckId;
  /** Il guasto vero da cui nasce. Un controllo senza questa riga non entra. */
  bornFrom: string;
  run(input: DoctorInput): Finding[];
}

const sq = (s: string) => s.replace(/'/g, "''");
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const short = (s: string, n = 60) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const num = (n: number) => n.toLocaleString("it-IT");

// ── 1. Consegna che rimanda a un artefatto assente ───────────────────────────

/**
 * «Vedi i thread dei sottotask» con zero sottotask. La citazione si riconosce
 * per forma — un rimando A qualcosa — e le negazioni («nessun sottotask»,
 * «senza sottotask») sono escluse esplicitamente, perche' una consegna che
 * DICHIARA di non averne e' corretta, non difettosa: e' il caso che non deve
 * far scattare niente.
 */
const SUBTASK_WORD = "(?:sotto-?task|subtask|sotto-?attivit[aà])";
const CITES_SUBTASKS = new RegExp(
  `(?:nei|nel|dei|del|sui|sul|nelle|delle|vedi|guarda|come da|thread\\s+(?:dei|del))\\s+(?:\\w+\\s+){0,2}${SUBTASK_WORD}` +
  `|${SUBTASK_WORD}\\s+(?:qui\\s+sotto|elencati|creati|sopra)`,
  "i",
);
const DENIES_SUBTASKS = new RegExp(
  `(?:nessun[oa]?|zero|senza|niente|non\\s+ci\\s+sono|non\\s+ho\\s+creato)\\s+(?:\\w+\\s+){0,2}${SUBTASK_WORD}`,
  "i",
);

export function citesSubtasks(comment: string): boolean {
  if (DENIES_SUBTASKS.test(comment)) return false;
  return CITES_SUBTASKS.test(comment);
}

const checkDeliveryCitesAbsentArtifact: DoctorCheck = {
  id: "delivery-cites-absent-artifact",
  bornFrom: "una review rimandava a «i thread dei sottotask», e di sottotask ce n'erano zero",
  run({ tasks, dbPath }) {
    const out: Finding[] = [];
    for (const t of tasks) {
      if (t.status !== "review") continue;
      const c = t.lastAgentComment;
      if (!c || !citesSubtasks(c.content)) continue;
      if (t.subtaskCount > 0) continue;
      out.push(finding({
        check: "delivery-cites-absent-artifact",
        taskId: t.id,
        taskText: t.text,
        what: `la consegna rimanda ai sottotask, ma la card ne ha ${t.subtaskCount}: il reviewer non ha dove guardare`,
        proof: `sqlite3 ${shq(dbPath)} "SELECT COUNT(*) FROM tasks WHERE parent_task_id='${sq(t.id)}'"`,
        action: "chiedi all'agente i contenuti che ha citato, dentro il thread della card, oppure rigetta la review",
        occurrence: `delivery-cites-absent-artifact:${t.id}:${c.at}`,
      }));
    }
    return out;
  },
};

// ── 2. Comportamento consegnato senza anteprima durevole ─────────────────────

export function touchesVisibleSurface(files: readonly string[]): string[] {
  return files.filter((f) => DOCTOR.visibleSurfaces.some((p) => f.startsWith(p)));
}

const checkBehaviourWithoutPreview: DoctorCheck = {
  id: "behaviour-without-preview",
  bornFrom: "due consegne di comportamento arrivate in review senza un'anteprima durevole (protocollo #4)",
  run({ tasks, repoPath }) {
    const out: Finding[] = [];
    for (const t of tasks) {
      if (t.status !== "review") continue;
      if ((t.previewImage ?? "").trim()) continue;
      // Niente commit = niente artefatto = niente da provare: una domanda o un
      // lavoro solo-headless non deve un video a nessuno.
      if (!t.deliveryCommit || !t.deliveryFiles) continue;
      const visible = touchesVisibleSurface(t.deliveryFiles);
      if (visible.length === 0) continue;
      out.push(finding({
        check: "behaviour-without-preview",
        taskId: t.id,
        taskText: t.text,
        what: `consegna che tocca ${visible.length} file di superficie visibile (${short(visible[0] ?? "", 40)}) con anteprima vuota: fra un mese non resta nessuna prova`,
        proof: `git -C ${shq(repoPath)} show --stat --format= ${t.deliveryCommit}`,
        action: "chiedi l'anteprima durevole prima di approvare — screenshot se l'esito e' statico, video (.webm) se e' un comportamento",
        occurrence: `behaviour-without-preview:${t.id}:${t.deliveryCommit}`,
      }));
    }
    return out;
  },
};

// ── 3. Land che trascinerebbe commit non della card ──────────────────────────

const checkLandDragsForeignCommits: DoctorCheck = {
  id: "land-drags-foreign-commits",
  bornFrom: "una card il cui branch portava 13 commit, sei dei quali di un'altra sessione viva (2026-08-09)",
  run({ tasks, branches, repoPath }) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out: Finding[] = [];
    for (const b of branches) {
      const t = byId.get(b.taskId);
      if (!t) continue;
      // Solo quando il land e' DAVVERO sul tavolo. Su una card ancora in corso
      // il branch si muove a ogni commit, e siccome la punta e' l'occorrenza
      // il doctor riparlerebbe a ogni giro di una cosa che nessuno sta per
      // cliccare: misurato sulla board del 2026-08-10, era 1 rilievo su 5.
      if (t.status !== "review") continue;
      const foreign = b.aheadTotal - b.ownCount;
      if (foreign <= 0) continue;
      // Gli altri branch si ricalcolano nel comando invece di essere elencati:
      // sono ventidue, e una prova lunga tre righe non la incolla nessuno. Il
      // percorso passa da una variabile per la stessa ragione: comparirebbe
      // quattro volte.
      const others = "$(git -C \"$R\" for-each-ref --format='%(refname:short)' refs/heads/ "
        + `| grep -vx -e ${b.branch} -e ${b.defaultBranch})`;
      out.push(finding({
        check: "land-drags-foreign-commits",
        taskId: t.id,
        taskText: t.text,
        what: `«Landa su main» porterebbe ${b.aheadTotal} commit ma solo ${b.ownCount} ${b.ownCount === 1 ? "e'" : "sono"} di questa card: gli altri ${foreign} vengono dal branch su cui era il checkout quando e' partita`,
        proof: `R=${shq(repoPath)}; git -C "$R" rev-list --count ${b.defaultBranch}..${b.branch}; git -C "$R" rev-list --count ${b.defaultBranch}..${b.branch} --not ${others}`,
        action: `prendi solo il lavoro della card (\`git -C "$R" log --oneline ${b.defaultBranch}..${b.branch} --not ${others}\` e poi un cherry-pick), oppure landa prima quel branch. Il cancello dell'automerge rifiuterebbe comunque: qui lo sai prima di cliccare`,
        occurrence: `land-drags-foreign-commits:${t.id}:${b.headSha ?? b.aheadTotal}`,
        group: b.foreignHead ? `stessa linea ereditata, punta ${b.foreignHead.slice(0, 8)}` : undefined,
        brief: `${b.aheadTotal} commit, ${b.ownCount} suo${b.ownCount === 1 ? "" : "i"}`,
      }));
    }
    return out;
  },
};

// ── 4. Task fermo in needs_input senza risposta ──────────────────────────────

const checkNeedsInputUnanswered: DoctorCheck = {
  id: "needs-input-unanswered",
  bornFrom: "una card ferma in needs_input da due tentativi, in silenzio, senza che nessuno se ne accorgesse",
  run({ tasks, probes, nowMs, dbPath }) {
    const out: Finding[] = [];
    for (const t of tasks) {
      if (t.dispatchState !== "needs_input") continue;
      if (t.dispatchAttempts < DOCTOR.needsInput.minAttempts) continue;
      const asked = t.lastAgentComment ? parseDbTimestamp(t.lastAgentComment.at) : null;
      // Nessuna domanda databile = nessuna eta' = nessun allarme.
      if (asked === null) continue;
      const answered = parseDbTimestamp(t.lastHumanCommentAt);
      if (answered !== null && answered >= asked) continue; // l'umano ha risposto: non e' fermo
      const ageMs = nowMs - asked;
      if (ageMs < DOCTOR.needsInput.minAgeMs) continue;
      const verdict = isProvablyDead(probes[t.id] ?? []);
      if (!verdict.dead) continue; // regola del non-allarme: senza prova di morte, silenzio
      const hours = (ageMs / 3_600_000).toFixed(1);
      out.push(finding({
        check: "needs-input-unanswered",
        taskId: t.id,
        taskText: t.text,
        what: `ferma in needs_input da ${t.dispatchAttempts} tentativi e ${hours}h senza risposta umana — ${verdict.why}`,
        proof: `sqlite3 ${shq(dbPath)} "SELECT dispatch_state, dispatch_attempts, updated_at FROM tasks WHERE id='${sq(t.id)}'" && sqlite3 ${shq(dbPath)} "SELECT author, created_at FROM task_comments WHERE task_id='${sq(t.id)}' ORDER BY created_at DESC LIMIT 3"`,
        action: "rispondi alla domanda nel thread della card (un commento umano su una card in review la fa ripartire con il contesto), oppure riportala in todo per una sessione fresca",
        occurrence: `needs-input-unanswered:${t.id}:${t.dispatchAttempts}`,
      }));
    }
    return out;
  },
};

// ── 5. Rosso ambientale spacciato per regressione ────────────────────────────

const checkEnvironmentalRed: DoctorCheck = {
  id: "environmental-red",
  bornFrom: "`test:unit` a exit 1 in un worktree senza PTY bridge, e verde sul checkout principale",
  run({ tasks, reds }) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const out: Finding[] = [];
    for (const r of reds) {
      if (r.worktreeExit === 0) continue; // niente rosso, niente da dire
      // Tutto il resto passa da qui: `null` significa che il secondo giro non
      // e' stato fatto — mezza misura non e' una prova — e un rosso anche nel
      // checkout principale e' una regressione vera, che non e' affar suo.
      if (r.mainExit !== 0) continue;
      const t = byId.get(r.taskId);
      if (!t) continue;
      out.push(finding({
        check: "environmental-red",
        taskId: t.id,
        taskText: t.text,
        what: `\`${short(r.command, 40)}\` esce ${r.worktreeExit} nel worktree e 0 nel checkout principale: e' l'ambiente, non una regressione`,
        proof: `(cd ${shq(r.worktreePath)} && ${r.command}); echo "worktree=$?"; (cd ${shq(r.mainPath)} && ${r.command}); echo "main=$?"`,
        action: "non rigettare la card per questo rosso: manca qualcosa al worktree (bridge PTY, build, dipendenza nativa). Riporta il verde del checkout principale nel thread",
        occurrence: `environmental-red:${t.id}:${r.command}`,
      }));
    }
    return out;
  },
};

// ── 6. Costo fuori scala rispetto alla classe ────────────────────────────────

const checkCostOutOfClass: DoctorCheck = {
  id: "cost-out-of-class",
  bornFrom: "card che hanno bruciato token di un ordine di grandezza sopra le pari-taglia, viste solo a posteriori",
  run({ tasks, costBaseline, dbPath }) {
    const out: Finding[] = [];
    for (const t of tasks) {
      if (!t.sizeClass) continue;
      const base = costBaseline[t.sizeClass];
      // Nessuna baseline credibile = nessun metro = nessun allarme.
      if (!base || base.n < DOCTOR.cost.minClassN || base.median <= 0) continue;
      const ratio = t.readTotalTokens / base.median;
      if (ratio < DOCTOR.cost.factor) continue;
      out.push(finding({
        check: "cost-out-of-class",
        taskId: t.id,
        taskText: t.text,
        what: `${num(Math.round(t.readTotalTokens))} token letti contro una mediana di ${num(Math.round(base.median))} per la classe ${t.sizeClass} (${ratio.toFixed(1)}×, n=${base.n})`,
        // Le due meta' della claim, separate: il numero della card e la
        // mediana della sua classe. `DATA_DIR` c'e' perche' da un worktree il
        // DB di default non esiste, e una prova che non parte non e' una prova.
        proof: `sqlite3 ${shq(dbPath)} "SELECT agent_tokens + agent_cache_read_tokens FROM tasks WHERE id='${sq(t.id)}'" && DATA_DIR=${shq(dirname(dbPath))} bun scripts/board-baseline.ts --json | jq '.board.byClass.primary.classes.${t.sizeClass}.readTotalTokens.median'`,
        action: "guarda il thread prima di rilanciarla: un costo cosi' e' quasi sempre un giro a vuoto (contesto riletto, comando ripetuto) e un rilancio lo raddoppia",
        occurrence: `cost-out-of-class:${t.id}:${Math.floor(ratio)}`,
      }));
    }
    return out;
  },
};

// ── 7. Parametro documentato che lo schema non dichiara ──────────────────────

/**
 * Un argomento che lo schema del tool non dichiara NON viene rifiutato: viene
 * buttato, e la chiamata torna 200. Chi obbedisce al documento scrive
 * «anteprima allegata» su una card vuota e sembra un bugiardo.
 *
 * Il confronto e' sui nomi ESATTI, perche' e' cosi' che MCP li combacia:
 * `previewImage` e `preview_image` sono due parametri diversi, e il primo
 * sparisce in silenzio. La normalizzazione serve solo a dire QUALE dei due
 * casi e' — nome storpiato o nome assente del tutto — perche' l'azione cambia.
 */
const normalizeParam = (s: string) => s.replace(/_/g, "").toLowerCase();

/** Un parametro che un documento insegna a passare, e cio' che il tool dichiara. */
export interface DocumentedParam {
  /** Il documento che lo insegna (percorso, per la prova). */
  doc: string;
  tool: string;
  param: string;
  /** Le proprieta' dichiarate dallo schema di quel tool. */
  declared: readonly string[];
}

const checkDocumentedParameterNotDeclared: DoctorCheck = {
  id: "documented-parameter-not-declared",
  bornFrom: "due volte in un giorno: `previewImage` e `parentTaskId` documentati, passati, scartati in silenzio con risposta 200",
  run({ documentedParams, repoPath }) {
    const out: Finding[] = [];
    for (const d of documentedParams) {
      if (d.declared.includes(d.param)) continue;
      // Schema vuoto = non letto: non e' una prova che il parametro manchi.
      if (d.declared.length === 0) continue;
      const near = d.declared.find((p) => normalizeParam(p) === normalizeParam(d.param));
      out.push(finding({
        check: "documented-parameter-not-declared",
        taskText: `${d.tool}(${d.param}=…)`,
        what: near
          ? `il protocollo insegna \`${d.param}\`, lo schema dichiara \`${near}\`: MCP combacia i nomi esatti, quindi l'argomento viene buttato e la chiamata torna 200`
          : `il protocollo insegna \`${d.param}\`, che lo schema di \`${d.tool}\` non dichiara affatto: l'argomento viene buttato e la chiamata torna 200`,
        proof: `grep -n ${shq(d.param)} ${shq(join(repoPath, d.doc))} && grep -n ${shq(near ?? d.param)} ${shq(join(repoPath, MCP_SERVER))}`,
        action: near
          ? `allinea le due grafie — o il documento a \`${near}\`, o lo schema a \`${d.param}\`. Finche' divergono, chi obbedisce al documento scrive «fatto» su una card che non e' cambiata`
          : `aggiungi \`${d.param}\` allo schema di \`${d.tool}\` (e leggilo nell'handler), oppure toglilo dal documento`,
        occurrence: `documented-parameter-not-declared:${d.tool}:${d.param}`,
        group: `${d.doc} contro lo schema dei tool`,
        brief: near ? `lo schema dice \`${near}\`` : "non dichiarato",
      }));
    }
    return out;
  },
};

// ── 8. Consegna che punta a un commit non suo ────────────────────────────────

const checkDeliveryCommitNotOwn: DoctorCheck = {
  id: "delivery-commit-not-own",
  bornFrom: "una card con `deliveryCommit` che puntava a un commit di un'altra sessione, mentre lei non aveva committato niente",
  run({ tasks, branches, repoPath }) {
    const byTask = new Map(branches.map((b) => [b.taskId, b]));
    const out: Finding[] = [];
    for (const t of tasks) {
      if (!t.deliveryCommit) continue;
      const b = byTask.get(t.id);
      // Senza i commit del branch non si sa di chi sia: nessuna prova, silenzio.
      if (!b || b.ownShas === null) continue;
      const sha = t.deliveryCommit;
      const isOwn = b.ownShas.some((own) => sha.startsWith(own) || own.startsWith(sha));
      if (isOwn) continue;
      // Il lavoro ATTERRATO esce da `ownShas` — `main..branch` si svuota — e
      // senza questa riga il controllo accusava di furto le consegne riuscite.
      // Un commit nella storia del branch e' suo: che main ce l'abbia gia' e'
      // il successo, non la prova del contrario.
      if (b.deliveryInHistory === true) continue;
      out.push(finding({
        check: "delivery-commit-not-own",
        taskId: t.id,
        taskText: t.text,
        what: b.ownCount === 0
          ? `la consegna e' registrata su ${sha.slice(0, 8)}, ma questa card non ha committato niente: il commit e' di qualcun altro`
          : `la consegna e' registrata su ${sha.slice(0, 8)}, che non e' fra i ${b.ownCount} commit di questa card`,
        // SHA interi, come quelli che il doctor ha confrontato: cosi' la
        // consegna o compare in quell'elenco o non c'e', senza far combaciare
        // prefissi a occhio.
        proof: `R=${shq(repoPath)}; git -C "$R" rev-list ${b.defaultBranch}..${b.branch} --not $(git -C "$R" for-each-ref --format='%(refname:short)' refs/heads/ | grep -vx -e ${b.branch} -e ${b.defaultBranch}); git -C "$R" show --oneline -s ${sha}`,
        action: "non fidarti del diff mostrato in review: sta guardando il lavoro di un'altra sessione. Chiedi alla card quale commit e' suo, o rigettala",
        occurrence: `delivery-commit-not-own:${t.id}:${sha}`,
      }));
    }
    return out;
  },
};

// ── 9. Il documento che il controllo 7 legge non c'e' ────────────────────────

/**
 * Il controllo 7 legge un documento: se quel documento non c'e', non trova
 * niente e la board sembra sana. E' esattamente cio' che e' successo — per
 * tutto il tempo in cui `docs/board-protocol.md` e' stato in `.gitignore` il
 * controllo e' girato su zero chiamate documentate, verde, in ogni worktree
 * appena creato. Un controllo cieco che tace non si distingue da un controllo
 * che passa, e infatti nessuno se n'e' accorto.
 *
 * Quindi il documento assente non e' un'ignoranza da dichiarare in `skipped`
 * (quella e' per il dato che PUO' mancare: una baseline non passata, un rosso
 * mai misurato). Qui il file e' atteso, versionato, e la sua assenza e' un
 * guasto — la stessa convenzione che `docs/board-vs-chat/cases.json` ha gia'
 * («lo script esce ROSSO se non la trova», dice il `.gitignore`).
 */
const checkProtocolDocMissing: DoctorCheck = {
  id: "protocol-doc-missing",
  bornFrom: "`docs/board-protocol.md` in `.gitignore`: il controllo 7 e' rimasto inerte per settimane, verde, senza che nessuno se ne accorgesse",
  run({ missingProtocolDocs, repoPath }) {
    const out: Finding[] = [];
    for (const doc of missingProtocolDocs) {
      out.push(finding({
        check: "protocol-doc-missing",
        taskText: doc,
        what: `${doc} non esiste in questo checkout: il controllo sui parametri documentati gira su zero chiamate e resta verde per ignoranza`,
        proof: `ls -l ${shq(join(repoPath, doc))}; git -C ${shq(repoPath)} log --oneline -1 -- ${shq(doc)}; git -C ${shq(repoPath)} check-ignore -v ${shq(doc)}`,
        action: `ripristina il documento (\`git checkout -- ${doc}\`) o, se e' stato spostato, aggiorna PROTOCOL_DOCS. Finche' manca, il controllo 7 non controlla niente`,
        occurrence: `protocol-doc-missing:${doc}`,
      }));
    }
    return out;
  },
};

export const CHECKS: readonly DoctorCheck[] = Object.freeze([
  checkDeliveryCitesAbsentArtifact,
  checkBehaviourWithoutPreview,
  checkLandDragsForeignCommits,
  checkNeedsInputUnanswered,
  checkEnvironmentalRed,
  checkCostOutOfClass,
  checkDocumentedParameterNotDeclared,
  checkDeliveryCommitNotOwn,
  checkProtocolDocMissing,
]);

/**
 * Tutti i controlli, in ordine dichiarato. Su una board sana torna `[]` — e
 * quello e' l'unico modo che il doctor ha di dire «va bene».
 */
export function runChecks(input: DoctorInput, only?: ReadonlySet<CheckId>): Finding[] {
  const out: Finding[] = [];
  for (const c of CHECKS) {
    if (only && !only.has(c.id)) continue;
    out.push(...c.run(input));
  }
  return out;
}

// ── Il registro: lo stesso fatto si dice una volta sola ──────────────────────

export interface DoctorState {
  /** occorrenza → quando e' stata detta. */
  said: Record<string, string>;
  /** taskId → sondaggi di vitalita' accumulati fra un giro e l'altro. */
  probes: Record<string, LivenessProbe[]>;
}

export const EMPTY_STATE: DoctorState = { said: {}, probes: {} };

export function filterUnsaid(
  findings: readonly Finding[],
  said: Readonly<Record<string, string>>,
): { fresh: Finding[]; suppressed: Finding[] } {
  const fresh: Finding[] = [];
  const suppressed: Finding[] = [];
  for (const f of findings) (said[f.occurrence] ? suppressed : fresh).push(f);
  return { fresh, suppressed };
}

/** Aggiunge un sondaggio e tiene solo la coda che serve a decidere. */
export function pushProbe(
  probes: readonly LivenessProbe[],
  probe: LivenessProbe,
  keep: number = DOCTOR.needsInput.minProbes,
): LivenessProbe[] {
  return [...probes, probe].slice(-keep);
}

function statePath(): string {
  return process.env.DOCTOR_STATE
    ?? join(process.env.HOME ?? ".", ".topics", "board-doctor-state.json");
}

export function loadState(path = statePath()): DoctorState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DoctorState>;
    return { said: raw.said ?? {}, probes: raw.probes ?? {} };
  } catch {
    return { said: {}, probes: {} };
  }
}

export function saveState(state: DoctorState, path = statePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

// ── Lettura del mondo: DB in sola lettura, git in sola lettura ───────────────

/** Dove stanno le due verita' del controllo 7. Percorsi relativi alla repo. */
export const MCP_SERVER = "server/mcp/topics-mcp-server.ts";
export const PROTOCOL_DOCS = ["docs/board-protocol.md"] as const;

/**
 * Quali documenti di protocollo mancano da questo checkout. Sta qui, fuori da
 * `collect`, perche' e' l'unico pezzo del controllo 9 che tocca il disco: cosi'
 * si prova su una cartella vera senza mettere in piedi un DB.
 */
export function missingProtocolDocs(repoPath: string, docs: readonly string[] = PROTOCOL_DOCS): string[] {
  return docs.filter((doc) => !existsSync(join(repoPath, doc)));
}

/**
 * Le chiavi di PRIMO livello di un oggetto letterale, contando le graffe.
 *
 * Una regex sul blocco intero sembrava bastare e non bastava: sconfinava nel
 * tool successivo e attribuiva a `list_processes` (che di proprieta' non ne ha)
 * i parametri di `read_process_output`. Erano tre falsi allarmi su quattro, il
 * difetto esatto che questo file esiste per non avere.
 */
export function topLevelKeys(src: string, openIdx: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === "]") { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    const m = src.slice(i, i + 80).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (m?.[1] && /[{,\s]/.test(src[i - 1] ?? "")) { keys.push(m[1]); i += m[1].length; }
  }
  return keys;
}

/** tool → proprieta' dichiarate dal suo `inputSchema`. */
export function declaredToolParams(mcpSource: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const marks = [...mcpSource.matchAll(/\n\s*name:\s*"([a-z_0-9]+)",/g)];
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (!m?.[1]) continue;
    const slice = mcpSource.slice(m.index ?? 0, marks[k + 1]?.index ?? mcpSource.length);
    const pi = slice.indexOf("properties:");
    const open = pi < 0 ? -1 : slice.indexOf("{", pi);
    out.set(m[1], open < 0 ? [] : topLevelKeys(slice, open));
  }
  return out;
}

/** Le chiamate che un documento insegna: `update_task(previewImage=…)`. */
export function documentedCalls(doc: string, tools: ReadonlySet<string>): Array<{ tool: string; param: string }> {
  const out: Array<{ tool: string; param: string }> = [];
  const seen = new Set<string>();
  for (const m of doc.matchAll(/\b([a-z_0-9]+)\(([^)]*)\)/g)) {
    const tool = m[1] ?? "";
    if (!tools.has(tool)) continue;
    for (const p of (m[2] ?? "").matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/g)) {
      const param = p[1] ?? "";
      const key = `${tool}:${param}`;
      if (param && !seen.has(key)) { seen.add(key); out.push({ tool, param }); }
    }
  }
  return out;
}

export function defaultDbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

/** Git, e SOLO in lettura: il doctor non tocca l'albero di nessuno (regola 4). */
function git(cwd: string, args: string[]): { code: number; out: string } {
  const verb = args[0] ?? "";
  if (!GIT_READ_VERBS.has(verb)) throw new Error(`git '${verb}' non e' di sola lettura`);
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, out: typeof res.stdout === "string" ? res.stdout : "" };
}

/**
 * Il `git` del doctor nella forma che vuole `own-commits.ts`. E' un runner
 * asincrono su una `spawnSync`: non serve a parallelizzare niente, serve a far
 * girare il doctor sulla STESSA sottrazione del land invece che su una copia.
 * Il cancello di sola-lettura resta quello di sopra — l'helper non decide cosa
 * il doctor puo' eseguire.
 */
const doctorGitRunner: GitRunner = async (cwd, args) => {
  const r = git(cwd, args);
  return { code: r.code, stdout: r.out };
};

/**
 * Cosa porterebbe il branch di una card, e quanto di quello e' suo. La domanda
 * NON si ricalcola qui: la fa `own-commits.ts`, la stessa che risponde al
 * cancello del land e alla fotografia della consegna. Due copie divergono, e
 * siccome il controllo 8 confronta questi SHA con quello registrato dalla
 * consegna, la deriva fra le copie sarebbe un falso allarme prodotto dal
 * controllo che esiste per non darne.
 *
 * `null` = non confrontabile (branch potato, git muto): chi chiama lo dice fra
 * le cose che non ha potuto guardare, e nessun controllo parla di questa card.
 */
export async function branchFacts(
  repoPath: string,
  taskId: string,
  branch: string,
  defaultBranch: string,
  runGit: GitRunner = doctorGitRunner,
  deliveryCommit: string | null = null,
): Promise<BranchFacts | null> {
  // Le liste, non i conteggi: dalla differenza esce anche QUALE commit
  // estraneo e' il piu' recente, cioe' l'impronta della causa condivisa.
  const split = await splitAheadCommits(repoPath, branch, { mainRef: defaultBranch, runGit });
  if (split === null) return null;
  const mine = new Set(split.own);
  const head = await runGit(repoPath, ["rev-parse", "--short", refShort(branch)]);
  // La domanda si fa a git una volta sola, qui, perche' i controlli lavorano
  // su fatti gia' raccolti e non possono chiamarlo.
  let deliveryInHistory: boolean | null = null;
  if (deliveryCommit) {
    const r = await runGit(repoPath, ["merge-base", "--is-ancestor", deliveryCommit, refShort(branch)]);
    // Solo 0 e 1 sono risposte: 128 e' «commit sconosciuto», e allora non si sa.
    deliveryInHistory = r.code === 0 ? true : r.code === 1 ? false : null;
  }
  return {
    taskId,
    branch,
    defaultBranch,
    headSha: head.code === 0 ? head.stdout.trim() : null,
    aheadTotal: split.ahead.length,
    ownCount: mine.size,
    foreignHead: split.ahead.find((sha) => !mine.has(sha)) ?? null,
    ownShas: split.own,
    deliveryInHistory,
    otherBranches: split.others,
  };
}

/** Il nome nudo di un ref, per i posti che lo mostrano a un umano o lo passano a una shell. */
function refShort(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function classify(value: number | null, smallMax: number, mediumMax: number): SizeClass | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= smallMax) return "small";
  if (value <= mediumMax) return "medium";
  return "large";
}

interface RawTaskRow {
  id: string;
  text: string;
  status: string;
  dispatch_state: string | null;
  dispatch_attempts: number;
  preview_image: string | null;
  delivery_branch: string | null;
  delivery_commit: string | null;
  agent_tokens: number;
  agent_cache_read_tokens: number;
  agent_ms: number;
  updated_at: string;
  assigned_topic_id: string | null;
  session_key: string | null;
  topic_updated_at: string | null;
  phase: string | null;
  phase_updated_at: string | null;
}

export interface CollectOptions {
  dbPath?: string;
  repoPath?: string;
  projectId?: string;
  /** Solo le card toccate in questo giorno UTC (`YYYY-MM-DD`) — serve alla misura del rumore. */
  day?: string;
  nowMs?: number;
  costBaseline?: CostBaseline;
  reds?: readonly RedObservation[];
  probes?: Readonly<Record<string, LivenessProbe[]>>;
  /** I documenti di protocollo da confrontare con lo schema dei tool. */
  protocolDocs?: readonly string[];
}

export interface Collected {
  input: DoctorInput;
  /** Il sondaggio di vitalita' preso ADESSO, per task: va scritto nello stato. */
  probeNow: Record<string, LivenessProbe>;
  /** Cosa non si e' potuto guardare, e perche'. Il silenzio non e' assoluzione. */
  skipped: string[];
}

export async function collect(opts: CollectOptions = {}): Promise<Collected> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const repoPath = opts.repoPath ?? join(import.meta.dir, "..");
  const projectId = opts.projectId ?? DEFAULT_PROJECT_ID;
  const nowMs = opts.nowMs ?? Date.now();
  const skipped: string[] = [];
  if (!existsSync(dbPath)) throw new Error(`nessun DB in ${dbPath}. Passa DATA_DIR=… se il tuo sta altrove.`);
  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.prepare(
      `SELECT t.id, t.text, t.status, t.dispatch_state, t.dispatch_attempts, t.preview_image,
              t.delivery_branch, t.delivery_commit, t.agent_tokens, t.agent_cache_read_tokens,
              t.agent_ms, t.updated_at, t.assigned_topic_id,
              tp.session_key AS session_key, tp.updated_at AS topic_updated_at,
              cs.phase AS phase, cs.phase_updated_at AS phase_updated_at
         FROM tasks t
         LEFT JOIN topics tp ON tp.id = t.assigned_topic_id
         LEFT JOIN claude_code_sessions cs ON cs.session_key = tp.session_key
        WHERE t.project_id = ? AND t.archived = 0 AND t.parent_task_id IS NULL
          AND t.status IN ('todo','in_progress','review')`,
    ).all(projectId) as unknown as RawTaskRow[];

    const scoped = opts.day
      ? rows.filter((r) => (r.updated_at ?? "").slice(0, 10) === opts.day)
      : rows;

    const subCounts = new Map<string, number>();
    for (const r of db.prepare(
      "SELECT parent_task_id AS p, COUNT(*) AS n FROM tasks WHERE parent_task_id IS NOT NULL AND archived = 0 GROUP BY 1",
    ).all() as unknown as Array<{ p: string; n: number }>) subCounts.set(r.p, r.n);

    const lastAgent = db.prepare(
      `SELECT content, created_at FROM task_comments
        WHERE task_id = ? AND author NOT IN ('user','system') AND COALESCE(kind,'comment') <> 'status'
        ORDER BY created_at DESC LIMIT 1`,
    );
    const lastHuman = db.prepare(
      "SELECT created_at FROM task_comments WHERE task_id = ? AND author = 'user' ORDER BY created_at DESC LIMIT 1",
    );
    const msgCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?");

    const tasks: DoctorTask[] = [];
    const branches: BranchFacts[] = [];
    const probeNow: Record<string, LivenessProbe> = {};
    const nowIso = new Date(nowMs).toISOString();

    const defaultBranch = git(repoPath, ["rev-parse", "--verify", "--quiet", "main"]).code === 0 ? "main" : "master";

    for (const r of scoped) {
      const agent = lastAgent.get(r.id) as { content: string; created_at: string } | null;
      const human = lastHuman.get(r.id) as { created_at: string } | null;

      let deliveryFiles: string[] | null = null;
      if (r.delivery_commit) {
        const show = git(repoPath, ["show", "--numstat", "--format=", r.delivery_commit]);
        if (show.code === 0) {
          deliveryFiles = show.out.split("\n")
            .map((l) => l.split("\t")[2] ?? "")
            .filter(Boolean);
        } else {
          skipped.push(`${r.id.slice(0, 8)}: commit di consegna ${r.delivery_commit.slice(0, 8)} non leggibile — controllo anteprima saltato`);
        }
      }

      const files = deliveryFiles?.length ?? null;
      const sizeClass = classify(files, THRESHOLDS.files.smallMax, THRESHOLDS.files.mediumMax)
        ?? classify(r.agent_ms || null, THRESHOLDS.durationMs.smallMax, THRESHOLDS.durationMs.mediumMax);

      tasks.push({
        id: r.id,
        text: r.text,
        status: r.status,
        dispatchState: r.dispatch_state,
        dispatchAttempts: r.dispatch_attempts ?? 0,
        previewImage: r.preview_image,
        deliveryBranch: r.delivery_branch,
        deliveryCommit: r.delivery_commit,
        deliveryFiles,
        subtaskCount: subCounts.get(r.id) ?? 0,
        lastAgentComment: agent ? { at: agent.created_at, content: agent.content } : null,
        lastHumanCommentAt: human?.created_at ?? null,
        readTotalTokens: (r.agent_tokens ?? 0) + (r.agent_cache_read_tokens ?? 0),
        sizeClass,
      });

      // Vitalita': una fase di lavoro conta solo se il battito e' recente —
      // una `running` di ieri e' una fase appesa, non un figlio vivo.
      const beat = parseDbTimestamp(r.phase_updated_at);
      const working = r.phase !== null && DOCTOR.liveness.workingPhases.has(r.phase);
      const liveChildren = working && beat !== null && nowMs - beat <= DOCTOR.liveness.heartbeatMs ? 1 : 0;
      const msgs = r.session_key ? (msgCount.get(r.session_key) as { n: number } | null)?.n ?? 0 : 0;
      // `topic_updated_at` e' UTC senza zona: si legge SOLO con parseDbTimestamp.
      const topicMs = parseDbTimestamp(r.topic_updated_at);
      probeNow[r.id] = {
        at: nowIso,
        liveChildren,
        progress: `${r.updated_at}|${topicMs ?? "?"}|${msgs}|${r.dispatch_attempts ?? 0}`,
      };

      if (r.delivery_branch) {
        const facts = await branchFacts(repoPath, r.id, r.delivery_branch, defaultBranch, undefined, r.delivery_commit);
        if (facts === null) {
          skipped.push(`${r.id.slice(0, 8)}: branch ${r.delivery_branch} non confrontabile con ${defaultBranch} — controllo land saltato`);
          continue;
        }
        branches.push(facts);
      }
    }

    // ── Controllo 7: il protocollo contro lo schema dei tool ────────────────
    // Il documento assente NON finisce in `skipped`: e' il controllo 9, cioe'
    // un rilievo. Un file versionato che non c'e' e' un guasto, e il silenzio
    // su di lui e' proprio il modo in cui il controllo 7 e' rimasto inerte.
    // La sua presenza si guarda a parte dallo schema: se domani il server MCP
    // cambiasse posto, il documento sparito tornerebbe a passare inosservato.
    const documentedParams: DocumentedParam[] = [];
    const docs = opts.protocolDocs ?? PROTOCOL_DOCS;
    const missingDocs = missingProtocolDocs(repoPath, docs);

    const mcpPath = join(repoPath, MCP_SERVER);
    if (existsSync(mcpPath)) {
      const declared = declaredToolParams(readFileSync(mcpPath, "utf8"));
      const tools = new Set(declared.keys());
      for (const doc of docs) {
        const p = join(repoPath, doc);
        if (!existsSync(p)) continue;   // gia' detto dal controllo 9, e a voce alta
        for (const call of documentedCalls(readFileSync(p, "utf8"), tools)) {
          documentedParams.push({ doc, tool: call.tool, param: call.param, declared: declared.get(call.tool) ?? [] });
        }
      }
    } else {
      skipped.push(`${MCP_SERVER} non trovato — controllo sui parametri documentati saltato`);
    }

    const costBaseline = opts.costBaseline ?? {};
    if (!opts.costBaseline) {
      skipped.push("costo fuori scala: nessuna baseline passata (--baseline FILE) — controllo inerte");
    }
    if (!opts.reds?.length) {
      skipped.push("rosso ambientale: nessuna coppia di esiti misurata (--probe-red) — controllo inerte");
    }

    return {
      input: {
        nowMs, dbPath, repoPath, tasks, branches,
        reds: opts.reds ?? [],
        costBaseline,
        probes: opts.probes ?? {},
        documentedParams,
        missingProtocolDocs: missingDocs,
      },
      probeNow,
      skipped,
    };
  } finally {
    db.close();
  }
}

/**
 * Il quinto controllo ha bisogno di girare lo stesso comando in due posti: qui,
 * e nel checkout principale. Nessuna euristica puo' sostituire questo — e'
 * l'unica prova che distingue un ambiente rotto da una regressione.
 */
export function probeRed(taskId: string, command: string, worktreePath: string, mainPath: string): RedObservation {
  const run = (cwd: string) => spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8" }).status ?? 1;
  const worktreeExit = run(worktreePath);
  // Il secondo giro si paga solo se il primo e' rosso: un verde non ha niente da spiegare.
  const mainExit = worktreeExit === 0 ? null : run(mainPath);
  return { taskId, command, worktreePath, worktreeExit, mainPath, mainExit };
}

/** Il checkout principale: quello che possiede il `.git` condiviso. */
export function mainCheckout(repoPath: string): string | null {
  const common = git(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) return null;
  const dir = common.out.trim();
  return dir.endsWith("/.git") ? dir.slice(0, -"/.git".length) : null;
}

// ── Baseline dei costi, da file ──────────────────────────────────────────────

/**
 * La mediana per classe la produce gia' `board-baseline.ts`. Qui si legge il
 * suo JSON invece di ricalcolarlo: rifare il conto in due posti e' il modo
 * sicuro per farli divergere.
 */
export function costBaselineFromJson(raw: unknown): CostBaseline {
  const classes = (raw as { board?: { byClass?: { primary?: { classes?: Record<string, unknown> } } } })
    ?.board?.byClass?.primary?.classes;
  if (!classes) return {};
  const out: CostBaseline = {};
  for (const cls of ["small", "medium", "large"] as const) {
    const c = classes[cls] as { n?: number; readTotalTokens?: { median?: number } } | undefined;
    const median = c?.readTotalTokens?.median;
    if (typeof median === "number" && typeof c?.n === "number") out[cls] = { median, n: c.n };
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const card = (f: Finding) =>
  `${short(f.taskText, 62)}${f.taskId ? ` \x1b[2m(${f.taskId.slice(0, 8)})\x1b[0m` : ""}`;

/**
 * Rilievi con la stessa causa, un blocco solo. Il primo porta la prova e
 * l'azione — che per costruzione sono la stessa decisione — e gli altri
 * restano come elenco delle card colpite. Nel JSON ci sono tutti, uno per card:
 * qui si comprime cio' che l'umano LEGGE, non cio' che il doctor sa.
 */
export function groupForRender(findings: readonly Finding[]): Finding[][] {
  const blocks: Finding[][] = [];
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.group) { blocks.push([f]); continue; }
    const key = `${f.check}\u0000${f.group}`;
    const hit = byKey.get(key);
    if (hit) { hit.push(f); continue; }
    const fresh = [f];
    byKey.set(key, fresh);
    blocks.push(fresh);
  }
  return blocks;
}

function renderBlock(block: readonly Finding[]): string {
  const first = block[0];
  if (!first) return "";
  if (block.length === 1) {
    return [
      `\x1b[1m${first.check}\x1b[0m — ${card(first)}`,
      `  ${first.what}`,
      `  \x1b[2mprova:\x1b[0m  ${first.proof}`,
      `  \x1b[2mazione:\x1b[0m ${first.action}`,
    ].join("\n");
  }
  // In un blocco il `what` della prima card mentirebbe sulle altre (i numeri
  // sono i suoi): al suo posto va il fatto di ognuna, in poche parole.
  return [
    `\x1b[1m${first.check}\x1b[0m — \x1b[1m${block.length} card\x1b[0m, \x1b[2m${first.group}\x1b[0m`,
    ...block.map((f) => `  · ${card(f)}${f.brief ? ` \x1b[2m— ${f.brief}\x1b[0m` : ""}`),
    `  \x1b[2mprova\x1b[0m (sulla prima)\x1b[2m:\x1b[0m ${first.proof}`,
    `  \x1b[2mazione\x1b[0m (per ognuna)\x1b[2m:\x1b[0m ${first.action}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (n: string) => argv.includes(`--${n}`);
  const opt = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const repoPath = opt("repo") ?? join(import.meta.dir, "..");
  const dbPath = opt("db") ?? defaultDbPath();
  const stateFile = opt("state") ?? statePath();
  const state = has("no-state") ? { ...EMPTY_STATE } : loadState(stateFile);

  let costBaseline: CostBaseline | undefined;
  const baselineFile = opt("baseline");
  if (baselineFile) costBaseline = costBaselineFromJson(JSON.parse(readFileSync(baselineFile, "utf8")));

  const reds: RedObservation[] = [];
  const redCommand = opt("probe-red");
  if (redCommand) {
    const taskId = opt("task");
    const worktree = opt("worktree") ?? process.cwd();
    const mainPath = opt("main") ?? mainCheckout(repoPath);
    if (!taskId || !mainPath) {
      console.error("--probe-red richiede --task <id> e un checkout principale risolvibile (--main)");
      process.exit(2);
    }
    reds.push(probeRed(taskId, redCommand, worktree, mainPath));
  }

  /** Un giro: guarda, dice cio' che e' nuovo, aggiorna la catena dei sondaggi. */
  async function round(prev: DoctorState, remember: boolean): Promise<{ state: DoctorState; fresh: Finding[] }> {
    const { input, probeNow, skipped } = await collect({
      dbPath, repoPath, projectId: opt("project"), day: opt("day"),
      costBaseline, reds, probes: prev.probes,
    });

    // Il sondaggio di ADESSO entra nella catena: e' il giro DOPO che potra'
    // dire se un task e' fermo. Il doctor non dorme mai aspettando la seconda
    // misura — se la prende al giro successivo.
    const probes: Record<string, LivenessProbe[]> = { ...prev.probes };
    for (const [id, p] of Object.entries(probeNow)) probes[id] = pushProbe(probes[id] ?? [], p);

    const all = runChecks(input);
    const { fresh, suppressed } = has("all")
      ? { fresh: all, suppressed: [] as Finding[] }
      : filterUnsaid(all, prev.said);

    if (has("json")) {
      console.log(JSON.stringify({
        generatedAt: new Date(input.nowMs).toISOString(),
        dbPath, repoPath, day: opt("day") ?? null,
        tasksLooked: input.tasks.length,
        findings: fresh,
        suppressed: suppressed.map((f) => f.occurrence),
        skipped,
        noiseCeiling: DOCTOR.noiseCeiling,
      }, null, 2));
    } else if (fresh.length) {
      // Regola 1: su una board sana questo blocco non stampa niente.
      console.log(groupForRender(fresh).map(renderBlock).join("\n\n"));
      if (suppressed.length) console.log(`\n\x1b[2m(${suppressed.length} gia' detti, taciuti)\x1b[0m`);
    }

    const said = { ...prev.said };
    if (remember) for (const f of fresh) said[f.occurrence] = new Date(input.nowMs).toISOString();
    return { state: { said, probes }, fresh };
  }

  const persist = !has("no-state");
  if (has("watch")) {
    // In `--watch` il registro si scrive SEMPRE: un sorvegliante che ripete a
    // ogni giro quello che ha gia' detto e' la definizione di rumore.
    const intervalS = Math.max(30, Number(opt("interval") ?? "120") || 120);
    let cur = state;
    for (;;) {
      try {
        cur = (await round(cur, true)).state;
        if (persist) saveState(cur, stateFile);
      } catch (e) {
        console.error(`[doctor] giro fallito: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((r) => setTimeout(r, intervalS * 1000));
    }
  }

  const { state: next, fresh } = await round(state, has("remember"));
  if (persist) saveState(next, stateFile);
  if (has("gate") && fresh.length) process.exit(1);
}

if (import.meta.main) await main();
