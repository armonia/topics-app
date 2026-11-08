/**
 * Mounts the load screen (`/schermo[/<machine>]`) in its own React tree, like
 * the standalone view page: no panes, no socket, no sidebar. The screen is
 * always dark: a monitor across the room, read at a glance.
 *
 * Under `SessionRoot`, like the app: the PC's browser reaches the Mac's
 * Topics over the tailnet, so the first visit shows the pairing code to
 * approve on the Mac, and only an owner device or a device paired as a
 * screen sees it.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionRoot } from '../Share/SessionRoot';
import { LoadScreen } from './LoadScreen';

export function mountLoadScreen(container: HTMLElement, machine: string | null): void {
  document.documentElement.classList.add('dark');
  createRoot(container).render(
    <StrictMode>
      <SessionRoot screenPage>
        <LoadScreen machine={machine} />
      </SessionRoot>
    </StrictMode>,
  );
}
