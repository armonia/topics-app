/**
 * Il permesso su un singolo strumento: le parole e il riassunto degli argomenti.
 *
 * I TIPI stanno in `shared/types.ts` (`ToolCallStatus: 'awaiting_permission'`,
 * `ToolPermissionRequest`, `PermissionDecision`), perché sono un contratto sul
 * filo. Qui resta ciò che si LEGGE — le etichette e la riga che dice con quali
 * argomenti verrebbe eseguito — più le due domande che si fanno TUTTI i
 * chiamanti su una decisione: cosa ne va alla CLI (`cliDecisionFor`) e se
 * libera la sessione (`decisionFreesSession`).
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
  allow_free: 'Passa a libero',
};

/** Cosa fa ciascuna, in una riga — sotto l'etichetta, nel pannello. */
export const PERMISSION_HINTS: Record<PermissionDecision, string> = {
  allow: 'Solo per questa volta.',
  allow_always: 'Non chiedere più per questo strumento. Si revoca dalle impostazioni.',
  deny: "L'agente riceve un no e prosegue senza.",
  allow_free:
    'Consente questa richiesta e porta QUESTA chat in modalità libera: da qui in poi esegue senza chiedere. Si torna indietro dal selettore di autonomia, nel composer.',
};

/**
 * L'ordine in cui compaiono. Il no per ultimo: si legge prima cosa si concede.
 *
 * `allow_free` NON è qui, ed è la parte importante di questa lista: mettercelo
 * l'avrebbe disegnato come un quarto bottone accanto agli altri — un click di
 * distanza da «Consenti», stessa forma, stesso peso visivo — quando invece è
 * l'unico dei quattro che cambia il REGIME della sessione e non solo l'esito di
 * questa richiesta. Il pannello lo disegna a parte (vedi ToolPermissionRow).
 */
export const PERMISSION_CHOICES: PermissionDecision[] = ['allow', 'allow_always', 'deny'];

/**
 * Le tre che la CLI capisce. `--permission-prompt-tool` risponde con
 * `behavior: allow | deny`, e non sa niente di modalità di autonomia: il quarto
 * esito è una decisione di Topics su sé stesso.
 */
export type CliPermissionDecision = 'allow' | 'allow_always' | 'deny';

/**
 * Cosa torna alla CLI per una decisione presa nel pannello.
 *
 * La conversione sta QUI, in un posto solo, e non dentro la rotta: è il confine
 * fra ciò che l'interfaccia offre e ciò che il processo figlio sa leggere.
 * `allow_free` diventa `allow` — la sessione passa a libera per altre vie (il
 * livello di autonomia del topic), non dicendo alla CLI una parola che non
 * conosce.
 */
export function cliDecisionFor(decision: PermissionDecision): CliPermissionDecision {
  return decision === 'allow_free' ? 'allow' : decision;
}

/** Questa decisione porta la sessione in modalità libera? */
export function decisionFreesSession(decision: PermissionDecision): boolean {
  return decision === 'allow_free';
}

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
  return value === 'allow' || value === 'allow_always' || value === 'deny' || value === 'allow_free';
}
