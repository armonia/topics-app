/**
 * LA FINESTRA DA 1M, sul runtime nativo.
 *
 * `claude-opus-5[1m]` non è un nome che l'API conosce: è una convenzione nostra
 * (nata CLI-side, vedi `providers/claude-models.ts`) che dice «questo modello,
 * con la finestra lunga». Sull'API la finestra lunga si chiede in un altro
 * modo: l'header beta `context-1m-2025-08-07`, sul modello dal nome NUDO.
 *
 * Il loop nativo mandava l'id intero e un solo beta, quindi la finestra lunga
 * lì non è mai esistita: chi la sceglieva nel picker restava inchiodato al
 * provider `claude-code`, cioè a un processo CLI intero — ~206 MB per topic
 * (misurato, vedi la testa di `agent-loop.ts`) — senza che nessuno glielo
 * dicesse.
 *
 * Due funzioni pure e non un ramo dentro `streamOnce`, perché è la parte che si
 * può provare senza una rete: un id entra, un modello e un header escono.
 */

/** Il suffisso della variante a finestra lunga. Vale solo in CODA all'id. */
const SUFFISSO = '[1m]';

/** Il beta che autorizza la richiesta: non è opzionale, senza non si passa. */
const BETA_OAUTH = 'oauth-2025-04-20';

/**
 * Il beta della finestra lunga. La data fa parte del nome: è la versione della
 * beta, e cambiarla senza che Anthropic l'abbia cambiata rompe la richiesta.
 */
const BETA_1M = 'context-1m-2025-08-07';

export interface ModelloRichiesto {
  /** Il nome che va all'API: senza suffisso. */
  model: string;
  /** Serve l'header della finestra lunga. */
  longWindow: boolean;
}

/**
 * Separa la richiesta di finestra lunga dal nome del modello.
 *
 * `endsWith` e non `includes`: un id che contiene `[1m]` altrove non è una
 * variante, è un id sconosciuto — e trattarlo come tale gli fa dare all'API un
 * errore chiaro invece di un modello inventato.
 */
export function splitLongWindow(id: string): ModelloRichiesto {
  return id.endsWith(SUFFISSO)
    ? { model: id.slice(0, -SUFFISSO.length), longWindow: true }
    : { model: id, longWindow: false };
}

/**
 * Il valore di `anthropic-beta`, con la finestra lunga aggiunta quando serve.
 *
 * UNA intestazione con la lista, non due intestazioni: `fetch` collasserebbe i
 * duplicati e l'ultimo vincerebbe in silenzio, cioè il modo peggiore di
 * perdere l'autorizzazione.
 */
export function betaHeader(longWindow: boolean): string {
  return longWindow ? `${BETA_OAUTH},${BETA_1M}` : BETA_OAUTH;
}

/**
 * L'errore dell'API, tradotto quando la causa è la finestra lunga.
 *
 * Il caso vero: una famiglia che il beta non copre. Il picker non offre quegli
 * id — `longVariantOf` guarda cosa l'host annuncia davvero — ma un topic
 * vecchio o un modello pinnato a mano ci arriva lo stesso, e Anthropic risponde
 * «The long context beta is not yet available for this subscription» a turno
 * GIÀ PARTITO. Quel testo non dice a chi legge né perché né cosa fare.
 *
 * Si traduce SOLO questo caso. Un 500, o un 400 per un'altra ragione, arriva
 * come sta scritto: una frase nostra al posto di un errore che non abbiamo
 * capito nasconde la causa vera, ed è il modo in cui un messaggio d'aiuto
 * diventa un ostacolo.
 */
export function spiegaErrore(status: number, detail: string, modelId: string): string {
  const nudo = splitLongWindow(modelId).model;
  const eLaFinestra = status === 400 && /long context beta/i.test(detail);
  if (!eLaFinestra) return `API ${status}: ${detail.slice(0, 300)}`;
  return (
    `API 400: questo abbonamento non serve la finestra lunga per ${nudo}. ` // allow-italian: messaggio d'errore del provider, non UI
    + `Scegli lo stesso modello senza la variante 1M, oppure una famiglia che la regge ` // allow-italian: messaggio d'errore del provider, non UI
    + `(opus-5 e sonnet-5 la reggono, haiku no). Risposta dell'API: ${detail.slice(0, 200)}` // allow-italian: messaggio d'errore del provider, non UI
  );
}
