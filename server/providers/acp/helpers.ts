/**
 * Gli aiutanti del provider ACP: pezzi piccoli, indipendenti dalla sessione, e
 * senza stato.
 *
 * Stavano in fondo a `acp.ts`, che con la loro coda superava le 800 righe di
 * `check:bloat` (995 il 2026-08-16, e il cancello ha ragione: un file che due
 * persone non possono toccare insieme e' un lucchetto, e questo repo fa
 * lavorare una dozzina di agenti alla volta). Sono la parte che si porta fuori
 * senza spostare comportamento: nessuno di questi legge `this`, quindi il
 * confine e' gia' dove sta il taglio.
 */
import { getDatabase } from "../../db";
import { JsonRpcRemoteError, RPC_METHOD_NOT_FOUND } from "./jsonrpc";
import type { ChatMessage } from "../types";

/** La prima opzione con quel `kind`, fra quelle che l'agente ha proposto. */
export function findOption(options: unknown[], kind: string): Record<string, unknown> | undefined {
  return options.find(
    (o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && (o as Record<string, unknown>).kind === kind,
  );
}

/**
 * La conversazione come un testo solo, per gli agenti che accettano un prompt e
 * non una lista di turni. Il ruolo resta scritto davanti a tutto cio' che non e'
 * dell'utente: senza, un agente non distingue piu' quello che ha detto lui da
 * quello che gli e' stato chiesto.
 */
export function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => (m.role === "user" ? m.content : `[${m.role}] ${m.content}`))
    .join("\n\n");
}

/**
 * La stessa promise, ma con una scadenza. `unref` sul timer perche' un timeout
 * pendente non deve tenere vivo il processo dopo che tutto il resto e' finito.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, marker: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(marker)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Il testo di un errore qualsiasi, senza mai propagare `undefined`. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "errore sconosciuto");
}

/**
 * L'effort di ragionamento scelto per il topic di questa sessione, se c'è.
 *
 * Lettura stretta sulla riga, come fa `claude-code` per gli stessi override
 * (migrazione 033): passare da `getTopicBySessionKey` creerebbe un import
 * circolare con utils.ts. Best-effort per costruzione — senza board, senza
 * riga o con la tabella assente la risposta è `null`, cioè «l'agente tenga il
 * suo», e un turno non deve mai morire per una preferenza.
 */
export function readTopicEffort(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare("SELECT effort FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { effort?: string | null } | undefined;
    const raw = (row?.effort ?? "").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

/**
 * L'agente ha detto «questo metodo non ce l'ho» (JSON-RPC -32601)?
 *
 * Si guarda il CODICE e non il testo: il messaggio lo scrive l'agente e cambia
 * da implementazione a implementazione, mentre -32601 è nello standard. Serve a
 * distinguere «non so fare questa cosa» (proprietà permanente dell'agente, si
 * smette di chiedere) da «questa volta è andata male» (si riproverà).
 */
export function isMethodNotFound(err: unknown): boolean {
  return err instanceof JsonRpcRemoteError && err.code === RPC_METHOD_NOT_FOUND;
}
