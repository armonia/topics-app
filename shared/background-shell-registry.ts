/**
 * Il nome con cui una shell in background sta nel registro dei processi.
 *
 * Lo compone il server quando la registra (`routes/processes.ts`) e lo ricompone
 * la card della chat per ritrovarla: sessione + id, ripuliti dai caratteri che
 * non stanno in un id di processo. Deve stare in UN posto solo — se le due
 * ripuliture divergono la card non trova più la sua shell e torna muta, senza
 * che nessun test se ne accorga.
 */
export function shellProcessKey(sessionKey: string, shellId: string): string {
  const s = sessionKey.replace(/[^A-Za-z0-9_.:-]/g, "-");
  const id = shellId.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `shell:${s}:${id}`;
}

/**
 * La prima riga del log di una shell in background è un'INTESTAZIONE, non
 * output del comando: il registro la scrive per dare un contenuto alla riga
 * del pannello Processi anche prima che l'agente legga qualcosa.
 *
 * Nel pannello ha senso; dentro la card della chat no — lì la shell ha già il
 * suo id scritto sopra, e ripeterlo dentro il `<pre>` è la stessa cosa detta
 * due volte. Il testo sta qui, condiviso, perché chi lo scrive (il registro)
 * e chi lo toglie (la card) non si perdano di vista alla prossima riscrittura.
 */

export function backgroundShellBanner(shellId: string): string {
  return `[shell in background dell'agente, id ${shellId}]`;
}

/** Toglie l'intestazione, se la coda del log parte proprio da lì. */
export function stripBackgroundShellBanner(log: string, shellId: string): string {
  const banner = backgroundShellBanner(shellId);
  if (log === banner) return "";
  return log.startsWith(`${banner}\n`) ? log.slice(banner.length + 1) : log;
}
