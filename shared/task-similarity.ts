/**
 * Quando due card dicono la stessa cosa.
 *
 * In 24h gli agenti hanno aperto 320 card e l'umano 45: sette a uno. La board
 * di topics-app tiene 1.447 card vive e non torna mai a zero, perché nessuno
 * chiude un doppione: lo apre di nuovo con altre parole. Serve una misura di
 * somiglianza che un agente possa consultare PRIMA di creare la 321esima card,
 * e su cui un umano possa premere "fondi" senza perdere niente.
 *
 * Il modulo è puro: entra testo, esce un verdetto. Nessun DB, nessuna rete,
 * nessun modello. Deterministico, quindi verificabile con casi veri.
 *
 * ## Perché non basta contare le parole in comune
 *
 * Il difetto che affonda ogni misura ingenua sono i FRATELLI: card sorelle di
 * una stessa tornata, che condividono quasi tutto il testo e non sono affatto
 * la stessa cosa. Presi dalla board vera (2026-08-12):
 *
 *   «browser_screenshot su WebView2 + WebKitGTK»
 *   «browser_eval_js su WebView2 + WebKitGTK»
 *
 * Dice sui token di contenuto vale 0,67: sopra qualunque soglia ragionevole.
 * Fonderle vorrebbe dire cancellare un pezzo di lavoro che nessuno ha fatto.
 *
 * La distinzione utile non è quanto testo condividono, ma QUALI parole le
 * separano. `browser_eval_js` non è un sinonimo: è un identificatore, il nome
 * della cosa da fare. Le chiamiamo àncore (`anchors`): token che portano
 * identità invece che descrizione, cioè che contengono `_`, `/`, `.`, oppure
 * sono numeri o versioni. Due card possono essere doppioni solo se le loro
 * àncore non si CONTRADDICONO (vedi `anchorsCompatible`). Il testo intorno può
 * cambiare quanto vuole:
 *
 *   «store: UserMemoryStore.update() + test»
 *   «store: UserMemoryStore.update() + unit test»
 *
 * stesse àncore (`usermemorystore.update`), Dice alto, doppioni davvero.
 *
 * ## La soglia
 *
 * `DUPLICATE_THRESHOLD` è tarata sulle 1.447 card vive di topics-app, non a
 * sentimento. Coppie giudicate doppioni, al variare della soglia:
 * 0,60 → 78 · 0,65 → 45 · 0,70 → 28 · **0,72 → 24** · 0,75 → 19 · 0,80 → 9.
 *
 * Il confine sta lì perché a 0,65 entra questa coppia, che dice il CONTRARIO:
 *
 *   «Ricerca: IDE con kanban integrato»
 *   «Ricerca: Competitor tool con kanban (non-IDE)»        (0,67)
 *
 * e a 0,60 ne entrano altre tre della stessa forma. Sopra 0,80 restano solo le
 * riscritture quasi letterali e si perdono doppioni veri, come
 * «Server: payload con blockedBy risolto» contro «Server: risolvere il
 * bloccante nel payload» (0,75).
 *
 * Un falso positivo noto sopravvive a 0,72, ed è giusto sapere che c'è:
 * «Node bridge: emulatore VT headless…» contro «Rust bridge: parità, emulatore
 * VT…» (0,75). Due implementazioni della stessa cosa, e nessuna àncora le
 * separa perché `node` e `rust` sono parole normali. Per questo la fusione la
 * propone la macchina e la preme una persona.
 */

/** Una card ridotta a ciò che serve per confrontarla. */
export interface SimilarTask {
  id: string;
  text: string;
  /** Usata solo per scegliere la superstite: la più vecchia vince. */
  createdAt?: string | null;
}

/**
 * Soglia di Dice sopra la quale due testi con le stesse àncore sono doppioni.
 * Non è un numero rotondo per caso: vedi il commento in testa al file.
 */
export const DUPLICATE_THRESHOLD = 0.72;

/**
 * Soglia più bassa per il SUGGERIMENTO alla creazione. Chi sta per aprire una
 * card non rischia niente a vedere tre vicini: decide lui. È il merge che deve
 * essere prudente, non l'avviso.
 */
export const NEIGHBOUR_THRESHOLD = 0.55;

/**
 * Parole che non distinguono niente. Italiano e inglese insieme perché la board
 * è bilingue per costruzione (i titoli li scrivono sia l'umano che gli agenti).
 * Volutamente corta: una stopword di troppo cancella un termine tecnico.
 */
const STOPWORDS = new Set([
  // italiano
  'a', 'ad', 'ai', 'al', 'alla', 'alle', 'allo', 'anche', 'che', 'chi', 'ci',
  'col', 'come', 'con', 'cui', 'da', 'dai', 'dal', 'dalla', 'de', 'dei', 'del',
  'della', 'delle', 'dello', 'di', 'e', 'ed', 'gli', 'ha', 'hanno', 'i', 'il',
  'in', 'io', 'la', 'le', 'lo', 'ma', 'me', 'mi', 'ne', 'nel', 'nella', 'nelle',
  'non', 'o', 'per', 'piu', 'quando', 'quello', 'questa', 'queste', 'questi',
  'questo', 'se', 'si', 'sono', 'su', 'sul', 'sulla', 'sulle', 'te', 'ti', 'tra',
  'un', 'una', 'uno', 'va', 'ver',
  // inglese
  'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'is',
  'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to', 'was',
  'were', 'with',
]);

/** Un token che porta identità: nome di simbolo, path, versione, numero. */
function isAnchor(token: string): boolean {
  if (/^\d/.test(token)) return true; // numeri e versioni: 2.2.112, 088, 5
  return /[_/.]/.test(token); // browser_eval_js, /api/memory, store.update
}

/**
 * Porta un titolo alla sua forma confrontabile: minuscole, senza accenti, senza
 * la numerazione con cui gli agenti impaginano le tornate («4b. », «1. »), senza
 * decorazioni.
 *
 * La numerazione va via PRIMA di tutto il resto: «4a. Prep 2.2.112» e
 * «Prep 2.2.112» sono la stessa card scritta due volte, e il prefisso di lista
 * è esattamente il rumore che le farebbe sembrare diverse.
 */
export function normalizeTaskText(raw: string): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accenti via: priorità = priorita
    .toLowerCase()
    .replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]*/u, '')
    .replace(/^(?:[(\[]?\d+[a-z]?[.)\]]\s*)+/, '') // «4b. », «1) », «(2) »
    .replace(/^[-*•+]\s+/, '')
    .replace(/[«»"'`´“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Spezza un titolo in token confrontabili.
 *
 * L'ordine conta: gli identificatori si estraggono INTERI prima che la
 * punteggiatura li faccia a pezzi, altrimenti `browser_eval_js` diventa tre
 * parole comunissime e l'àncora sparisce proprio dove serve.
 */
export function tokenizeTaskText(raw: string): { content: string[]; anchors: string[] } {
  const norm = normalizeTaskText(raw);
  const anchors: string[] = [];
  const content: string[] = [];

  // Identificatori: parole tenute insieme da `_`, `/` o `.`, e versioni.
  const identifier = /[a-z0-9]+(?:[_/.][a-z0-9]+)+/g;
  const rest = norm.replace(identifier, (m) => {
    // `update()` e `update(companyid, userid)` devono dare la stessa àncora:
    // la lista di argomenti non fa identità.
    const cleaned = m.replace(/\.$/, '');
    anchors.push(cleaned);
    content.push(cleaned);
    return ' ';
  });

  for (const word of rest.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (STOPWORDS.has(word)) continue;
    if (word.length < 2 && !/^\d$/.test(word)) continue;
    content.push(word);
    if (isAnchor(word)) anchors.push(word);
  }

  return { content: unique(content), anchors: unique(anchors) };
}

function unique(list: string[]): string[] {
  return [...new Set(list)].sort();
}

/** Dice: due volte l'intersezione diviso la somma delle taglie. 0 = nulla in comune. */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared++;
  return (2 * shared) / (a.length + b.length);
}

/**
 * Le àncore sono compatibili quando una card non NOMINA una cosa diversa
 * dall'altra: uno dei due insiemi contiene l'altro.
 *
 * L'uguaglianza esatta sembrava la regola giusta e non lo era. Misurata sulle
 * 1.447 card vive, bocciava 7 coppie e almeno 5 erano doppioni veri, bocciati
 * solo perché una delle due era più precisa:
 *
 *   «3. Migration: autore (persona + dispositivo) sui messaggi»
 *   «Migration 093: autore (persona + dispositivo) sui messaggi»   (0,92)
 *
 * La seconda aggiunge il numero della migration. Non nomina un'altra cosa: dice
 * la stessa con un dettaglio in più. Il sottoinsieme lo accetta e continua a
 * fermare il caso che conta, dove le àncore si CONTRADDICONO:
 *
 *   «browser_screenshot su WebView2 + WebKitGTK»
 *   «browser_eval_js su WebView2 + WebKitGTK»
 *
 * nessuno dei due insiemi contiene l'altro, quindi sono due lavori diversi.
 */
function anchorsCompatible(a: string[], b: string[]): boolean {
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(big);
  return small.every((t) => set.has(t));
}

/** Perché due card sono, o non sono, doppioni. */
export type DuplicateReason =
  | 'identical' // stesso testo una volta normalizzato
  | 'near' // àncore identiche e testo sopra soglia
  | 'anchors-differ' // fratelli: cambia il nome della cosa da fare
  | 'below-threshold' // parenti, non gemelle
  | 'too-short'; // troppo poco testo per giudicare

export interface DuplicateVerdict {
  /** Dice sui token di contenuto, 0..1. */
  score: number;
  duplicate: boolean;
  reason: DuplicateReason;
}

/** Un titolo già ridotto: si calcola una volta e si riusa in ogni confronto. */
interface Prepared {
  norm: string;
  content: string[];
  anchors: string[];
}

function prepare(raw: string): Prepared {
  const { content, anchors } = tokenizeTaskText(raw);
  return { norm: normalizeTaskText(raw), content, anchors };
}

function verdict(a: Prepared, b: Prepared, threshold: number): DuplicateVerdict {
  if (a.norm && a.norm === b.norm) return { score: 1, duplicate: true, reason: 'identical' };
  const score = dice(a.content, b.content);
  if (a.content.length < 3 || b.content.length < 3) {
    return { score, duplicate: false, reason: 'too-short' };
  }
  if (!anchorsCompatible(a.anchors, b.anchors)) {
    return { score, duplicate: false, reason: 'anchors-differ' };
  }
  if (score < threshold) return { score, duplicate: false, reason: 'below-threshold' };
  return { score, duplicate: true, reason: 'near' };
}

/**
 * Il verdetto su due titoli.
 *
 * Un titolo con meno di tre token di contenuto («Cancelli», «Fix») non ha
 * abbastanza superficie perché Dice significhi qualcosa: lì l'unico doppione
 * che accettiamo è l'identità esatta.
 */
export function compareTasks(a: string, b: string, threshold = DUPLICATE_THRESHOLD): DuplicateVerdict {
  return verdict(prepare(a), prepare(b), threshold);
}

/** Una card vicina a un testo, col suo punteggio. */
export interface Neighbour {
  task: SimilarTask;
  score: number;
  duplicate: boolean;
}

/**
 * I vicini di un testo dentro una lista di card, dal più vicino al più lontano.
 *
 * È la chiamata del momento della creazione: l'agente sta per aprire una card,
 * questa gli dice se esiste già. Restituisce anche i quasi-doppioni (sotto la
 * soglia di fusione ma sopra `NEIGHBOUR_THRESHOLD`), perché a chi decide serve
 * vedere il confine, non solo il verdetto.
 */
export function findNeighbours(
  text: string,
  candidates: SimilarTask[],
  opts: { limit?: number; minScore?: number } = {},
): Neighbour[] {
  const min = opts.minScore ?? NEIGHBOUR_THRESHOLD;
  const out: Neighbour[] = [];
  for (const task of candidates) {
    const v = compareTasks(text, task.text);
    if (v.score < min && !v.duplicate) continue;
    out.push({ task, score: v.score, duplicate: v.duplicate });
  }
  out.sort((x, y) => (y.duplicate ? 1 : 0) - (x.duplicate ? 1 : 0) || y.score - x.score);
  return out.slice(0, opts.limit ?? 5);
}

/** Un gruppo di card che dicono la stessa cosa. La prima è la superstite. */
export interface DuplicateGroup {
  /** La card che sopravvive alla fusione: la più vecchia del gruppo. */
  survivor: SimilarTask;
  /** Le altre, in ordine di creazione. Mai vuoto. */
  duplicates: SimilarTask[];
  /** Il punteggio più basso dentro il gruppo: quanto è debole l'anello peggiore. */
  minScore: number;
}

/**
 * Raggruppa una board intera.
 *
 * I gruppi sono a STELLA, non a catena: ogni membro deve essere doppione della
 * superstite, non di un altro membro. La differenza non è teorica. Con le
 * componenti connesse, sulle 1.447 card vive di topics-app finivano nello stesso
 * gruppo «4. Barra verde (tsc + unit del server) e commit» e
 * «5. Barra verde: bun test + typecheck», che si somigliano 0,36: due tornate di
 * lavoro diverse, unite da un anello intermedio. Una fusione la si offre a un
 * umano, e la stella garantisce che il numero che legge (`minScore`) valga
 * contro la card che resta, non contro un vicino di passaggio.
 *
 * La superstite è la PIÙ VECCHIA: è quella che ha già i commenti, la storia e,
 * spesso, il ramo consegnato. Fondere dentro la nuova butterebbe via il thread
 * più lungo.
 */
export function findDuplicateGroups(tasks: SimilarTask[]): DuplicateGroup[] {
  const ordered = [...tasks].sort(
    (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id),
  );
  // Preparati una volta sola: il confronto è O(n²) e ri-tokenizzare a ogni
  // coppia costava 10s sulla board vera, contro meno di uno così.
  const prep = ordered.map((t) => prepare(t.text));
  const taken = new Array<boolean>(ordered.length).fill(false);
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (taken[i]) continue;
    const duplicates: SimilarTask[] = [];
    let minScore = 1;
    for (let j = i + 1; j < ordered.length; j++) {
      if (taken[j]) continue;
      const v = verdict(prep[i]!, prep[j]!, DUPLICATE_THRESHOLD);
      if (!v.duplicate) continue;
      taken[j] = true;
      duplicates.push(ordered[j]!);
      minScore = Math.min(minScore, v.score);
    }
    if (duplicates.length === 0) continue;
    taken[i] = true;
    groups.push({ survivor: ordered[i]!, duplicates, minScore });
  }

  groups.sort((a, b) => b.duplicates.length - a.duplicates.length || b.minScore - a.minScore);
  return groups;
}
