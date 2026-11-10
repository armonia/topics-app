/**
 * Where the originals of a case live. Every document of a seed is a real file
 * built by `scripts/ui-docs/build.mjs`: a PDF and one JPEG per page under
 * `client/public-ui/docs/<case>/`, plus its visible text in `doc-text.ts`.
 */
import { DOC_TEXT } from './doc-text';

export interface OriginalFiles {
  pages: string[];
  pdf: string;
  text: string[];
}

/** Paths and text of the document `docId` of case `caseId`, which has `pages` pages. */
export function original(caseId: string, docId: string, pages: number): OriginalFiles {
  return {
    pages: Array.from({ length: pages }, (_, i) => `docs/${caseId}/${docId}-${i + 1}.jpg`),
    pdf: `docs/${caseId}/${docId}.pdf`,
    text: DOC_TEXT[`${caseId}/${docId}`] ?? [],
  };
}
