export type { LinkKind, LinkProposal } from "../../shared/board";
import type { LinkKind, LinkProposal } from "../../shared/board";
import type { TaskStatus } from "../../shared/board";

/**
 * Intake linker — "dove va questo testo?".
 *
 * Il composer nasce ORFANO: qualunque cosa scrivi diventa una card nuova, e
 * nessuno guarda la board per chiedersi se quel testo è un pezzo di un lavoro
 * già aperto o il seguito di uno che sta ancora girando. Qui c'è il motore che
 * quella domanda se la pone — e SOLO se la pone: restituisce una PROPOSTA, mai
 * un'attribuzione. Chi decide è l'umano, con un click, prima che il task esista
 * (il link viaggia nella create, così non c'è nessuna finestra in cui una card
 * è collegata senza che nessuno l'abbia voluto).
 *
 * È deterministico e lessicale di proposito: nessuna chiamata a un modello. Un
 * intake che sbaglia è peggio di nessun intake, e un punteggio che si può
 * leggere ("queste parole in comune, questo peso") è un punteggio che si può
 * contestare in un test — e mostrare all'umano come motivo del collegamento.
 */

/** Il minimo che serve per giudicare una card come destinazione. */
export interface IntakeCandidate {
  id: string;
  text: string;
  description: string | null;
  status: TaskStatus;
  /** ISO — a parità di punteggio vince la card toccata più di recente. */
  updatedAt: string;
}



export interface ProposeLinkInput {
  text: string;
  description?: string | null;
  candidates: IntakeCandidate[];
  /** Escludi una card (es. quella che stai già modificando). */
  excludeTaskId?: string | null;
}

/**
 * Parole che compaiono in metà delle card di qualunque board: pesano zero, e
 * lasciarle dentro vuol dire proporre un collegamento perché due task parlano
 * entrambi di "fare" e "problema". Italiano + inglese, perché i task sono misti.
 */
const STOPWORDS = new Set<string>([
  // it
  "che", "con", "come", "cosa", "della", "dello", "delle", "degli", "dei", "dal", "dalla",
  "per", "più", "piu", "non", "nel", "nella", "nelle", "negli", "sul", "sulla", "sulle",
  "una", "uno", "gli", "questo", "questa", "queste", "questi", "quello", "quella",
  "sono", "essere", "fare", "fatto", "fatta", "deve", "devono", "serve", "solo", "anche",
  "senza", "dopo", "prima", "quando", "dove", "perche", "perché", "ma", "poi", "già", "gia",
  "task", "card", "board", "problema", "problemi", "cose", "roba", "adesso", "ora",
  "aggiungi", "aggiungere", "sistema", "sistemare", "fix", "fixare", "vedi", "vedere",
  // en
  "the", "and", "for", "with", "that", "this", "these", "those", "from", "into", "when",
  "where", "what", "which", "should", "would", "could", "will", "have", "has", "had",
  "are", "was", "were", "been", "being", "not", "but", "also", "your", "you", "its",
  "add", "make", "fixes", "issue", "issues", "thing", "things", "just", "some", "more",
]);

const MIN_TERM_LEN = 3;

/** minuscole, accenti via, tutto ciò che non è lettera/cifra diventa confine. */
export function tokenize(raw: string): string[] {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TERM_LEN && !STOPWORDS.has(t));
}

/**
 * Soglia sotto la quale non si propone NIENTE. Tarata perché "task nuovo" sia
 * il default silenzioso: la proposta deve costare all'umano solo quando c'è
 * davvero qualcosa da collegare, altrimenti diventa rumore che si impara a
 * ignorare — e un intake ignorato è un intake che poi sbaglia senza che nessuno
 * guardi.
 */
export const PROPOSAL_THRESHOLD = 0.34;
/** Una sola parola in comune non è un tema, è una coincidenza. */
const MIN_SHARED_TERMS = 2;

/** Le card già chiuse non sono destinazioni: il lavoro lì non è "in corso". */
const OPEN_STATUSES = new Set<TaskStatus>(["backlog", "todo", "in_progress", "review"]);
/** Sta ancora girando → il testo nuovo è un seguito, non un pezzo. */
const RUNNING_STATUSES = new Set<TaskStatus>(["in_progress", "review"]);

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "in backlog",
  todo: "in coda",
  in_progress: "in corso",
  review: "in review",
  done: "chiusa",
};

/**
 * Peso di un termine = quanto è raro sulla board. Un termine che sta in TUTTE
 * le card non distingue niente e pesa ~0; uno che sta in una sola card pesa
 * tanto. È l'IDF classico, con lo smoothing che tiene i pesi positivi anche
 * quando i candidati sono pochissimi (una board con due card è il caso normale
 * al primo giorno, non un caso limite).
 */
function idfMap(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + n / c));
  return idf;
}

/** Un termine mai visto sulla board è il più raro che ci sia. */
function weightOf(idf: Map<string, number>, term: string, docCount: number): number {
  return idf.get(term) ?? Math.log(1 + docCount + 1);
}

/**
 * La proposta migliore, o `null` = task nuovo.
 *
 * `null` non è un fallimento: è la risposta giusta nella grande maggioranza dei
 * casi, ed è il motivo per cui questo motore può stare acceso di default.
 */
export function proposeLink(input: ProposeLinkInput): LinkProposal | null {
  const queryTerms = tokenize(`${input.text}\n${input.description ?? ""}`);
  if (queryTerms.length === 0) return null;

  const candidates = input.candidates.filter(
    (c) => c.id !== input.excludeTaskId && OPEN_STATUSES.has(c.status),
  );
  if (candidates.length === 0) return null;

  const docs = candidates.map((c) => tokenize(`${c.text}\n${c.description ?? ""}`));
  const idf = idfMap(docs);
  const docCount = docs.length;

  const queryUnique = [...new Set(queryTerms)];
  const queryMass = queryUnique.reduce((s, t) => s + weightOf(idf, t, docCount), 0);
  if (queryMass <= 0) return null;

  let best: { proposal: LinkProposal; updatedAt: string } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const docTerms = new Set(docs[i]);
    const shared = queryUnique.filter((t) => docTerms.has(t));
    if (shared.length < MIN_SHARED_TERMS) continue;

    const sharedMass = shared.reduce((s, t) => s + weightOf(idf, t, docCount), 0);
    const score = Math.min(1, sharedMass / queryMass);
    if (score < PROPOSAL_THRESHOLD) continue;

    const ranked = [...shared].sort((a, b) => {
      const d = weightOf(idf, b, docCount) - weightOf(idf, a, docCount);
      return d !== 0 ? d : a.localeCompare(b);
    });
    const recommended: LinkKind = RUNNING_STATUSES.has(c.status) ? "chain" : "subtask";
    const proposal: LinkProposal = {
      targetTaskId: c.id,
      targetText: c.text,
      targetStatus: c.status,
      recommended,
      score: Math.round(score * 100) / 100,
      sharedTerms: ranked.slice(0, 6),
      reason: reasonFor(c, ranked.slice(0, 4), recommended),
    };

    // Deterministico anche a parità: punteggio, poi la card toccata più di
    // recente, poi l'id. Due esecuzioni sulla stessa board danno la stessa
    // proposta — senza, un test che passa oggi passa per caso.
    if (
      !best ||
      proposal.score > best.proposal.score ||
      (proposal.score === best.proposal.score &&
        (c.updatedAt > best.updatedAt ||
          (c.updatedAt === best.updatedAt && c.id < best.proposal.targetTaskId)))
    ) {
      best = { proposal, updatedAt: c.updatedAt };
    }
  }

  return best?.proposal ?? null;
}

function reasonFor(c: IntakeCandidate, terms: string[], kind: LinkKind): string {
  const words = terms.map((t) => `«${t}»`).join(", ");
  const what = kind === "chain"
    ? "sta ancora girando, quindi il testo nuovo sembra un seguito"
    : "è aperta e non è ancora partita, quindi il testo nuovo sembra un suo pezzo";
  return `Stesso tema di «${c.text}» (${STATUS_LABEL[c.status]}): parole in comune ${words}. Quella card ${what}.`;
}

/**
 * La nota che finisce nel thread di ENTRAMBE le card. Niente attribuzione muta:
 * chi apre la card bloccata deve leggere perché è bloccata, e chi apre il
 * bloccante deve sapere che qualcuno lo sta aspettando — senza dover andare a
 * cercare l'altra metà del collegamento.
 */
export function linkNotes(args: {
  kind: LinkKind;
  newTaskText: string;
  targetText: string;
  reason: string;
}): { onNewTask: string; onTargetTask: string } {
  const { kind, newTaskText, targetText, reason } = args;
  if (kind === "subtask") {
    return {
      onNewTask: `Intake: nato come **sottotask** di «${targetText}», su proposta accettata da te.\n\n${reason}`,
      onTargetTask: `Intake: «${newTaskText}» è stato aggiunto come **sottotask** di questa card, su proposta accettata da te.\n\n${reason}`,
    };
  }
  return {
    onNewTask: `Intake: **incatenato** a «${targetText}» su proposta accettata da te. Non parte finché quella card non chiude, poi riprende il filo nella sua conversazione.\n\n${reason}`,
    onTargetTask: `Intake: «${newTaskText}» è **in attesa di questa card**. Parte da solo quando questa chiude, riprendendo questa conversazione.\n\n${reason}`,
  };
}
