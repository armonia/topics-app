/**
 * inline-sent-state.ts — che cosa la sessione CLI ha già nel suo contesto.
 *
 * Serve a `adaptInlineSystem` per NON riemettere un preambolo che il
 * destinatario possiede già. Il provider `claude-code` è process-resident: il
 * `<context>` del primo turno è ancora nella sua conversazione al turno trenta.
 * Riappenderlo costa in modo COMPOSTO — i token del turno k li rilegge ogni
 * chiamata successiva — e su una chat reale erano il 15,9% dell'intera sessione.
 *
 * Perché in memoria e non a DB: perdere la mappa costa UNA re-iniezione (~2k
 * token) e si ricostruisce da sola al turno dopo. Una tabella per proteggere
 * 2k token occasionali sarebbe una migration e uno schema da mantenere per
 * sempre. Se un giorno la misura dicesse che i riavvii sono il fattore
 * dominante, questa mappa ha già la forma di una riga
 * (`session_key`, `scope`, `sent_json`) e la si persiste senza toccare i chiamanti.
 */
import { createHash } from "node:crypto";

/** Cap sulle sessioni tracciate: oltre, sfratto la più vecchia (FIFO). */
const MAX_TRACKED_SESSIONS = 256;

interface SessionState {
  /** `${claudeSessionId}#${compactionCount}` — vedi `inlineScope`. */
  scope: string;
  /** `slot → hash` di ciò che la CLI possiede. */
  sent: Map<string, string>;
}

const states = new Map<string, SessionState>();

/** Hash del contenuto di uno slot. Troncato: qui si confrontano stringhe, non si firma nulla. */
export function hashSlot(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Lo scope lega la memoria a UNA conversazione CLI.
 *
 * - `claudeSessionId` cambia su sessione nuova, `/revive`, o un `--resume` che
 *   atterra altrove: quella CLI non ha mai visto niente.
 * - `compactionCount` cambia dopo una compattazione: la conversazione è un
 *   RIASSUNTO, e nessuno garantisce che il README del progetto sia sopravvissuto
 *   alla sintesi.
 *
 * Sono i due soli eventi che possono cancellare il preambolo dalla conversazione
 * della CLI, ed è per questo che sono esattamente i due che azzerano la mappa.
 */
export function inlineScope(claudeSessionId: string | null | undefined, compactionCount: number): string {
  return `${claudeSessionId ?? "(none)"}#${compactionCount}`;
}

/**
 * Gli slot già in sessione per questo scope. Scope diverso da quello memorizzato
 * ⇒ mappa vuota (e lo stato vecchio buttato), cioè si riparte dal contesto completo.
 */
export function getInlineSentState(sessionKey: string, scope: string): ReadonlyMap<string, string> {
  const existing = states.get(sessionKey);
  if (!existing || existing.scope !== scope) return new Map();
  return existing.sent;
}

/**
 * Registra lo stato risultante di un turno (`payload.inlineSlots`), sostituendo
 * il precedente — gli slot ritirati sono già assenti dalla lista, quindi escono
 * di conseguenza.
 *
 * Restituisce il ROLLBACK. La marcatura è ottimistica di proposito: `sendChat`
 * risolve a turno avviato, e se l'utente accoda un secondo messaggio prima di
 * allora quello verrebbe composto con la mappa vecchia e riemetterebbe tutto il
 * preambolo. Marcare subito chiude la finestra; il caso speculare — aver marcato
 * qualcosa che non è mai arrivato — lo chiude il rollback, che il chiamante
 * invoca nello stesso ramo in cui dice all'utente che l'invio è fallito.
 */
export function markInlineSent(
  sessionKey: string,
  scope: string,
  slots: { slot: string; hash: string }[],
): () => void {
  const previous = states.get(sessionKey);
  const snapshot: SessionState | undefined = previous
    ? { scope: previous.scope, sent: new Map(previous.sent) }
    : undefined;

  states.set(sessionKey, { scope, sent: new Map(slots.map((s) => [s.slot, s.hash])) });

  if (states.size > MAX_TRACKED_SESSIONS) {
    for (const oldest of states.keys()) {
      if (oldest !== sessionKey) {
        states.delete(oldest);
        break;
      }
    }
  }

  return () => {
    if (snapshot) states.set(sessionKey, snapshot);
    else states.delete(sessionKey);
  };
}

/**
 * Sposta lo stato da uno scope all'altro, senza perderlo.
 *
 * Serve al primo turno di ogni sessione CLI. La riga di `claude_code_sessions`
 * NASCE dentro la prima `sendChat` (è `getOrCreateClaudeSessionId`, chiamata
 * durante lo spawn), quindi la route che compone lo scope PRIMA di inviare legge
 * un id che ancora non c'è e marca sotto `(none)#0`. Al turno dopo l'id esiste, lo
 * scope non combacia più e la mappa viene buttata: il preambolo intero riparte una
 * seconda volta e resta nella conversazione CLI per sempre, riletto a ogni
 * chiamata successiva.
 *
 * Ri-chiavare a turno concluso lo evita, ed è legittimo: la CLI identificata da
 * quell'id è esattamente quella che ha appena ricevuto il preambolo.
 *
 * No-op se lo stato non è più sotto `fromScope` — nel frattempo può essere
 * successo di tutto, e in quel caso l'esito giusto è che la mappa venga scartata
 * e il contesto rimandato.
 */
export function rekeyInlineSent(sessionKey: string, fromScope: string, toScope: string): void {
  if (fromScope === toScope) return;
  const existing = states.get(sessionKey);
  if (!existing || existing.scope !== fromScope) return;
  // Ri-chiavare vale SOLO per l'identità della sessione, mai attraverso una
  // compattazione — e l'invariante sta qui, non in un commento al chiamante.
  //
  // `sendChat` risolve a fine turno, mentre un'auto-compattazione arriva a METÀ:
  // ricalcolando lo scope nel `.then` si otteneva `uuid#N+1`, e spostare la mappa
  // là dentro dichiarava «questi slot sono già nella conversazione» su una
  // conversazione che era appena diventata un riassunto. Dal turno dopo il
  // preambolo non ripartiva più — esattamente ciò che il conteggio nello scope
  // esiste per impedire. Se il conteggio è cambiato, non si tocca niente: lo stato
  // resta sotto il vecchio scope e il turno successivo lo scarta, che è l'esito
  // giusto.
  if (compactionPart(fromScope) !== compactionPart(toScope)) return;
  existing.scope = toScope;
}

/** La coda `#<n>` di uno scope. Stringa e non numero: conta solo confrontarla. */
function compactionPart(scope: string): string {
  const i = scope.lastIndexOf("#");
  return i < 0 ? "" : scope.slice(i + 1);
}

/** Dimentica una sessione (chiusura del topic, reset esplicito). */
export function resetInlineSent(sessionKey: string): void {
  states.delete(sessionKey);
}

/** Solo per i test: svuota tutto. */
export function __clearInlineSentStateForTests(): void {
  states.clear();
}
