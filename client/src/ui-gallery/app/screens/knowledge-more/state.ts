/**
 * What the knowledge area remembers between visits: documents the reader
 * loaded and the text pasted into articles, the questions asked, the state of
 * every procedure (approved, changes asked, edited), and the map's actions.
 * It lives in `ctx.slice`, so it survives a reload and «Ripristina demo» (allow-italian: quotes the Italian interface)
 * clears it. The shape of `PROCEDURES_SLICE` is what the Board reads to move
 * the card of a procedure.
 */
import type { CollectionId } from '../../../../ui/fixtures/knowledge-more';
import type { ProcedureStatus, ProcedureStepSeed } from '../../../../ui/fixtures/knowledge-more-procedures';

export interface UploadedDoc {
  id: string;
  title: string;
  collection: CollectionId;
  text: string;
  by: string;
  at: string;
}

export interface DocsState {
  uploads: UploadedDoc[];
  /** Text pasted into an article that was missing, by `<item>/<article>`. */
  pasted: Record<string, { text: string; by: string; at: string }>;
  questions: Array<{ q: string; at: string }>;
  sharepoint: boolean;
  /** Documents the reader follows, to be told when they change. */
  watch: Record<string, boolean>;
  /** When an original was last compared with the site, by item. */
  checked: Record<string, string>;
  /** The last sync of the albo pretorio. */
  synced?: string;
  /** Access asked for a locked collection, by collection. */
  requested: Record<string, boolean>;
}

export const DOCS_SLICE = 'knowledge.docs';
export const DOCS_INIT: DocsState = { uploads: [], pasted: {}, questions: [], sharepoint: false, watch: {}, checked: {}, requested: {} };

export type ProcedureLiveStatus = ProcedureStatus | 'modifiche' | 'scartata'; // allow-italian: fixture data, shown as written

export interface ProcedureLive {
  status?: ProcedureLiveStatus;
  /** The steps after the reader's edits; absent = the AI's. */
  steps?: ProcedureStepSeed[];
  comments: Array<{ id: string; who: string; text: string; at: string }>;
  versions: Array<{ id: string; kind: 'edited' | 'approved' | 'rewritten'; who: string; at: string }>;
  approvedBy?: string;
  approvedAt?: string;
}

export const PROCEDURES_SLICE = 'knowledge.procedures';
export type ProceduresState = Record<string, ProcedureLive>;
export const EMPTY_PROCEDURE: ProcedureLive = { comments: [], versions: [] };

export interface MapLive {
  /** When an action was scheduled, by action id. */
  scheduled: Record<string, string>;
  /** The substitute chosen for the handover. */
  substitute?: string;
  /** Interviews prepared from an activity, by activity id. */
  prepared: Record<string, boolean>;
}

export const MAP_SLICE = 'knowledge.map';
export const MAP_INIT: MapLive = { scheduled: {}, prepared: {} };
