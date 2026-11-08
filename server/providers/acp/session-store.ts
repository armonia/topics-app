/**
 * Ricorda quale conversazione dell'agente sta dietro una chat di Topics.
 *
 * Piccolo di proposito, e con una regola sola che non è ovvia: la `cwd` fa
 * parte dell'identità. ACP fissa la directory in `session/new` e non la si può
 * cambiare più; se la topic viene legata a un progetto o spostata su una
 * worktree, ricaricare la sessione vecchia significa far lavorare l'agente
 * nella cartella sbagliata — con tutti gli strumenti a percorso relativo che
 * puntano altrove. Meglio una conversazione nuova nel posto giusto che una
 * vecchia nel posto sbagliato: è il tipo di errore che non dà errore.
 */

import type { Database } from "bun:sqlite";

export interface ProviderSessionRow {
  providerSessionId: string;
  cwd: string | null;
}

export function readProviderSession(
  db: Database,
  provider: string,
  sessionKey: string,
): ProviderSessionRow | null {
  try {
    const row = db
      .prepare(
        `SELECT provider_session_id AS providerSessionId, cwd
           FROM provider_sessions
          WHERE provider = ? AND session_key = ?
          LIMIT 1`,
      )
      .get(provider, sessionKey) as ProviderSessionRow | undefined;
    return row ?? null;
  } catch {
    // La tabella può non esserci in un DB di test montato a mano: assenza di
    // memoria è un caso normale, non un guasto.
    return null;
  }
}

export function writeProviderSession(
  db: Database,
  provider: string,
  sessionKey: string,
  providerSessionId: string,
  cwd: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_sessions (provider, session_key, provider_session_id, cwd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, session_key) DO UPDATE SET
       provider_session_id = excluded.provider_session_id,
       cwd = excluded.cwd,
       updated_at = excluded.updated_at`,
  ).run(provider, sessionKey, providerSessionId, cwd, now, now);
}

export function forgetProviderSession(db: Database, provider: string, sessionKey: string): void {
  try {
    db.prepare(`DELETE FROM provider_sessions WHERE provider = ? AND session_key = ?`).run(
      provider,
      sessionKey,
    );
  } catch {
    /* niente da dimenticare */
  }
}

/**
 * La sessione ricordata è ancora buona per questa directory?
 *
 * `null` di parte nostra vuol dire «non ci interessa dove»: una sessione senza
 * workspace dichiarato non si invalida da sola. `null` sul disco è una riga
 * scritta prima che ci ponessimo il problema: si accetta.
 */
export function sessionMatchesCwd(row: ProviderSessionRow, cwd: string | null): boolean {
  if (!cwd || !row.cwd) return true;
  return row.cwd === cwd;
}
