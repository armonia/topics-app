/**
 * Il cancello di `restart-when-idle` guardava solo le CARD della board.
 *
 * Le tre prove che contano sono le tre fonti prese una alla volta: la seconda e
 * la terza sono quelle che prima non esistevano, e sono rosse contro
 * l'implementazione vecchia (`while (busyCount() > 0)`) per costruzione — con
 * `cards: 0` quel predicato usciva subito, cioè `null`, cioè «riavvia pure».
 *
 * @covers HOLD-05
 */
import { test, expect, describe } from "bun:test";
import { describeInFlight, unadoptableStreams, providerSurvivesRestart, quiescenceVerdict, reloadHeldNotice } from "./quiescence";

const nothing = { cards: 0, streamKeys: [], brokerOpenKeys: [] };

describe("describeInFlight — che cosa trattiene un riavvio pianificato", () => {
  test("niente in volo ⇒ null, ed è l'unica risposta che autorizza il riavvio", () => {
    expect(describeInFlight(nothing)).toBeNull();
  });

  test("una card della board trattiene", () => {
    const out = describeInFlight({ ...nothing, cards: 3 });
    expect(out).toContain("3");
    expect(out).toContain("card");
  });

  /**
   * IL BUCO STORICO #1: una chat umana non è una card. `activeStreams` è
   * popolata da `startStream` per OGNI turno, dispacciato o no, ma il cancello
   * non la guardava. Con la logica vecchia questo caso valeva «idle».
   */
  test("una chat che sta streammando in questo processo trattiene", () => {
    const out = describeInFlight({ ...nothing, streamKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("streaming");
  });

  /**
   * IL BUCO STORICO #2, ed è il più insidioso: dopo un riavvio il turno vivo NON
   * ha nessuna rappresentazione in questo processo. La gamba di riadozione si
   * chiude in un attimo e `endStream` toglie la voce da `activeStreams`; da lì
   * in poi card e stream dicono «fermo» ed è vero — il figlio CLI però sta
   * ancora lavorando, e solo il broker lo sa.
   */
  test("un turno adottato, visibile SOLO al broker, trattiene", () => {
    const out = describeInFlight({ ...nothing, brokerOpenKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("broker");
  });

  test("più fonti insieme: si nomina la più economica e più certa", () => {
    const out = describeInFlight({ cards: 2, streamKeys: ["topic:aaa"], brokerOpenKeys: ["topic:bbb"] });
    // La frase finisce in un log letto da chi si chiede perché il suo
    // salvataggio non è ancora in produzione: una fonte sola, la prima.
    expect(out).toContain("card");
    expect(out).not.toContain("topic:aaa");
    expect(out).not.toContain("topic:bbb");
  });

  /**
   * HISTORICAL HOLE #4, and it is the one the other three cannot see BY
   * CONSTRUCTION: they all answer "who is working", and a chat parked on a
   * question is not working - it is waiting for a person. On 2026-08-28 at
   * 19:05, topic:4c935add, an open panel with two questions died with the turn
   * while the log of that same window shows deferrals for the board cards and
   * none for the chat.
   */
  test("una chat ferma su una domanda trattiene", () => {
    const out = describeInFlight({ ...nothing, askOpenKeys: ["topic:4c935add"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:4c935add");
    expect(out).toContain("domanda");
  });

  test("liste vuote non sono «qualcosa in volo»", () => {
    expect(describeInFlight({ cards: 0, streamKeys: [], brokerOpenKeys: [] })).toBeNull();
    expect(describeInFlight({ cards: 0, streamKeys: [], brokerOpenKeys: [], askOpenKeys: [] })).toBeNull();
  });
});

/**
 * IL BUCO STORICO #3, ed è quello che ha ucciso topic:9f9e9629 il 20/08.
 *
 * Il cancello distingueva due categorie — card e chat — e dava alle chat
 * l'attesa corta appoggiandosi su una promessa: «la reload-resilience la
 * riadotta». Quella promessa la mantiene solo un turno che gira in un processo
 * FIGLIO: il SIGTERM non lo tocca, il broker lo tiene, al riavvio torna.
 *
 * Un turno del runtime nativo `topics` gira DENTRO il processo del server.
 * Quando il processo muore non c'è nessun figlio da riadottare: la promessa è
 * falsa, e il danno è identico a quello di una card tagliata — lavoro perso,
 * senza ritorno. Nel log del 20/08: `[quiescence] aspetto prima di riavviare —
 * 1 chat in streaming (topic:9f9e9629)`, sessanta secondi, SIGTERM, e una
 * risposta rimasta a metà frase.
 *
 * La categoria giusta quindi non è «chat vs card»: è «sopravvive vs non
 * sopravvive».
 */
describe("unadoptableStreams — quali chat NON tornano dopo un riavvio", () => {
  const s = (sessionKey: string, survivesRestart: boolean) => ({ sessionKey, survivesRestart });

  test("una chat su un provider che sa riadottare non trattiene a lungo", () => {
    expect(unadoptableStreams([s("topic:aaa", true)])).toEqual([]);
  });

  test("LA CHAT DEL 20/08: runtime nativo, nessuna riadozione possibile", () => {
    expect(unadoptableStreams([s("topic:9f9e9629", false)])).toEqual(["topic:9f9e9629"]);
  });

  test("si guarda una sessione alla volta: le due specie convivono", () => {
    expect(unadoptableStreams([s("topic:cli", true), s("topic:nativa", false)]))
      .toEqual(["topic:nativa"]);
  });

  test("nessuno stream, niente da trattenere", () => {
    expect(unadoptableStreams([])).toEqual([]);
  });
});

/**
 * IL PREDICATO A MONTE: chi decide `survivesRestart` quando lo stream nasce.
 *
 * Si chiede al provider e non al suo NOME. Un elenco di nomi ("topics" e' fragile,
 * "claude-code" e' solido) sarebbe una tabella da aggiornare a ogni runtime
 * nuovo, e il runtime che qualcuno dimenticasse di aggiungerci erediterebbe in
 * silenzio l'attesa corta — cioe' il difetto del 20/08 daccapo, con un altro
 * nome. `reattach` non e' un indizio del fatto che il turno sopravvive: e' il
 * metodo che lo fa sopravvivere.
 */
describe("providerSurvivesRestart — la domanda si fa al provider, non al nome", () => {
  test("chi sa riadottare sopravvive", () => {
    expect(providerSurvivesRestart({ reattach: async () => "live" })).toBe(true);
  });

  test("chi non sa riadottare no: il turno vive nel processo del server", () => {
    expect(providerSurvivesRestart({})).toBe(false);
  });

  test("un provider assente non promette niente", () => {
    expect(providerSurvivesRestart(undefined)).toBe(false);
    expect(providerSurvivesRestart(null)).toBe(false);
  });

  /**
   * Il campo c'e' ma non e' chiamabile: e' una promessa che nessuno puo'
   * mantenere, e vale come assente.
   */
  test("un `reattach` che non e' una funzione non conta", () => {
    expect(providerSurvivesRestart({ reattach: true })).toBe(false);
  });
});

/**
 * IL TETTO CHE NON SCADEVA MAI — il difetto che ha ucciso il task 235afe11.
 *
 * La regola stava dentro il `for(;;)` di `waitForDispatcherQuiescent`, e la
 * scadenza si RINNOVAVA a ogni giro con del lavoro in volo:
 *
 *     deadline = Math.max(deadline, Date.now() + capMs)
 *
 * Con una card sempre presente quella riga rimandava la scadenza per sempre.
 * Non era un tetto: era una promessa infinita. E siccome `start-prod.sh` il suo
 * orologio ce l'aveva davvero (1530s dall'inizio, poi SIGTERM), a decidere
 * finiva sempre lui — su un turno d'agente vivo.
 *
 * Il 20/08 il task 235afe11 e' stato ucciso TRE volte, a 27 minuti esatti
 * l'una dall'altra: 17:55 → 18:22 → 18:51 → 19:18. Ogni volta worktree buttato
 * e task rimesso in coda. Nel log del cancello non c'e' una sola riga di
 * scadenza in tutta la sua storia — non poteva averne.
 *
 * Il primo test qui sotto e' quello che il difetto rendeva IMPOSSIBILE da
 * superare: dopo il tetto, con del lavoro ancora in volo, si deve scadere.
 */
describe("quiescenceVerdict — il tetto dell'attesa e' un tetto vero", () => {
  const CAP = 25 * 60_000;
  const CHAT = 60_000;
  const base = { startedAt: 0, capMs: CAP, chatCapMs: CHAT };

  /**
   * The cap is real - the verdict changes when promised - but it is not a
   * death sentence. With the old renewal this case never arrived: `deadline`
   * was always `now + capMs`, always in the future. The cap expires; what lies
   * on the other side is a DEFERRAL, not a cut.
   */
  test("con una card in volo, oltre il tetto si RINVIA", () => {
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP + 1 }))
      .toBe("rinvia");
  });

  /**
   * THE NEW INVARIANT, and the reason for all the rest: a clock never kills
   * work that does not come back.
   *
   * Before, the deadline went ahead regardless. On 2026-08-28, topic:0299ac2d,
   * the log shows it in two consecutive lines: the stream had been silent for
   * a minute, the gate counted it in flight for 1500s and restarted anyway,
   * and the chat was left holding "turn interrupted by a server restart".
   * Whoever waits on a turn nobody will re-adopt must keep waiting: the window
   * arrives, and meanwhile the deferral is visible in the log.
   */
  test("un turno che non torna non viene MAI tagliato dall'orologio", () => {
    for (const now of [CAP, CAP + 1, CAP * 2, CAP * 100, CAP * 10_000]) {
      expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now }))
        .not.toBe("scaduto");
    }
  });

  test("prima del tetto si aspetta, anche a lungo", () => {
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP - 1 }))
      .toBe("aspetta");
  });

  test("niente in volo: si procede subito, senza aspettare nessun tetto", () => {
    expect(quiescenceVerdict({ ...base, busy: null, unrecoverable: 0, now: 0 }))
      .toBe("procedi");
  });

  /**
   * Le due attese restano DUE, ed e' il punto di tutto il meccanismo: una chat
   * riadottabile non merita 25 minuti (il hot-reload morirebbe per chiunque
   * abbia una conversazione aperta), una card si'.
   */
  test("una chat riadottabile ha il tetto CORTO", () => {
    expect(quiescenceVerdict({ ...base, busy: "1 chat", unrecoverable: 0, now: CHAT + 1 }))
      .toBe("scaduto");
    // Alla stessa ora, una card starebbe ancora aspettando.
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CHAT + 1 }))
      .toBe("aspetta");
    // The difference is not only duration: a re-adoptable chat gets cut, a
    // card does not. What comes back on its own may be interrupted.
  });

  test("il confine e' incluso: AL tetto il verdetto cambia, non un giro dopo", () => {
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP - 1 }))
      .toBe("aspetta");
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP }))
      .toBe("rinvia");
  });

  /**
   * A QUESTION IS NEVER CUT BY THE CLOCK, and it does not wait out the cap
   * first either.
   *
   * The cap asks "how long can this finish by itself?" and an open question
   * never can: what ends it is a person. Serving the cap would only mean that
   * for those minutes the deferral is not declared and the heartbeat that
   * holds off `start-prod.sh` is not written - so the script's own SIGTERM
   * would cut the panel anyway, which is exactly what happened on 2026-08-28.
   */
  test("una domanda aperta, e nient'altro in volo, si RINVIA", () => {
    for (const now of [0, CHAT, CHAT + 1, CAP, CAP * 100]) {
      expect(quiescenceVerdict({
        ...base, busy: "1 chat ferma su una domanda", unrecoverable: 0, parkedAsks: 1, now,
      })).toBe("rinvia");
    }
  });

  /**
   * THE OTHER HALF, or it is a block instead of a deferral: once answered, the
   * question stops holding anything and the ordinary caps take over again.
   */
  test("una domanda RISPOSTA non trattiene piu' il riavvio", () => {
    expect(quiescenceVerdict({
      ...base, busy: "1 chat", unrecoverable: 0, parkedAsks: 0, now: CHAT + 1,
    })).toBe("scaduto");
    expect(quiescenceVerdict({
      ...base, busy: null, unrecoverable: 0, parkedAsks: 0, now: CHAT + 1,
    })).toBe("procedi");
  });

  /**
   * LA PROVA CHE IL RINNOVO NON PUO' TORNARE. Si simula il loop vero: giri da
   * mezzo secondo con del lavoro sempre in volo. Con la riga di prima questo
   * test non terminava (la scadenza scappava in avanti a ogni giro); ora
   * l'attesa finisce, e finisce QUANDO promesso.
   */
  test("un loop con lavoro sempre presente ARRIVA a scadenza", () => {
    let now = 0;
    let giri = 0;
    for (;;) {
      const v = quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now });
      if (v === "rinvia") break;
      now += 500;
      if (++giri > 10_000) throw new Error("l'attesa non e' mai scaduta: il rinnovo e' tornato");
    }
    // 25 minuti a mezzo secondo per giro.
    expect(giri).toBe(CAP / 500);
    expect(now).toBeGreaterThanOrEqual(CAP);
  });
});

/**
 * IL LOOP INTERO, in tempo reale — non la sola aritmetica del verdetto.
 *
 * I test qui sopra provano la REGOLA con un `now` iniettato: dimostrano che il
 * tetto e' calcolato bene, non che il cancello si fermi davvero. La differenza
 * conta, perche' il difetto del 20/08 non era un'aritmetica sbagliata: era un
 * loop che non usciva. Con `deadline = max(deadline, now + capMs)` questo test
 * non terminava affatto — girava finche' non lo ammazzava il timeout.
 *
 * Qui il tempo scorre davvero (cap accorciato a 800ms al posto di 25 minuti) e
 * si riproduce la forma esatta del loop di `waitForDispatcherQuiescent`,
 * compresa la frase che scrive uscendo: una card che non finisce mai, cioe' il
 * caso del task 235afe11.
 */
describe("il cancello, in tempo reale", () => {
  const CAP = 800, CHAT = 200;

  /** The exact shape of the `waitForDispatcherQuiescent` loop. */
  async function runGate(stillWorking: () => number) {
    const inizio = Date.now();
    let waited = false;
    let deferrals = 0;
    for (;;) {
      const cards = stillWorking();
      const busy = cards > 0 ? `${cards} turno/i di card della board` : null;
      const verdetto = quiescenceVerdict({
        busy, unrecoverable: cards,
        now: Date.now(), startedAt: inizio, capMs: CAP, chatCapMs: CHAT,
      });
      if (verdetto === "procedi") return { exit: "quiescente", deferrals, waited, ms: Date.now() - inizio };
      if (verdetto === "scaduto") return { exit: "tagliato", deferrals, waited, ms: Date.now() - inizio };
      if (verdetto === "rinvia") deferrals += 1;
      waited = true;
      if (Date.now() - inizio > 6_000) return { exit: "appeso", deferrals, waited, ms: Date.now() - inizio };
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * THE 2026-08-28 CASE. A card that will not let go must NEVER produce a cut:
   * before, at 1500s, the gate restarted anyway and the chat was left holding
   * "turn interrupted by a server restart".
   */
  test("una card che non molla viene RINVIATA, non tagliata", async () => {
    const out = await runGate(() => 1);
    expect(out.exit).not.toBe("tagliato");
    // The deferral is not mute: past the cap, every loop declares it.
    expect(out.deferrals).toBeGreaterThan(0);
  }, 15_000);

  /**
   * And the deferral is not a block: the moment the work ends, the restart
   * goes. This is the half that makes the absence of a second cap acceptable.
   */
  test("finito il lavoro, il riavvio parte da solo", async () => {
    const inizio = Date.now();
    // The card lets go AFTER the cap, so the gate must have crossed it.
    const out = await runGate(() => (Date.now() - inizio > CAP * 2 ? 0 : 1));
    expect(out.exit).toBe("quiescente");
    expect(out.waited).toBe(true);
    expect(out.deferrals).toBeGreaterThan(0);
    expect(out.ms).toBeGreaterThanOrEqual(CAP);
  }, 15_000);

  /**
   * What comes back is still cut: a re-adoptable chat restarts by itself, and
   * waiting for it like a card would kill hot reload for anyone with a
   * conversation open.
   */
  test("una chat riadottabile si taglia ancora, al suo tetto corto", async () => {
    const inizio = Date.now();
    let uscita: string | null = null;
    for (;;) {
      const verdetto = quiescenceVerdict({
        busy: "1 chat in streaming", unrecoverable: 0,
        now: Date.now(), startedAt: inizio, capMs: CAP, chatCapMs: CHAT,
      });
      if (verdetto === "scaduto") { uscita = "tagliato"; break; }
      if (Date.now() - inizio > 6_000) { uscita = "MAI USCITO"; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(uscita).toBe("tagliato");
    expect(Date.now() - inizio).toBeGreaterThanOrEqual(CHAT);
  }, 15_000);
});

/**
 * THE CAP CALLS A PERSON, instead of cutting.
 *
 * `quiescenceVerdict` never returns "scaduto" for work that will not come back,
 * and that invariant stands. Its price is a wait with no end of its own: on
 * 2026-08-30 a restart was deferred for 4599 seconds across 102 log lines, held
 * by a chat whose `bash` had started a server in the foreground. Nobody knew
 * until someone read the file.
 */
describe("reloadHeldNotice — oltre il tetto il cancello parla", () => {
  const CAP = 25 * 60_000;
  const base = { capMs: CAP, busy: "1 chat in streaming (topic:0299ac2d)", waitId: "w1" };

  test("prima del tetto non dice niente: l attesa e ancora normale", () => {
    expect(reloadHeldNotice({ ...base, waitedMs: 0 })).toBeNull();
    expect(reloadHeldNotice({ ...base, waitedMs: CAP - 1 })).toBeNull();
  });

  test("AL tetto avvisa, e dice da quanto", () => {
    const n = reloadHeldNotice({ ...base, waitedMs: CAP });
    expect(n).not.toBeNull();
    expect(n!.body).toContain("25 minuti");
  });

  test("nomina la chat quando il nome si conosce, altrimenti ripiega su cosa trattiene", () => {
    const conNome = reloadHeldNotice({ ...base, waitedMs: CAP, holderName: "Rotating Image Gallery" });
    expect(conNome!.body).toContain("«Rotating Image Gallery»");
    const nameless = reloadHeldNotice({ ...base, waitedMs: CAP, holderName: "   " });
    expect(nameless!.body).toContain("topic:0299ac2d");
  });

  test("la chiave del dedup distingue DUE attese: la prossima puo avvisare di nuovo", () => {
    const a = reloadHeldNotice({ ...base, waitedMs: CAP })!;
    const b = reloadHeldNotice({ ...base, waitId: "w2", waitedMs: CAP })!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  test("non promette un taglio: dice che il riavvio NON taglia", () => {
    const n = reloadHeldNotice({ ...base, waitedMs: CAP * 4 })!;
    expect(n.body).toContain("non taglia");
  });
});

/**
 * IL GESTO GIUSTO DIPENDE DA CHI TRATTIENE.
 *
 * The same body for both holders sent whoever read it to press Stop on a chat
 * whose only correct move was answering the question on screen: the notice
 * destroyed the very turn the gate was protecting (card 6c2dc14c).
 */
describe("reloadHeldNotice - domanda o turno, due gesti diversi", () => {
  const CAP = 25 * 60_000;
  const base = { capMs: CAP, busy: "1 chat ferma su una domanda (topic:abc)", waitId: "w9", waitedMs: CAP };

  test("con un holder di tipo domanda chiede di RISPONDERE, non di fermare", () => {
    const n = reloadHeldNotice({ ...base, holderKind: "question" })!;
    expect(n.body).toContain("rispondi alla domanda");
    expect(n.body).not.toContain("fermalo dalla chat");
  });

  test("con un turno resta il corpo di prima", () => {
    const n = reloadHeldNotice({ ...base, holderKind: "turn" })!;
    expect(n.body).toContain("fermalo dalla chat");
    expect(reloadHeldNotice({ ...base })!.body).toBe(n.body);
  });
});
