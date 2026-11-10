import type { ReactNode } from 'react';
import type { CrumbModel, RichTextModel, StatusModel } from '../types';

export interface CollectionModel {
  id: string;
  label: string;
  expanded?: boolean;
  /** Readable only by some roles (personnel files). */
  locked?: boolean;
  items?: Array<{ id: string; label: string }>;
}

/** One article or paragraph of a document, as the AI cites it. */
export interface ArticleModel {
  id: string;
  heading: string;
  /** Where the text comes from, when it is not the official one. */
  source?: string;
  text: RichTextModel;
  /**
   * Set when the wording of the article is not loaded: what the article is
   * about, and the official source the text has to be loaded from. `text` is
   * then empty and nothing is quoted.
   */
  pending?: { subject: string; officialSource: string };
  /** Rules a flow derived from this paragraph. */
  rules?: string[];
  /** The records that cite this paragraph. */
  usedBy?: Array<{ id: string; title: string; detail: string }>;
}

export interface KnowledgeModel {
  crumbs: CrumbModel[];
  status: StatusModel;
  collections: CollectionModel[];
  selectedId: string;
  title: string;
  subtitle?: string;
  /** One tab per article; `articleId` is the first paragraph of it on the page, when loaded. */
  articleTabs: Array<{ id: string; label: string; active?: boolean; articleId?: string }>;
  articles: ArticleModel[];
  panel: {
    tag: string;
    title: string;
    description: string;
    factsLabel: string;
    /** `action` is a token the caller resolves when the row is pressed. */
    facts: Array<{ label: string; value: string; pending?: boolean; action?: string }>;
    rulesLabel: string;
    rules: Array<{ label: string; value: string; action?: string }>;
    /** A closing section of the panel; left out when there is no fact to put in it. */
    changeLabel?: string;
    changeText?: string;
  };
}

export type KnowledgeTab = 'text' | 'versions' | 'usedBy';


/** One row of the «versions» tab: a text of the document, or a text it replaced. */
export interface VersionModel {
  id: string;
  label: string;
  detail: string;
  status: StatusModel;
  /** The current text of the document. */
  current?: boolean;
  /** Opens the other document this version is (the law that was replaced). */
  openLabel?: string;
  /** The official text is still to be loaded: the row offers to load it. */
  pendingLoad?: boolean;
}

/** What cites a document, grouped by kind (cases, procedures, flows, answers). */
export interface UsageGroupModel {
  id: string;
  label: string;
  rows: Array<{ id: string; title: string; detail: string }>;
}

/** An answer of the question box: a sentence made of quoted passages, each with its number. */
export interface PassageModel {
  n: number;
  /** `L.R. Campania 7/2025 · Art. 10, comma 2` */
  label: string;
  /** The words of the document, the matched ones marked. */
  excerpt: RichTextModel;
  /** Where the passage opens: a token the caller resolves (`k:<item>/<article>`, `p:<procedure>`, `c:<case>/<doc>`). */
  sourceId: string;
}

export interface AnswerModel {
  question: string;
  /** `found`: passages answer it. `none`: no document says anything about it. */
  status: 'found' | 'none';
  /** The answer in prose; every claim carries its source (`source.id` = `item/article`). */
  summary: RichTextModel;
  passages: PassageModel[];
}

export interface CollectionRowModel {
  id: string;
  label: string;
  count: string;
  viewers: string;
  source: string;
  state: { text: string; tone: 'green' | 'amber' | 'neutral' };
  locked?: boolean;
}

export interface RecentModel {
  id: string;
  label: string;
  detail: string;
  /** `doc`, `procedure` or `question`: where it opens. */
  kind: 'doc' | 'procedure' | 'question';
}

export interface CollectionPanelModel {
  tag: string;
  /** A button under the description: `token` is what the caller resolves. */
  action?: { label: string; token: string };
  title: string;
  description: string;
  /** The documents of the collection, one row each, opening them. */
  items: Array<{ id: string; label: string; detail?: string; chip?: { text: string; tone: 'amber' | 'neutral' | 'violet' } }>;
  /** What waits for review in it (procedures written by the AI). */
  review: Array<{ id: string; label: string }>;
  /** `action` is a token the caller resolves when the row is pressed. */
  rules: Array<{ label: string; value: string; action?: string }>;
  usage: Array<{ label: string; value: string; action?: string; estimate?: boolean }>;
}

/** The fixed steps of a procedure and how the reader sees them. */
export interface ProcedureStepModel {
  id: string;
  text: string;
  /** What the step rests on: a case, an article of a norm, or nothing yet. */
  source?: { label: string; id?: string };
  /** The step a person added to what the AI wrote. */
  added?: boolean;
}

export interface ProcedureCommentModel {
  id: string;
  who: string;
  text: string;
  at: string;
}

export interface ProcedureVersionModel {
  id: string;
  label: string;
  detail: string;
  current?: boolean;
}

export interface ProcedureModel {
  id: string;
  crumbs: CrumbModel[];
  title: string;
  status: StatusModel;
  /** The line under the crumbs: how many cases are fixed, when approval arrives. */
  note: string;
  intro: string;
  facts: Array<{ label: string; value: string }>;
  steps: ProcedureStepModel[];
  mistakes: string;
  panel: { tag: string; tagTone: 'amber' | 'green' | 'violet' | 'neutral'; title: string; description: string };
  sources: Array<{ label: string; value: string; id?: string }>;
  comments: ProcedureCommentModel[];
  versions: ProcedureVersionModel[];
}

export type MapView = 'office' | 'person' | 'risk';

export interface MapKpiModel {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: 'red' | 'amber';
}

export interface MapActivityModel {
  id: string;
  label: string;
  /** Who knows it, as role codes. */
  holders: string[];
  /** Held by one person only. */
  gap: boolean;
  /** `written`: a procedure writes it down. `review`: it is written and waits for a person. */
  state: 'written' | 'review' | 'none';
  /** What a cell of the row opens: the procedure, the interview chat, the documents, or nothing yet. */
  action: 'procedure' | 'interview' | 'documents' | 'prepare';
  /** The office it belongs to, for lists that mix offices. */
  office?: string;
  /** A prepared interview, when the action was taken. */
  prepared?: boolean;
}

export interface MapOfficeModel {
  id: string;
  label: string;
  activities: number;
  written: number;
  singles: number;
  riskiest: string;
  holder: string;
  /** The activities listed for the office, the most important ones. */
  listed: MapActivityModel[];
}

export interface MapPersonModel {
  id: string;
  label: string;
  activities: number;
  only: number;
  nearRetirement?: boolean;
}

export interface MapNextModel {
  id: string;
  label: string;
  state: { text: string; tone: 'amber' | 'green' | 'neutral' };
  /** The control that moves the action on: a button, a choice. */
  control: ReactNode;
}
