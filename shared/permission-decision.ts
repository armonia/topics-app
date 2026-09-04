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

/**
 * The i18n KEY of each decision's button, not the button's words.
 *
 * This module is the authority on WHICH decisions exist and in what order; it
 * stopped being the authority on the words the day the app got a language
 * selector, because a literal here cannot follow it. The four labels used to
 * be Italian strings printed straight into the panel where a person decides
 * whether an agent may touch their files: the most consequential text in the
 * app was the one text the selector could not reach.
 *
 * Keys and not words also keeps this module free of the client: `shared/` has
 * no access to the catalogues, and whoever renders resolves them.
 */
export const PERMISSION_LABEL_KEY: Record<PermissionDecision, string> = {
  allow: 'permission.decision.allow.label',
  allow_always: 'permission.decision.allow_always.label',
  deny: 'permission.decision.deny.label',
  allow_free: 'permission.decision.allow_free.label',
};

/** What each one does, in one line, under the button. Keys, same reason. */
export const PERMISSION_HINT_KEY: Record<PermissionDecision, string> = {
  allow: 'permission.decision.allow.hint',
  allow_always: 'permission.decision.allow_always.hint',
  deny: 'permission.decision.deny.hint',
  allow_free: 'permission.decision.allow_free.hint',
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
