/**
 * `AppSettings.mutedProjects` letto dal SERVER.
 *
 * Il mute per-progetto è una preferenza del client — ma non vive solo lì:
 * `saveSettings` pubblica le AppSettings su `PUT /api/ui-state/settings`, e
 * `mutedProjects` non è un campo device-local, quindi `syncableSettings` non lo
 * toglie e la riga sul DB lo contiene già. Al server non serviva né una colonna
 * nuova né un canale nuovo: gli mancava solo qualcuno che lo LEGGESSE (il gate
 * della push di fine risposta, `isTopicSilenced` in `push-triggers.ts`).
 *
 * Il valore è JSON libero scritto da un client, quindi qui si valida tutto:
 * riga assente, JSON rotto, campo di forma sbagliata, elementi non-stringa.
 * Ogni caso storto vale LISTA VUOTA — cioè «nessun progetto mutato»: il verso
 * dell'errore è la push di troppo, non il silenzio di troppo, perché una
 * notifica in più si ignora e una persa non si recupera.
 */
import type { Database } from "bun:sqlite";

/** La chiave `ui_state` delle AppSettings (client: `SETTINGS_SERVER_KEY`). */
const SETTINGS_KEY = "settings";

export function readMutedProjects(db: Database): string[] {
  try {
    const row = db.prepare("SELECT value FROM ui_state WHERE key = ?").get(SETTINGS_KEY) as
      | { value?: string | null }
      | undefined;
    if (!row?.value) return [];
    const parsed: unknown = JSON.parse(row.value);
    const list = (parsed as Record<string, unknown> | null)?.mutedProjects;
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    // Tabella assente (DB pre-migration), JSON illeggibile, DB chiuso a metà
    // spegnimento: la push è best-effort e non deve mai buttare giù il broadcast.
    return [];
  }
}
