/**
 * Mounts the standalone view page (`/v/<id>`, GENUI-01) in its own React tree.
 *
 * Kept apart from `ViewPage.tsx` so that file exports only components
 * (react-refresh/only-export-components).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewPage } from './ViewPage';

export function mountViewPage(container: HTMLElement, id: string): void {
  createRoot(container).render(
    <StrictMode>
      <ViewPage id={id} />
    </StrictMode>,
  );
}
