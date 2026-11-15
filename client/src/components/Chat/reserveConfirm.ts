import { apiFetch } from '../../lib/shell/net';

/**
 * The account engine stops a turn on the reserve and asks (15/11, Attilio: «avvisare e bloccare dicendo vuoi
 * continuare? ... bloccare solo su conferma esplicita»): with every other subscription out, it answers
 * `reserve_confirmation_required` instead of spending the last account past its cap. The type is the engine's
 * own, stable (hub-service `sb/reserve.rs`).
 */
export const RESERVE_ERROR_TYPE = 'reserve_confirmation_required';

export function isReserveStop(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(RESERVE_ERROR_TYPE);
}

/** The user's yes: the engine lifts the caps until the first reset (24 h at most). */
export async function confirmReserve(): Promise<boolean> {
  try {
    const r = await apiFetch('/api/switchboard/reserve-confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    if (!r.ok) return false;
    const v = (await r.json()) as { confirmed?: unknown };
    return v.confirmed === true;
  } catch {
    return false;
  }
}
