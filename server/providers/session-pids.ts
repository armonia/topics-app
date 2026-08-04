/**
 * Il pid del CLI di ogni sessione (3.5).
 *
 * Serve a una cosa sola, ma serve: le shell che l'agente lascia in background
 * sono discendenti del suo processo, e senza quel pid non c'è modo di
 * distinguere «la `bun run dev` di QUESTA topic» da una uguale avviata
 * altrove. Il registro sta qui e non dentro `claude-code.ts` perché chi lo
 * legge (`routes/processes.ts`) non deve dipendere da un provider specifico:
 * qualunque provider che spawni un CLI può registrarsi.
 *
 * Non è persistito: un pid sopravvissuto a un riavvio del server sarebbe una
 * bugia con conseguenze — il numero può essere stato riciclato dal sistema, e
 * ci si appenderebbe un bottone «Stop».
 */

const cliPids = new Map<string, number>();

/** Registra (o dimentica, con `null`) il pid del CLI di una sessione. */
export function setSessionCliPid(sessionKey: string, pid: number | null | undefined): void {
  if (!sessionKey) return;
  if (typeof pid === "number" && pid > 0) cliPids.set(sessionKey, pid);
  else cliPids.delete(sessionKey);
}

export function getSessionCliPid(sessionKey: string): number | null {
  return cliPids.get(sessionKey) ?? null;
}

export function clearSessionCliPid(sessionKey: string): void {
  cliPids.delete(sessionKey);
}

/**
 * Tutte le sessioni con un CLI vivo registrato.
 *
 * Serve all'attribuzione delle risorse (`lib/fleet-usage.ts`): una CHAT con un
 * agente al lavoro ha un processo suo esattamente come un terminale, e senza
 * questo elenco risultava «non misurata» pur avendo un albero di processi
 * sotto. Il registro c'era già — mancava solo il modo di scorrerlo.
 */
export function listSessionCliPids(): { sessionKey: string; pid: number }[] {
  return [...cliPids].map(([sessionKey, pid]) => ({ sessionKey, pid }));
}
