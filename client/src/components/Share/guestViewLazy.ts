/**
 * THE GUEST SCREEN, AS A CHUNK OF ITS OWN THAT IS WARM BEFORE IT IS NEEDED.
 *
 * `GuestView` replaces the whole app for a guest, so an owner never draws a
 * pixel of it; as a static import of `SessionRoot` it sat in the eager entry
 * with `GuestCard` and `guestStart` behind it (measured 2026-09-13: 9.2 KB raw
 * of the entry chunk), parsed on every boot of every owner window.
 *
 * `lazyWarm`, NOT `React.lazy`: a RETURNING guest is in the first frame. The
 * session store starts from the last paired state kept in localStorage, role
 * included, so a guest device mounts this screen on the very first render and
 * never passes through `loading`. With a plain `lazy` that boot showed an empty
 * surface for React's fallback throttle (300 ms) even with the chunk already
 * downloaded: header at 370 ms instead of 72-95 ms, measured with a probe on
 * the built bundle. `main.tsx` calls {@link warmGuestView} before the first
 * render when the cached session says guest, inside the same capped gate that
 * already waits for the pane chunks; a warm module renders with no fallback.
 * The first pairing of a new guest still goes through the Suspense boundary in
 * `SessionRoot`, which is the one moment the app was already on screen.
 *
 * WHY A MODULE OF ITS OWN: a file that exports both components and plain
 * functions loses fast refresh (`react-refresh/only-export-components`).
 */
import type { ComponentProps, ComponentType } from 'react';
import { lazyWarm, warm } from '@/lib/lazyWarm';
// Type-only: erased from the output, so the module stays out of this chunk.
import type { GuestView as Body } from './GuestView';

// Destructured on purpose, not `() => import('./GuestView')`: knip reads a bare
// `import()` as opaque and every export of the module would count as used
// (`check:deadcode-blindspots`).
const loadGuestView = async () => {
  const { GuestView: Component } = await import('./GuestView');
  return { GuestView: Component };
};

export const GuestView: ComponentType<ComponentProps<typeof Body>> = lazyWarm(
  loadGuestView,
  (m) => m.GuestView,
);

/** Starts loading the guest screen; resolves once a render can use it without a fallback. */
export function warmGuestView(): Promise<unknown> {
  return warm(loadGuestView);
}
