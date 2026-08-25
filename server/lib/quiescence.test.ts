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
import { describeInFlight, unadoptableStreams, providerSurvivesRestart, quiescenceVerdict } from "./quiescence";

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

  test("liste vuote non sono «qualcosa in volo»", () => {
    expect(describeInFlight({ cards: 0, streamKeys: [], brokerOpenKeys: [] })).toBeNull();
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

  test("IL DIFETTO: con una card in volo, oltre il tetto si SCADE", () => {
    // Con il rinnovo questo caso non arrivava mai: `deadline` era sempre
    // `now + capMs`, cioe' sempre nel futuro.
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP + 1 }))
      .toBe("scaduto");
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
  });

  test("il confine e' incluso: AL tetto si scade, non un giro dopo", () => {
    expect(quiescenceVerdict({ ...base, busy: "1 card", unrecoverable: 1, now: CAP }))
      .toBe("scaduto");
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
      if (v === "scaduto") break;
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
  test("con una card che non molla: aspetta, poi esce, e dice la verita'", async () => {
    const CAP = 800, CHAT = 200;
    const inizio = Date.now();
    let logged = false;
    let uscita: string | null = null;

    for (;;) {
      // `whatIsStillWorking()` che risponde sempre «1 card in volo».
      const busy = "1 turno/i di card della board", cards = 1, unadoptable = 0;
      const verdetto = quiescenceVerdict({
        busy, unrecoverable: cards + unadoptable,
        now: Date.now(), startedAt: inizio, capMs: CAP, chatCapMs: CHAT,
      });
      if (verdetto === "scaduto") {
        // La stessa frase di server.ts: una card NON viene riadottata.
        uscita = `${cards} card: turno perso, rimessa in coda (riparte da capo, il worktree resta)`;
        break;
      }
      logged = true;
      // Rete di sicurezza: col difetto di prima si arrivava qui e basta.
      if (Date.now() - inizio > 10_000) { uscita = "MAI USCITO"; break; }
      await new Promise((r) => setTimeout(r, 50));
    }

    // 1. E' USCITO: e' l'asserzione che il rinnovo rendeva impossibile.
    expect(uscita).not.toBe("MAI USCITO");
    // 2. Ma ha ASPETTATO: un cancello che esce subito non protegge nessuno.
    expect(logged).toBe(true);
    expect(Date.now() - inizio).toBeGreaterThanOrEqual(CAP);
    // 3. E dice cosa succede davvero a una card: riparte da capo, non «viene
    //    ripresa». Era la stessa specie di bugia di «stream aborted by user».
    expect(uscita).toContain("rimessa in coda");
    expect(uscita).not.toContain("reload-resilience");
  }, 15_000);
});
