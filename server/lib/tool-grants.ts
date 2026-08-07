/**
 * A quali strumenti si dice sì una volta per tutte.
 *
 * Un canale di permesso senza memoria è un canale che non si può usare: la
 * prima chat che cerca un volo chiede tre volte di fila per lo stesso tool, e
 * al quarto pannello la persona preme «consenti» senza leggere — che è il modo
 * in cui una domanda di sicurezza smette di essere una domanda.
 *
 * Quindi «Consenti sempre» scrive una REGOLA, e le regole vivono in una tabella
 * di Topics. Non nel file da cui dipendevano finora: fino a oggi l'unica cosa
 * che teneva vivi gli strumenti MCP era la riga `"mcp__topics__*"` dentro
 * `.claude/settings.local.json` del repo topics-app — un file **gitignorato**,
 * assente altrove. Da cui il guasto: lo stesso identico strumento passava se la
 * chat girava nel repo e moriva muto se girava altrove (misurato: repo OK,
 * HOME NEGATO). Una capacità non può dipendere da in quale cartella è nata la
 * chat, né da un file che nessuno versiona.
 *
 * ── La regola incorporata ───────────────────────────────────────────────────
 * `mcp__topics__*` non si chiede mai. Non è una scorciatoia: sono le MANI DI
 * TOPICS dentro la chat — aprire un pannello, aggiornare un task, chiedere una
 * cosa all'umano. Il 7 agosto una richiesta di permesso è arrivata proprio su
 * `mcp__topics__ask_user_question`: per mostrare una domanda serviva il
 * permesso di mostrare una domanda. Un'app non chiede il permesso di essere
 * sé stessa; ciò che quei tool possono fare è già deciso da chi ha installato
 * Topics.
 */

import { getDatabase } from '../db';

/** Le mani di Topics: mai in discussione. Vedi la nota in testa. */
export const TOPICS_BRIDGE_PREFIX = 'mcp__topics__';

export type GrantDecision = 'allow' | 'ask';

/**
 * Un pattern copre questo strumento?
 *
 * Due forme sole, di proposito:
 *   - nome esatto            `mcp__gateway__kiwi__search-flight`
 *   - prefisso con asterisco `mcp__gateway__*`
 *
 * Niente glob generici: `*` da solo, o in mezzo, trasformerebbe una lista di
 * consensi in una modalità «fai pure» scritta di traverso — e per quella esiste
 * già un nome (`yolo`), scelto in chiaro dal selettore di autonomia.
 */
export function grantMatches(pattern: string, toolName: string): boolean {
  const p = pattern.trim();
  if (!p || !toolName) return false;
  if (p === toolName) return true;
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1);
    // `*` nudo non è un pattern: sarebbe «tutto», e «tutto» ha già un nome.
    if (prefix.length === 0) return false;
    return toolName.startsWith(prefix);
  }
  return false;
}

/**
 * La decisione, in codice puro: si può concedere da soli, o si chiede?
 *
 * Nessun ramo «nega da solo»: una regola che nega in silenzio riprodurrebbe
 * esattamente il guasto che stiamo chiudendo — uno strumento che sparisce senza
 * che nessuno lo veda. Un no lo dice una persona, e si vede.
 */
export function decideGrant(opts: { toolName: string; patterns: readonly string[] }): GrantDecision {
  const name = opts.toolName?.trim() ?? '';
  if (!name) return 'ask';
  if (name.startsWith(TOPICS_BRIDGE_PREFIX)) return 'allow';
  return opts.patterns.some((p) => grantMatches(p, name)) ? 'allow' : 'ask';
}

// ─── Persistenza ────────────────────────────────────────────────────────────

export interface ToolGrant {
  pattern: string;
  createdAt: string;
  createdBySession: string | null;
}

/**
 * Le regole scritte, dalla più recente. Se la tabella non c'è ancora (server
 * partito prima della migration) si torna una lista vuota: il canale allora
 * CHIEDE, che è il comportamento sicuro — mai il contrario.
 */
export function listToolGrants(): ToolGrant[] {
  try {
    const rows = getDatabase()
      .prepare('SELECT pattern, created_at, created_by_session FROM tool_grants ORDER BY created_at DESC')
      .all() as { pattern: string; created_at: string; created_by_session: string | null }[];
    return rows.map((r) => ({
      pattern: r.pattern,
      createdAt: r.created_at,
      createdBySession: r.created_by_session,
    }));
  } catch {
    return [];
  }
}

/** Solo i pattern — quello che serve a `decideGrant`. */
export function listGrantPatterns(): string[] {
  return listToolGrants().map((g) => g.pattern);
}

/**
 * Scrive una regola. Idempotente: «Consenti sempre» premuto due volte non
 * duplica niente e non sposta la data della prima concessione — quando è stato
 * concesso è la cosa che si vuole sapere guardando la lista.
 */
export function addToolGrant(pattern: string, sessionKey?: string | null): boolean {
  const p = pattern.trim();
  if (!p || p === '*') return false;
  try {
    getDatabase()
      .prepare(
        'INSERT OR IGNORE INTO tool_grants (pattern, created_at, created_by_session) VALUES (?, ?, ?)',
      )
      .run(p, new Date().toISOString(), sessionKey ?? null);
    return true;
  } catch {
    return false;
  }
}

/** Revoca. Torna `true` se una regola è stata davvero tolta. */
export function removeToolGrant(pattern: string): boolean {
  try {
    const res = getDatabase().prepare('DELETE FROM tool_grants WHERE pattern = ?').run(pattern.trim());
    return (res as { changes?: number }).changes ? true : false;
  } catch {
    return false;
  }
}

/** La decisione, letta dal DB. Il guscio sottile sopra `decideGrant`. */
export function decideGrantForTool(toolName: string): GrantDecision {
  return decideGrant({ toolName, patterns: listGrantPatterns() });
}
