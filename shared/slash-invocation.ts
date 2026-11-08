/**
 * Il messaggio che È un comando.
 *
 * Quando scrivi `/recap`, Topics non lo espande: i comandi che non gestisce da
 * sé (`/status`, `/context`, `/clear`, `/compact`…) partono verbatim e li
 * espande la CLI, PRIMA del turno. Verificato sul filo: lo stream che torna
 * contiene solo la risposta — nessun `tool_use`, nessun testo iniettato, niente
 * che dica «sto usando una skill».
 *
 * Fino a ieri quel segnale c'era per sbaglio: il corpo del comando colava nella
 * risposta dell'assistente, incollato davanti al testo vero. Toglierlo era
 * giusto, ma lasciava la chat senza NESSUNA traccia di cosa avessi lanciato —
 * il turno sembrava una risposta uscita dal nulla.
 *
 * L'unico che sa la verità è il messaggio che hai scritto tu. Riconoscerlo per
 * quello che è — un comando, non una riga di prosa — è il segnale onesto: non
 * inventa una chiamata a un tool che non c'è stata.
 */

export interface SlashInvocation {
  /** Il nome, senza barra: `recap`. */
  command: string;
  /** Quello che segue, se c'è. */
  args?: string;
}

/**
 * `/recap`, `/vai solo il bug X`, `/jarvis-custom-skills:master` → l'invocazione.
 * Qualunque altra cosa → `null`.
 *
 * Deliberatamente STRETTO: una sola riga, che comincia con la barra e prosegue
 * con un nome plausibile. Un messaggio che comincia per `/Users/...` è un
 * percorso, e `/ ciao` non è un comando — trattarli da comandi metterebbe
 * un'etichetta falsa su un messaggio normale, che è peggio di non metterne.
 */
export function parseSlashInvocation(content: string): SlashInvocation | null {
  const text = (content ?? '').trim();
  if (!text.startsWith('/')) return null;
  if (text.includes('\n')) return null;
  const m = /^\/([a-zA-Z][\w:-]*)(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  const args = m[2]?.trim();
  return args ? { command: m[1], args } : { command: m[1] };
}
