/**
 * Fixtures of the knowledge area beyond one document (n13, x03, v03, x04, o03):
 * the collections of the Consorzio di Nocera, every item in them, the
 * procedures the AI wrote, and the map of who knows what.
 *
 * Facts about the organization are from DATI-VERI.md. For a law the wording is
 * quoted only where it is known exactly; every other article carries its
 * subject and says «testo da caricare» with the official source it has to be (allow-italian: quotes the Italian interface)
 * loaded from (`pending`), so nothing in the text of a law is invented. The
 * summaries the Consorzio itself published in its 2025 yearbook say so in
 * their source chip. Counts are derived from these lists; the few estimates
 * (questions per month, how many people use Claude) are declared where they sit.
 */
import type { RichTextModel } from '../types';
import { LAWS } from './knowledge-more-laws';
import { DOCS } from './knowledge-more-docs';
import { PROCEDURES } from './knowledge-more-procedures';

export type CollectionId = 'norme' | 'regolamenti' | 'delibere' | 'pubblicazioni' | 'procedure' | 'personale';

/** One article or paragraph of an item, as the AI cites it. */
export interface ArticleSeed {
  id: string;
  heading: string;
  /** The chip it sits under (`a10` for `a10c1` and `a10c2`). */
  group: string;
  /** The wording, when it is loaded. */
  text?: RichTextModel;
  /** Where the wording comes from when it is not the official text. */
  source?: string;
  /** When the wording is not loaded: what the article is about. */
  subject?: string;
  /** Rules a flow derived from this article. */
  rules?: string[];
  /** The page of the original it is on. */
  page?: number;
}

export interface FactSeed {
  label: string;
  value: string;
  /** The official text is still to be loaded. */
  pending?: boolean;
  /** The row opens this item. */
  item?: string;
}

export interface VersionSeed {
  id: string;
  label: string;
  detail: string;
  status: { text: string; tone: 'green' | 'amber' | 'neutral' | 'red' };
  current?: boolean;
  /** The item that this version is. */
  item?: string;
  /** The official text of this version is still to be loaded: the row offers to load it. */
  pending?: boolean;
}

/** The original of an item as the reader sees it: the page drawn, and what is known of its publication. */
export interface OriginalSeed {
  /** The running head of the page, e.g. `POLIZIA IDRAULICA`. */
  heading: string;
  /** What the publication says about the act: one line per fact. */
  publication: Array<{ label: string; value: string; mono?: boolean }>;
  /** The paragraphs drawn on the page, when the original is loaded; the marked one is the passage cited. */
  paragraphs?: Array<{ text: string; mark?: boolean }>;
  page?: number;
  /** The page of the publication the act is on, when the text itself is not loaded. */
  notLoaded?: string;
  /** Where the original lives on the web. */
  site?: { label: string; url: string };
  /** What was checked against the site. */
  siteCheck?: string;
}

export interface RefSeed {
  label: string;
  item?: string;
  article?: string;
  /** The text is not loaded yet. */
  pending?: boolean;
  detail?: string;
}

/** A flow or flow step that cites an item; resolved against `FLOWS` by id. */
export interface FlowRefSeed {
  /** The id of the flow. */
  flow: string;
  /** A lowercase part of the step label. */
  step?: string;
  detail: string;
}

export interface ItemSeed {
  id: string;
  collection: CollectionId;
  /** Short name, as the tree and the chips print it. */
  label: string;
  title: string;
  subtitle?: string;
  status: { text: string; tone: 'green' | 'amber' | 'neutral' | 'red' };
  /** The official source the wording is loaded from. */
  officialSource: string;
  /** The article chips of the header. */
  chips: Array<{ id: string; label: string; articleId: string }>;
  articles: ArticleSeed[];
  facts: FactSeed[];
  /** Rows of «Regole che ne derivano»; `flow` is the id of the flow it opens, a missing one opens a new flow. (allow-italian: quotes the Italian interface) */
  ruleRows: Array<{ label: string; value: string; flow?: string }>;
  versions: VersionSeed[];
  original: OriginalSeed;
  refs: RefSeed[];
  flowRefs: FlowRefSeed[];
  /** Words that find it in search besides its text. */
  keywords?: string;
}

export const ITEMS: ItemSeed[] = [...LAWS, ...DOCS];

export const itemById = (id: string): ItemSeed | undefined => ITEMS.find((i) => i.id === id);

/** Finds an article by id, also when the case cited the whole article (`a23`) and the text is by comma (`a23c2`). */
export function findArticle(item: ItemSeed, article: string | undefined): ArticleSeed | undefined {
  if (!article) return undefined;
  return item.articles.find((a) => a.id === article) ?? item.articles.find((a) => a.id.startsWith(article) || article.startsWith(a.id)) ?? item.articles.find((a) => a.group === article);
}

/** The words of a rich text, for search and for matching a question. */
export function plainText(text: RichTextModel | undefined): string {
  if (!text) return '';
  return text
    .map((p) => (typeof p === 'string' ? p : 'strong' in p ? p.strong : 'mark' in p ? p.mark : ''))
    .join('');
}

export { PROCEDURES };
export type { ProcedureSeed } from './knowledge-more-procedures';

/**
 * What a collection is, by id. `viewers`, `source` and the state come from the
 * collections table of n13; counts are computed from the items.
 */
export interface CollectionSeed {
  id: CollectionId;
  label: string;
  viewers: string;
  source: string;
  description: string;
  /** Roles that may open it; empty = everyone who can open Conoscenza. */
  roles?: string[];
  /** The count printed in the table when it cannot be derived from the items (reported estimate or dato veri). */
  countOverride?: string;
}

export const COLLECTIONS: CollectionSeed[] = [
  { id: 'norme', label: 'Norme e leggi', viewers: 'tutti', source: 'caricate', description: 'Le leggi e i decreti che il Consorzio applica, divisi per articolo e comma: ogni risposta cita il comma esatto.' }, // allow-italian: fixture data, shown as written
  { id: 'regolamenti', label: 'Regolamenti', viewers: 'tutti', source: 'caricate', description: "I regolamenti e i piani approvati dal Consorzio e dalla Regione che valgono per il suo territorio." }, // allow-italian: fixture data, shown as written
  { id: 'pubblicazioni', label: 'Pubblicazioni', viewers: 'tutti', source: "Libro dell'anno 2025, dal sito", description: "Le pubblicazioni del Consorzio, lette e divise per capitolo: ogni passaggio si cita con la sua pagina." }, // allow-italian: fixture data, shown as written
  { id: 'delibere', label: "Delibere dall'albo", viewers: 'tutti', source: 'albo pretorio, ogni notte', description: "Le delibere pubblicate nell'albo pretorio, caricate ogni notte con il loro numero e la loro data." }, // allow-italian: fixture data, shown as written
  { id: 'procedure', label: 'Procedure interne', viewers: 'tutti', source: 'scritte dai flussi', description: "Come si lavora, passo per passo. Cresce da sola: dopo un flusso l'AI propone la procedura, una persona la approva." }, // allow-italian: fixture data, shown as written
  { id: 'personale', label: 'Personale', viewers: 'Personale, Direzione', source: 'SharePoint', description: 'I fascicoli del personale: li vedono solo il Personale e la Direzione, e restano su SharePoint.', roles: ['operatore', 'direzione'] }, // allow-italian: fixture data, shown as written
];

/**
 * The personnel of the Consorzio at 31/12/2024 (DATI-VERI.md, conto economico
 * 2024): 3 dirigenti, 30 impiegati, 96 operai. Only the counts: a folder per
 * person stays on SharePoint.
 */
export const STAFF_COUNTS = [
  { id: 'dirigenti', label: 'Dirigenti', count: 3 }, // allow-italian: fixture data, shown as written
  { id: 'impiegati', label: 'Impiegati', count: 30 }, // allow-italian: fixture data, shown as written
  { id: 'operai', label: 'Operai', count: 96 }, // allow-italian: fixture data, shown as written
];

/** Estimates printed in the panel of a collection; declared as such where they appear. */
export const USAGE_ESTIMATES = {
  questionsPerMonth: 380,
  mcpPeople: 8,
  people: 31,
};
