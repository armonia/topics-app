/**
 * I tipi di sessione del terminale — UNA lista, invece di diciotto copie.
 *
 * L'union `'shell' | 'claude-code' | 'codex' | 'opencode'` era riscritta a mano
 * in 18 punti fra server e client, e in un diciannovesimo — il CHECK di
 * `terminal_sessions.type` in SQLite — con un valore in meno. Aggiungere un tipo
 * significava trovarli tutti, e due volte non è successo:
 *
 *   • la migration 029 ha scoperto che 'codex' e 'claude-code-team' non erano
 *     nel CHECK: ogni insert violava il vincolo, la sessione girava in memoria e
 *     al riavvio la pane spariva;
 *   • la migration 066 ha scoperto la stessa cosa per 'opencode', aggiunto
 *     all'applicazione un anno dopo senza toccare il CHECK.
 *
 * La lista qui e il CHECK sono tenuti allineati da un test
 * (`server/db/terminal-session-types.test.ts`) che ricostruisce lo schema dalle
 * migration e confronta gli insiemi: aggiungere un tipo senza la migration ora
 * fa fallire la suite invece di far sparire una pane in produzione.
 */

/**
 * Tutti i valori che la colonna `terminal_sessions.type` può contenere.
 *
 * Include 'claude-code-team', che nessuna UI sa più creare: è un tipo LEGACY che
 * resta perché lo schema deve accettare le righe già scritte. Chi genera un menu
 * di creazione usa `TERMINAL_AGENT_TYPES`.
 */
export const TERMINAL_SESSION_TYPES = [
  "shell",
  "claude-code",
  "claude-code-team",
  "codex",
  "opencode",
  "kimi-code",
] as const;

export type TerminalSessionType = (typeof TERMINAL_SESSION_TYPES)[number];

/**
 * I tipi che l'utente può effettivamente APRIRE oggi — il sottoinsieme che
 * compare nei menu. Diverso da `TERMINAL_SESSION_TYPES` perché lo schema deve
 * accettare più di quanto la UI offra, non meno.
 */
export const TERMINAL_AGENT_TYPES = ["shell", "claude-code", "codex", "opencode", "kimi-code"] as const;

export type TerminalAgentType = (typeof TERMINAL_AGENT_TYPES)[number];

/** true = la stringa è un tipo di sessione valido (type guard, mai lancia). */
export function isTerminalSessionType(v: unknown): v is TerminalSessionType {
  return typeof v === "string" && (TERMINAL_SESSION_TYPES as readonly string[]).includes(v);
}
