/**
 * LazyPane — `<Suspense fallback={spinner}>` wrapper used by every
 * lazy-loaded pane body in the layout layer (ProjectWindow,
 * StandaloneChatGroup, ChatPanel, …).
 *
 * Before extraction the same five-line wrapper was repeated 12+ times
 * across the codebase. Centralised here so adding a new lazy pane is
 * `<LazyPane><MyNewPane /></LazyPane>` instead of remembering the
 * fallback markup; and the spinner styling can be tweaked in one
 * place.
 */

import { Suspense, type ReactNode } from 'react';
import { SpinnerFallback } from '../Shared/Spinner';

/**
 * L'attesa di una pane, che è ESATTAMENTE il caso per cui esiste
 * `SpinnerFallback`. Qui viveva una copia a mano dello stesso anello, e
 * copiata male: il cerchio spento lo prendeva da `app-border-light` invece che
 * da `app-spinner`, cioè la pane che carica girava di un grigio diverso da
 * ogni altro pannello che carica. Il markup adesso è uno solo, il tono anche.
 */
export const LazySpinner = <SpinnerFallback />;

export function LazyPane({ children }: { children: ReactNode }) {
  return <Suspense fallback={LazySpinner}>{children}</Suspense>;
}
