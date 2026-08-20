/**
 * IL TURNO DEL 20/08 CHE È MORTO SENZA DIRE NIENTE.
 *
 * Ricostruzione, da `~/.claude/jarvis/logs/topics-server.log` e dal DB vivo:
 *
 *   19:08:47  l'utente scrive, parte il turno su topic:9f9e9629 (provider
 *             `topics`, il runtime NATIVO — il turno gira dentro il server).
 *   19:11:2x  fswatch vede un salvataggio in `server/`; `restart-when-idle`
 *             risponde 202 e comincia ad aspettare.
 *             `[quiescence] aspetto prima di riavviare — 1 chat in streaming
 *             (topic:9f9e9629)` — poi il cap CHAT di 60 s scade, e il cancello
 *             conclude «procedo, la reload-resilience li riprende».
 *   19:11:44  SIGTERM → `stopAllProviders()` → `NativeProvider.stop()` →
 *             `abort()` su ogni sessione viva.
 *   19:11:45  `activity_log`: «stream aborted by user». L'utente non aveva
 *             premuto niente.
 *
 * Quello che si è visto a schermo: «Ho capito il richiamo: **Nerissima
 * Serpe**…», una colonna di tool, e poi più niente. Nessun cartello, nessun
 * «Riprova», nessuna riga che spiegasse cos'era successo. Il turno non è stato
 * nemmeno riadottato, perché un turno nativo non ha un figlio da riadottare.
 *
 * Quattro difetti in fila, e ognuno da solo bastava a produrre il silenzio:
 *
 *   1. il ciclo dell'agente usciva MUTO sull'abort (nessun handler chiamato);
 *   2. il provider nativo etichettava ogni abort come `cause: "user"`;
 *   3. `finalizeStream` su `aborted` non scriveva mai niente, perché «l'utente
 *      sa già di aver premuto» — vero per l'utente, falso per tutti gli altri;
 *   4. il cancello di quiescenza dava alle chat l'attesa corta appoggiandosi su
 *      «tanto le riadottiamo», che per il runtime nativo è falso.
 *
 * Queste prove coprono 2, 3 e 4 al livello della DECISIONE, più 1 e 2 insieme
 * sul provider vero in `native/abort-cause.test.ts`.
 */
import { test, expect, describe } from "bun:test";
import { cancelledNotice, abortLogTitle } from "./cancelled-notice";
import type { TurnEndInfo } from "../providers/stop-reason";

describe("cancelledNotice — chi merita una spiegazione in chat", () => {
  /**
   * LA PROVA DEL 20/08. Con la regola vecchia (`aborted` ⇒ silenzio) questo
   * caso non produceva niente, ed è esattamente ciò che l'utente ha visto.
   */
  test("spegnimento del server: il cartello c'è, dice perché, e invita a rimandare", () => {
    const out = cancelledNotice({ end: "cancelled", cause: "server-shutdown" });
    expect(out).not.toBeNull();
    expect(out).toContain("riavviato");
    expect(out).toContain("Riprova");
    // Il prefisso è il contratto con il client: `turnError.ts` lo riconosce e
    // accende il banner ambra + il bottone. Senza, il testo resta prosa muta.
    expect(out!.startsWith("⚠️")).toBe(true);
  });

  /**
   * L'ALTRO VERSO, e conta quanto il primo: chi preme Ferma non deve leggersi
   * spiegato ciò che ha appena fatto, e la riga vuota che lascia dev'essere
   * ancora buttabile (`shared/empty-turn.ts` la butta solo se resta vuota).
   */
  test("stop premuto dall'umano: nessun cartello", () => {
    expect(cancelledNotice({ end: "cancelled", cause: "user" })).toBeNull();
  });

  test("watchdog e limite di tempo: due cartelli, due ragioni diverse", () => {
    const wd = cancelledNotice({ end: "cancelled", cause: "watchdog" });
    const wc = cancelledNotice({ end: "cancelled", cause: "wall-clock" });
    expect(wd).not.toBeNull();
    expect(wc).not.toBeNull();
    expect(wd).not.toBe(wc);
    expect(wd).toContain("segni di vita");
    expect(wc).toContain("limite di tempo");
  });

  /**
   * Un reset di sessione NON è una fine: il provider rispawna e rimanda lo
   * stesso turno. Un cartello qui annuncerebbe un guasto a chi sta per ricevere
   * la risposta — cioè il difetto simmetrico a quello che stiamo riparando.
   */
  test("session-reset e turn-in-flight non sono fini: nessun cartello", () => {
    expect(cancelledNotice({ end: "cancelled", cause: "session-reset" })).toBeNull();
    expect(cancelledNotice({ end: "cancelled", cause: "turn-in-flight" })).toBeNull();
  });

  /**
   * LA REGOLA DI DEFAULT È IL CUORE DELLA CORREZIONE, non un dettaglio.
   *
   * Il difetto del 20/08 aveva questa forma: un `cancelled` di provenienza non
   * dichiarata, trattato come se l'avesse chiesto l'utente. Se un domani
   * qualcuno annulla un turno da una strada nuova e si dimentica di dire chi è,
   * il sistema deve sbagliare verso il TROPPO detto, non verso il silenzio.
   */
  test("un annullamento senza causa dichiarata parla lo stesso", () => {
    const out = cancelledNotice({ end: "cancelled" });
    expect(out).not.toBeNull();
    expect(out).toContain("Riprova");
  });

  test("un turno che non è annullato non prende cartelli da qui", () => {
    const casi: TurnEndInfo[] = [
      { end: "end_turn" },
      { end: "max_tokens" },
      { end: "refusal" },
      { end: "error", cause: "provider-error" },
    ];
    for (const c of casi) expect(cancelledNotice(c)).toBeNull();
  });
});

describe("abortLogTitle — il registro non dà la colpa a chi non c'era", () => {
  /**
   * La riga vera trovata in `activity_log` il 20/08 alle 17:11:45Z diceva
   * «stream aborted by user» su uno spegnimento del server. Chi cercava la
   * causa partiva dal posto sbagliato.
   */
  test("spegnimento del server: il titolo lo nomina", () => {
    expect(abortLogTitle({ end: "cancelled", cause: "server-shutdown" }))
      .toBe("stream aborted by server shutdown");
  });

  test("lo stop a mano resta quello di sempre", () => {
    expect(abortLogTitle({ end: "cancelled", cause: "user" })).toBe("stream aborted by user");
  });

  test("watchdog e wall-clock non si travestono da utente", () => {
    expect(abortLogTitle({ end: "cancelled", cause: "watchdog" })).not.toContain("user");
    expect(abortLogTitle({ end: "cancelled", cause: "wall-clock" })).not.toContain("user");
  });

  /**
   * Nemmeno il caso ignoto attribuisce a una persona: «aborted» e basta è la
   * risposta onesta quando non si sa.
   */
  test("causa ignota: annullato, ma da nessuno in particolare", () => {
    expect(abortLogTitle({ end: "cancelled" })).toBe("stream aborted");
  });
});
