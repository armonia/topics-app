/**
 * Come si chiudono i tool ancora appesi quando il turno finisce.
 *
 * Pura di proposito, come `cancelledNotice` e `staleStreamVerdict` accanto: la
 * regola viveva dentro `finalizeStream`, in mezzo a una route di tremila righe
 * con un provider vero attaccato, ed era una riga sola —
 * `reason === 'done' ? 'success' : 'error'`.
 *
 * IL DIFETTO CHE QUELLA RIGA NASCONDEVA, misurato il 2026-08-28 su
 * topic:4c935add, tre volte su tre. Il modello scriveva un documento intero
 * dentro l'argomento di un `write_file`; ha sfondato il tetto di output a meta'
 * del JSON; il giro e' uscito con `stopReason: "max_tokens"` PRIMA di eseguire i
 * tool. Nel log resta `Tool start: write_file` e ZERO `Tool result`, e su disco
 * non c'e' nessun file. Ma per questa riga `reason` era `done`, quindi il tool
 * chiudeva con la spunta verde e il risultato vuoto.
 *
 * Una spunta verde su una scrittura mai avvenuta e' peggio di un errore: chi
 * legge smette di cercare. L'utente ha guardato in `~/Downloads` per un file che
 * il sistema dichiarava scritto.
 */
import type { TurnEndInfo } from "../providers/stop-reason";

export interface ToolOutcome {
  status: "success" | "error";
  /** Presente solo sull'errore: e' la frase che l'utente legge sul tool. */
  error?: string;
}

/**
 * `reason` e' come e' finito lo stream, `turnEnd` e' cosa dice il provider.
 *
 * Solo un turno finito NORMALMENTE lascia tool riusciti. `max_tokens` non e' una
 * fine normale: e' un taglio, e i tool che erano in volo quando e' arrivato non
 * sono mai partiti.
 */
export function toolOutcomeAtTurnEnd(
  reason: "done" | "error" | "aborted",
  turnEnd: TurnEndInfo | undefined,
  errorMsg?: string,
): ToolOutcome {
  if (reason === "aborted") return { status: "error", error: "Aborted by user" };
  if (reason === "error") return { status: "error", error: errorMsg || "Stream ended with error" };
  if (turnEnd?.end === "max_tokens") {
    return {
      status: "error",
      error: "Chiamata tagliata: il turno ha raggiunto il limite di lunghezza mentre scriveva gli argomenti",
    };
  }
  return { status: "success" };
}
