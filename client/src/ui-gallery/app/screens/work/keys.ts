/**
 * The keys of the screen state the work area keeps (`ctx.ui`), and the one way
 * to open an original on a page: the viewer reads the page from the same key
 * the caller wrote before navigating.
 */
import type { ScreenCtx } from '../../kit';
import type { SourceModel } from '../../../../ui/types';
import type { LiveCase } from '../../store/cases';
import { P } from '../../paths';
import { sourcePath } from './assistant';

export const pageKey = (caseId: string, doc: string) => `work.doc.${caseId}.${doc}.page`;
export const zoomKey = (caseId: string, doc: string) => `work.doc.${caseId}.${doc}.zoom`;
/** The value whose quote the viewer shows: set when the reader comes from «where does this come from». */
export const focusKey = (caseId: string) => `work.doc.${caseId}.focus`;
export const MODE_KEY = 'work.doc.mode';

export interface DocFocus {
  doc: string;
  field: string;
}

/** Opens an original at a page, with the quote of a value when it comes from one. */
export function openOriginal(ctx: ScreenCtx, c: LiveCase, doc: string, page?: number, field?: string) {
  if (page) ctx.dispatch({ type: 'ui', key: pageKey(c.id, doc), update: () => page });
  ctx.dispatch({ type: 'ui', key: focusKey(c.id), update: () => (field ? ({ doc, field } satisfies DocFocus) : null) });
  ctx.go(P.recordDoc(c.id, doc));
}

/** Where a citation leads, turning the page first when it names one. */
export function openSource(ctx: ScreenCtx, c: LiveCase, source: SourceModel) {
  const t = sourcePath(c, source);
  if (t.doc) {
    openOriginal(ctx, c, t.doc, t.page);
    return;
  }
  ctx.go(t.path);
}
