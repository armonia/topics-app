/**
 * Il permesso su un singolo strumento: le parole e il riassunto degli argomenti.
 *
 * I TIPI stanno in `shared/types.ts` (`ToolCallStatus: 'awaiting_permission'`,
 * `ToolPermissionRequest`, `PermissionDecision`), perché sono un contratto sul
 * filo. Qui resta solo ciò che si LEGGE: le tre etichette e la riga che dice con
 * quali argomenti verrebbe eseguito.
 *
 * ── Perché non è (più) una domanda ──────────────────────────────────────────
 * Il primo taglio riusava il pannello di `AskUserQuestion`: la decisione
 * viaggiava come valore di una mappa `{ "Permesso richiesto — <tool>":
 * "Consenti sempre" }`, riconosciuta per prefisso di stringa. Reggeva, e
 * costava tre eccezioni dentro il form delle domande — spegnere «Altro»,
 * cambiare l'etichetta del tasto, cambiare l'occhiello. Tre eccezioni sono il
 * segnale che una cosa è nel posto sbagliato.
 *
 * Adesso il permesso ha il suo stato e il suo endpoint, e la decisione viaggia
 * come enum. Queste etichette servono a chi DISEGNA (e ai test che premono i
 * bottoni), non più a riconoscere niente: se cambi una parola qui, cambia solo
 * quello che si legge.
 */

import type { PermissionDecision } from './types';

export const PERMISSION_LABELS: Record<PermissionDecision, string> = {
  allow: 'Consenti',
  allow_always: 'Consenti sempre',
  deny: 'Nega',
};

/** Cosa fa ciascuna, in una riga — sotto l'etichetta, nel pannello. */
export const PERMISSION_HINTS: Record<PermissionDecision, string> = {
  allow: 'Solo per questa volta.',
  allow_always: 'Non chiedere più per questo strumento. Si revoca dalle impostazioni.',
  deny: "L'agente riceve un no e prosegue senza.",
};

/** L'ordine in cui compaiono. Il no per ultimo: si legge prima cosa si concede. */
export const PERMISSION_CHOICES: PermissionDecision[] = ['allow', 'allow_always', 'deny'];

/**
 * Un riassunto di UNA RIGA degli argomenti, perché un permesso concesso senza
 * vedere cosa farà non è un permesso: è un pulsante.
 *
 * Volutamente breve e senza valori lunghi — la riga sta in una chat, e il
 * dettaglio completo resta negli argomenti del tool, che la riga sa già mostrare
 * quando la apri.
 */
export function summarizeToolInput(input: unknown, maxLen = 160): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return clamp(String(input), maxLen);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  // `file_path`/`command`/`url` per primi: sono quelli che dicono davvero cosa
  // sta per succedere. Il resto segue nell'ordine in cui è arrivato.
  const priority = ['file_path', 'path', 'command', 'url', 'query'];
  entries.sort((a, b) => {
    const ia = priority.indexOf(a[0]);
    const ib = priority.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const parts: string[] = [];
  for (const [k, v] of entries) {
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    if (rendered === undefined) continue;
    parts.push(`${k}: ${clamp(rendered, 60)}`);
    if (parts.join(' · ').length >= maxLen) break;
  }
  return clamp(parts.join(' · '), maxLen);
}

function clamp(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/**
 * Una decisione arrivata dal filo è una delle tre?
 *
 * Sul confine si valida, non si spera: un valore che non riconosciamo NON
 * diventa un sì per inerzia — il chiamante lo rifiuta con un 400, e davanti a
 * un permesso «non ho capito» non può voler dire «vai».
 */
export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === 'allow' || value === 'allow_always' || value === 'deny';
}
