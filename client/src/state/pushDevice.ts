/**
 * Lo stato dell'iscrizione push di QUESTO dispositivo, leggibile da chi non è
 * un componente.
 *
 * Serve a una cosa sola, e non è cosmetica: `useCompletionNotifier` deve sapere
 * se il push parla, per tacere sugli eventi che il push già annuncia (vedi
 * `lib/notify/pushVoice.ts`). Farlo passare come prop vorrebbe dire attraversare
 * mezza App per un booleano che cambia due volte nella vita di un dispositivo;
 * uno store lo rende leggibile anche dentro un handler WebSocket, che è
 * esattamente dove serve.
 */
import { create } from 'zustand';

// Le due voci possibili ad app aperta. Il tipo sta in `shared/push-device.ts`,
// dichiarato UNA volta: lo stesso insieme di valori è il contratto della colonna
// `when_open`, della rotta `/api/push/devices/prefs` e del payload che il
// service worker legge.
export type { PushWhenOpen } from '../../../shared/push-device';
import type { PushWhenOpen } from '../../../shared/push-device';

interface PushDeviceState {
  /** Esiste una subscription REGISTRATA per questo dispositivo. */
  subscribed: boolean;
  whenOpen: PushWhenOpen;
  setPushDevice: (next: { subscribed: boolean; whenOpen?: PushWhenOpen }) => void;
}

export const usePushDeviceStore = create<PushDeviceState>((set) => ({
  subscribed: false,
  whenOpen: 'native',
  setPushDevice: ({ subscribed, whenOpen }) =>
    set((s) => ({ subscribed, whenOpen: whenOpen ?? s.whenOpen })),
}));

/** Lettura fuori da React (handler WebSocket). */
export function isPushSubscribed(): boolean {
  return usePushDeviceStore.getState().subscribed;
}
