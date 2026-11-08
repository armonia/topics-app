/**
 * Decidere COSA buttare dalla cache dei messaggi al boot.
 *
 * IL GUASTO CHE CHIUDE, misurato il 2026-07-29: il localStorage dell'app era a
 * 5.245.244 byte su 5.242.880 di quota. Con la quota piena ogni `setItem`
 * falliva, compresa la coda dei messaggi scritti e non ancora consegnati.
 *
 * 4.563.206 su 22 voci erano `messages-cache-*` — l'87% della quota per una
 * cache il cui unico scopo e' mostrare la chat piu' in fretta al boot.
 *
 * Questa e' la decisione di cosa buttare. Sta qui, pura, perche' e' l'unico
 * modo di provarla senza un `localStorage` vero: vedi `messageCachePrune.test.ts`.
 */

/**
 * Quali voci di cache buttare per stare dentro il budget.
 *
 * Pura, cosi' e' testabile senza toccare `localStorage`: prende le voci con la
 * loro dimensione e restituisce le chiavi da rimuovere. Tiene le PIU' PICCOLE --
 * a parita' di budget si conservano piu' conversazioni, e quella enorme e' anche
 * quella che il server ricarica volentieri.
 */
export function decideCachePrune(
  entries: readonly { key: string; bytes: number }[],
  budget: number,
): string[] {
  const bySize = [...entries].sort((a, b) => a.bytes - b.bytes);
  const remove: string[] = [];
  let left = budget;
  for (const e of bySize) {
    if (e.bytes <= left) left -= e.bytes;
    else remove.push(e.key);
  }
  return remove;
}
