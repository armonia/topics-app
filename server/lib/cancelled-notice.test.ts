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
 *
 * @covers INTERRUPT-03
 */
import { test, expect, describe } from "bun:test";
import { avvisoPerTurno, cancelledNotice, abortLogTitle, eCartelloDiInterruzione, isResumableCause, CAUSE_NOSTRE } from "./cancelled-notice";
import type { TurnEndInfo } from "../providers/stop-reason";

describe("cancelledNotice — chi merita una spiegazione in chat", () => {
  /**
   * LA PROVA DEL 20/08. Con la regola vecchia (`aborted` ⇒ silenzio) questo
   * caso non produceva niente, ed è esattamente ciò che l'utente ha visto.
   */
  test("spegnimento del server: il cartello c'è e dice perché", () => {
    const out = cancelledNotice({ end: "cancelled", cause: "server-shutdown" });
    expect(out).not.toBeNull();
    expect(out).toContain("riavviato");
    // E NON promette un bottone: chi lo mostra è `turnIsOnlyError`, e su un
    // turno che ha già prodotto quel bottone non c'è. Vedi `avvisoPerTurno`.
    expect(out).not.toContain("Riprova");
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

  test("watchdog e tetto di inattivita': due cartelli, due ragioni diverse", () => {
    // This asserts the CONTRACT, not the sentence: two distinct causes must
    // produce two distinct, non-empty notices. This used to be
    // `toContain("limite di tempo")`, and that line blocked a legitimate fix on
    // 2026-08-21 (the cap had stopped counting time, so the sentence had become
    // false). A test that pins wording turns every honest rewrite into a red.
    const wd = cancelledNotice({ end: "cancelled", cause: "watchdog" });
    const wc = cancelledNotice({ end: "cancelled", cause: "wall-clock" });
    for (const c of [wd, wc]) {
      expect(c).not.toBeNull();
      expect((c ?? "").length).toBeGreaterThan(20);
    }
    expect(wd).not.toBe(wc);
  });

  test("ogni cartello che scriviamo OGGI e' riconosciuto: la lista non resta indietro", () => {
    // The list of recognised openings is explicit, because rows already in the
    // database carry OLDER wordings and a derived list would stop matching them.
    // THIS is what keeps it honest: reword a notice without adding the entry and
    // this goes red, instead of turns silently never restarting.
    for (const cause of CAUSE_NOSTRE) {
      const testo = cancelledNotice({ end: "cancelled", cause });
      expect(testo).not.toBeNull();
      expect(eCartelloDiInterruzione(testo)).toBe(true);
    }
    // And a cause that is NOT ours stays out: you do not guess who cancelled.
    expect(eCartelloDiInterruzione("⚠️ Turno annullato.")).toBe(false);
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
    expect(out!.startsWith("⚠️")).toBe(true);
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

/**
 * LA CODA DEL CARTELLO: cosa può farci chi legge.
 *
 * Nasce da una riga sola: «non vedo dall'app nessun riprova» (20/08). Il testo
 * citava sempre «Riprova», il client lo mostrava quasi mai — e la parte
 * sbagliata era il testo, non il client.
 */
describe("avvisoPerTurno — la coda dice il vero", () => {
  const spegnimento: TurnEndInfo = { end: "cancelled", cause: "server-shutdown" };

  test("turno che NON ha prodotto: il bottone c'è, e glielo si dice", () => {
    expect(avvisoPerTurno(spegnimento, { haProdotto: false })).toContain("«Riprova»");
  });

  test("turno che HA prodotto: niente bottone, quindi niente promessa", () => {
    // È il caso frequente, ed è quello che mentiva: rimandare un messaggio già
    // risposto a metà ne farebbe un secondo, a pagamento.
    const out = avvisoPerTurno(spegnimento, { haProdotto: true })!;
    expect(out).not.toContain("Riprova");
    expect(out).toContain("nuovo messaggio");
  });

  test("se riprende da solo non si chiede niente a nessuno", () => {
    for (const haProdotto of [true, false]) {
      const out = avvisoPerTurno(spegnimento, { haProdotto, riprendeDaSolo: true })!;
      expect(out).toContain("Riprendo da solo");
      expect(out).not.toContain("Riprova");
    }
  });

  test("chi non merita un cartello non ne prende uno nemmeno da qui", () => {
    expect(avvisoPerTurno({ end: "cancelled", cause: "user" }, { haProdotto: false })).toBeNull();
    expect(avvisoPerTurno({ end: "end_turn" }, { haProdotto: true })).toBeNull();
  });
});

/**
 * CHI MERITA UNA RIPRESA, letto dalla riga già salvata.
 *
 * La ripresa automatica al boot decideva su `blocks.some(b => b.kind ===
 * "error")`: qualunque verdetto di guasto. Misurato sul database vivo, sugli
 * ULTIMI messaggi di ogni sessione con un blocco `error`:
 *
 *     25 × «ai-bridge: ack timeout»
 *      4 × «Process exited with code»
 *      1 × «API 400»
 *
 * Nessuno è un'interruzione nostra. Sono guasti deterministici: rimandare il
 * messaggio ricompra lo stesso fallimento, e su un turno lungo riapre tutti i
 * giri di tool che aveva già fatto.
 *
 * Il predicato è volutamente STRETTO: un falso negativo lascia il cartello col
 * bottone «Riprova», che è reversibile; un falso positivo brucia un turno vero.
 */
describe("eCartelloDiInterruzione — cosa si riprende e cosa no", () => {
  test("i tre cartelli che nascono da un'interruzione nostra: sì", () => {
    for (const cause of ["server-shutdown", "watchdog", "wall-clock"] as const) {
      const testo = cancelledNotice({ end: "cancelled", cause })!;
      expect(eCartelloDiInterruzione(testo)).toBe(true);
    }
  });

  /**
   * I CINQUE TESTI VERI presi dal database. Erano tutti «riprendibili» con la
   * regola vecchia.
   */
  test("i guasti veri del database: no", () => {
    for (const guasto of [
      "ai-bridge: ack timeout (list, 5s)",
      "ai-bridge: ack timeout (spawn topic:f4841e2f, 20s)",
      "Process exited with code 1",
      "API 400",
      "Nessuna risposta: il turno si è chiuso senza produrre niente.",
      "Riadozione del turno non riuscita: ai-bridge: ack timeout",
    ]) {
      expect(eCartelloDiInterruzione(guasto)).toBe(false);
    }
  });

  /**
   * Un annullamento SENZA causa dichiarata prende un cartello (lo dice
   * `cancelledNotice`) ma NON si riprende: è la stessa regola di
   * `meritaRipresaAutomatica`, e per la stessa ragione — non si indovina chi ha
   * annullato.
   */
  test("il cartello generico non è un lasciapassare per la ripresa", () => {
    const testo = cancelledNotice({ end: "cancelled" })!;
    expect(testo).toBeTruthy();
    expect(eCartelloDiInterruzione(testo)).toBe(false);
  });

  test("lo stop a mano non ha cartello, quindi non si riprende", () => {
    expect(cancelledNotice({ end: "cancelled", cause: "user" })).toBeNull();
    expect(eCartelloDiInterruzione(null)).toBe(false);
    expect(eCartelloDiInterruzione("")).toBe(false);
  });

  /** Il prefisso ⚠️ può esserci o no: la riga in `content` lo porta, il blocco no. */
  test("funziona con e senza il prefisso ⚠️", () => {
    const withPrefix = cancelledNotice({ end: "cancelled", cause: "server-shutdown" })!;
    expect(eCartelloDiInterruzione(withPrefix)).toBe(true);
    expect(eCartelloDiInterruzione(withPrefix.replace(/^⚠️\s*/, ""))).toBe(true);
  });
});

describe("a turn cut by the output cap is not a finished turn", () => {
  /**
   * 2026-08-28, topic:4c935add, three times out of three. The model was writing a
   * whole document inside the argument of a `write_file`, blew through
   * `max_tokens` halfway into the JSON, and the round exited as if it had
   * finished. NOTHING appeared in the chat: no notice, no explanation, and the
   * file the user was waiting for did not exist. `cancelledNotice` stays silent
   * on everything that is not `cancelled`, and nobody had ever asked what happens
   * when a turn ends cut instead of cancelled.
   */
  test("it says so, instead of staying silent", () => {
    const a = avvisoPerTurno({ end: "max_tokens" }, { haProdotto: false });
    expect(a).toContain("tagliata");
    expect(a).toContain("limite di lunghezza");
  });

  test("it does NOT promise \"Riprova\", which is the wrong advice here", () => {
    // Resending the same message blows through the same cap: the button would
    // retry the road that just failed.
    const a = avvisoPerTurno({ end: "max_tokens" }, { haProdotto: false });
    expect(a).not.toContain("Riprova");
    expect(a).toContain("pezzi");
  });

  test("if something had arrived, it says so and asks for the rest a piece at a time", () => {
    const a = avvisoPerTurno({ end: "max_tokens" }, { haProdotto: true });
    expect(a).toContain("resta qui sotto");
    expect(a).toContain("un pezzo alla volta");
  });

  test("a turn that finished normally keeps no notice at all", () => {
    expect(avvisoPerTurno({ end: "end_turn" }, { haProdotto: true })).toBeNull();
  });
});

/**
 * The plan's limit is an interruption of OURS: the notice says so, names the
 * hour when there is one, and the resume recognises it.
 *
 * @covers RESUME-04, INTERRUPT-03
 */
describe("il limite dell'API", () => {
  test("il cartello sostituisce il testo grezzo ed e' riconosciuto come nostro", () => {
    const testo = avvisoPerTurno({ end: "error", cause: "rate-limit", detail: "API 429: {...} (retried 27 times over 1655s without success)" }, { haProdotto: true });
    expect(testo).not.toBeNull();
    expect(testo!.startsWith("⚠️")).toBe(true);
    expect(testo).not.toMatch(/Riprova/);
    expect(eCartelloDiInterruzione(testo)).toBe(true);
  });

  test("con l'ora del reset, il cartello la dice", () => {
    const testo = avvisoPerTurno({ end: "error", cause: "rate-limit", detail: "API 429: usage window exhausted, resets at 2026-09-04T20:49:59.852Z" }, { haProdotto: false });
    expect(testo).toMatch(/fino alle \d{2}:\d{2}/);
    expect(eCartelloDiInterruzione(testo)).toBe(true);
  });

  test("un errore vero del provider resta muto qui: la sua riga e' il testo dell'errore", () => {
    expect(avvisoPerTurno({ end: "error", cause: "provider-error", detail: "API 400" }, { haProdotto: true })).toBeNull();
    // And the raw API text is NOT an interruption of ours: never resumed by itself.
    expect(eCartelloDiInterruzione('API 429: {"type":"error"} (retried 27 times over 1655s without success)')).toBe(false);
  });
});

describe("il taglio dello sweeper e la causa sul blocco: entrambi si riprendono", () => {
  test("il cartello dello sweeper è riconosciuto dal testo, con o senza il prefisso", () => {
    expect(eCartelloDiInterruzione("⚠️ Risposta interrotta: nessuna attività per 3 minuti (il processo potrebbe essersi bloccato o disconnesso). Riprende da solo entro pochi minuti.")).toBe(true);
    expect(eCartelloDiInterruzione("Risposta interrotta: nessuna attività per 3 minuti.")).toBe(true);
  });

  test("le cause nostre, il limite dell'API e il tetto dei tool si riprendono; l'umano e un guasto no", () => {
    for (const c of CAUSE_NOSTRE) expect(isResumableCause(c)).toBe(true);
    expect(isResumableCause("rate-limit")).toBe(true);
    expect(isResumableCause("tool-budget")).toBe(true);
    expect(isResumableCause("user")).toBe(false);
    expect(isResumableCause("provider-error")).toBe(false);
    expect(isResumableCause("process-died")).toBe(false);
    expect(isResumableCause(undefined)).toBe(false);
  });
});
