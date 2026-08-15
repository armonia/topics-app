import { describe, test, expect } from "bun:test";
import {
  ROUTE_KEYS,
  ROUTE_BENCH_PORT_BASE,
  ROUTE_BENCH_PORT_SPAN,
  benchPortFor,
  budgetMs,
  corpusMismatch,
  median,
  regressions,
  unstableRoutes,
  machineTooLoaded,
  calibrationOutOfScale,
  CALIBRATION_KEY,
  type Baseline,
  type RouteKey,
} from "./check-route-latency";
import { readRouteFault, applyRouteFault } from "../server/lib/route-fault";

/**
 * Il cancello sulle latenze, provato sui numeri invece che sul server.
 *
 * Ogni prova qui sotto risponde a una domanda sola: «in quale caso questo
 * cancello mente?». Sono tre modi diversi di mentire, e vanno chiusi tutti e
 * tre:
 *   1. resta VERDE mentre una rotta e' peggiorata davvero;
 *   2. diventa ROSSO per il tremolio della macchina, e allora lo si spegne;
 *   3. confronta due misure prese su quantita' di dati diverse, e allora il
 *      numero non vuol dire niente in nessuna delle due direzioni.
 */

const baseline: Baseline = {
  tolerance_pct: 40,
  floor_ms: 1.5,
  noise_guard_pct: 60,
  samples: 15,
  corpus: { topics: 24, messages: 300, tasks: 40 },
  routes: {
    topics: { median_ms: 3 },
    topic_messages: { median_ms: 12 },
    all_boards_tasks: { median_ms: 4 },
    dispatch_capacity: { median_ms: 1 },
  },
};

const at = (v: Partial<Record<RouteKey, number>>): Record<RouteKey, number> =>
  Object.fromEntries(
    ROUTE_KEYS.map((k) => [k, v[k] ?? baseline.routes[k].median_ms]),
  ) as Record<RouteKey, number>;

describe("median", () => {
  test("un solo giro lento non sposta il numero", () => {
    // E' l'intera ragione per cui si usa la mediana e non la media: su questi
    // campioni la media fa 21,4 ms e accuserebbe una regressione che non c'e'.
    const samples = [3.0, 3.1, 3.0, 2.9, 3.2, 3.1, 3.0, 2.8, 3.1, 190];
    expect(median(samples)).toBeLessThan(3.3);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(20);
  });

  test("serve che sia lenta META' delle chiamate perche' la mediana si muova", () => {
    expect(median([3, 3, 3, 3, 3, 50, 50, 50, 50, 50])).toBeGreaterThanOrEqual(3);
    expect(median([3, 3, 3, 50, 50, 50, 50])).toBe(50);
  });

  test("zero campioni non produce un numero finto", () => {
    expect(() => median([])).toThrow();
  });
});

describe("budgetMs", () => {
  test("sotto il millisecondo comanda il pavimento, non la percentuale", () => {
    // 0,5 ms + 40% = 0,7 ms: qualunque macchina lo supera per caso. Il pavimento
    // porta il tetto a 2,0 ms, che e' l'unica soglia con un significato.
    expect(budgetMs(0.5, 40, 1.5)).toBeCloseTo(2.0, 5);
  });

  test("sui numeri grandi comanda la percentuale", () => {
    expect(budgetMs(100, 40, 1.5)).toBeCloseTo(140, 5);
  });
});

describe("regressions", () => {
  test("verde quando le rotte stanno dove erano", () => {
    expect(regressions(at({}), baseline)).toEqual([]);
  });

  test("verde sul tremolio: +1 ms su una rotta da 3 ms non e' una notizia", () => {
    expect(regressions(at({ topics: 4 }), baseline)).toEqual([]);
  });

  test("ROSSO quando una rotta prende 40 ms in piu'", () => {
    // E' esattamente cio' che fa il guasto sintetico del server
    // (TOPICS_ROTTE_FAULT_MS=40): la prova che il cancello sa dire di no.
    const bad = regressions(at({ topics: 43 }), baseline);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("topics");
    expect(bad[0]).toContain("43");
  });

  test("ROSSO su una rotta che raddoppia, anche se sono pochi millisecondi", () => {
    // 12 → 25 ms: nessun pavimento la salva, ed e' la forma di una query
    // diventata N+1 su una conversazione lunga.
    expect(regressions(at({ topic_messages: 25 }), baseline)).toHaveLength(1);
  });

  test("il guasto su /api/topics accende ENTRAMBE le rotte che iniziano cosi'", () => {
    // Il prefisso del guasto e' `/api/topics`, che comprende anche
    // `/api/topics/:id/messages`: il cancello deve nominarle tutte e due, non
    // fermarsi alla prima.
    const bad = regressions(at({ topics: 43, topic_messages: 52 }), baseline);
    expect(bad).toHaveLength(2);
  });

  test("una rotta senza baseline leggibile si DENUNCIA, non si salta", () => {
    // Il contratto e' cambiato, e con una ragione misurata: prima qui c'era
    // `if (base === undefined) continue`, e bastava rinominare una chiave,
    // metterla a null o QUOTARE il numero ("0.36") perche' quella rotta
    // smettesse di essere giudicata e il cancello uscisse 0. Una baseline che
    // non si sa leggere non e' «nessuna regressione»: e' un cancello disarmato.
    const lame = { ...baseline, routes: { ...baseline.routes } } as Baseline;
    delete (lame.routes as Record<string, unknown>).topics;
    const said = regressions(at({ topics: 900 }), lame);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("non puo' giudicare");
  });

  test("un numero QUOTATO nella baseline non spegne la rotta in silenzio", () => {
    // E' la forma piu' insidiosa: il JSON resta valido, la chiave c'e', e
    // `got > NaN` e' false per qualunque misura.
    const quoted = { ...baseline, routes: { ...baseline.routes } } as Baseline;
    (quoted.routes as Record<string, unknown>).topics = { median_ms: "0.36" };
    const said = regressions(at({ topics: 900 }), quoted);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("non puo' giudicare");
  });
});

describe("il tubo e' il metro: quando salta lui, non si misura niente", () => {
  // Il quarto modo di mentire, quello che mancava: la macchina e' lenta per
  // TUTTA la corsa, quindi le due passate si somigliano benissimo e il cancello
  // chiama regressione un numero che parla del portatile. Successo davvero il
  // 2026-08-14: `all_boards_tasks` a 8 ms contro 0,75 di baseline, identico su
  // un albero PRECEDENTE a ogni modifica di quel giorno.

  test("tubo a posto: non scatta, e una rotta peggiorata resta ROSSA", () => {
    // La meta' che conta: il guardiano non deve diventare una scusa. Con il tubo
    // dove deve stare, il giudizio sulle altre rotte e' quello di prima.
    expect(calibrationOutOfScale(at({}), baseline)).toBeNull();
    expect(calibrationOutOfScale(at({ topics: 43 }), baseline)).toBeNull();
    expect(regressions(at({ topics: 43 }), baseline)).toHaveLength(1);
  });

  test("tubo fuori scala: scatta, e riporta misura, tetto e baseline", () => {
    // baseline 1 ms, tolleranza 40%, pavimento 1,5 ms -> tetto 2,5 ms.
    const outOfScale = calibrationOutOfScale(at({ [CALIBRATION_KEY]: 9 }), baseline);
    expect(outOfScale).not.toBeNull();
    expect(outOfScale!.measuredMs).toBe(9);
    expect(outOfScale!.baselineMs).toBe(1);
    expect(outOfScale!.capMs).toBe(budgetMs(1, baseline.tolerance_pct, baseline.floor_ms));
  });

  test("il tubo dentro il tetto NON scatta, nemmeno al pelo", () => {
    const cap = budgetMs(1, baseline.tolerance_pct, baseline.floor_ms);
    expect(calibrationOutOfScale(at({ [CALIBRATION_KEY]: cap }), baseline)).toBeNull();
    expect(calibrationOutOfScale(at({ [CALIBRATION_KEY]: cap + 0.01 }), baseline)).not.toBeNull();
  });

  test("una macchina lenta alza TUTTO, e la risposta e' 2 e non 1", () => {
    // La forma vera del guasto: ogni rotta gonfiata, tubo compreso. Prima
    // usciva 1 («regressione») su tre rotte; ora il tubo dice che non si misura.
    const loaded = at({ topics: 9, topic_messages: 30, all_boards_tasks: 12, dispatch_capacity: 6 });
    expect(regressions(loaded, baseline).length).toBeGreaterThan(0); // il vecchio verdetto
    expect(calibrationOutOfScale(loaded, baseline)).not.toBeNull(); // ma il metro e' saltato
  });
});

describe("unstableRoutes", () => {
  test("due passate che si somigliano sono confrontabili", () => {
    expect(unstableRoutes(at({ topics: 3.0 }), at({ topics: 3.2 }), 60, 1.5)).toEqual([]);
  });

  test("due passate lontane fermano il giudizio invece di accusare qualcuno", () => {
    const shaky = unstableRoutes(at({ topic_messages: 12 }), at({ topic_messages: 40 }), 60, 1.5);
    expect(shaky).toHaveLength(1);
    expect(shaky[0]).toContain("topic_messages");
  });

  test("un guasto COSTANTE non passa per instabilita': le due passate concordano", () => {
    // La differenza fra «la macchina trema» e «la rotta e' lenta» e' tutta qui.
    // Con il ritardo sintetico armato entrambe le passate misurano lo stesso
    // numero alto, quindi il cancello deve dire regressione (uscita 1), non
    // «non confrontabile» (uscita 2).
    const a = at({ topics: 43.1 });
    const b = at({ topics: 43.4 });
    expect(unstableRoutes(a, b, 60, 1.5)).toEqual([]);
    expect(regressions(at({ topics: Math.max(43.1, 43.4) }), baseline)).toHaveLength(1);
  });
});

describe("corpusMismatch", () => {
  test("stesso corpus, nessuna obiezione", () => {
    expect(corpusMismatch({ topics: 24, messages: 300, tasks: 40 }, baseline.corpus)).toBeNull();
  });

  test("un database quasi vuoto non si confronta con una baseline piena", () => {
    // E' il modo piu' facile di certificare un verde che non e' mai stato
    // misurato: la semina fallisce a meta' e le rotte rispondono su niente.
    const gap = corpusMismatch({ topics: 24, messages: 0, tasks: 40 }, baseline.corpus);
    expect(gap).toContain("messages");
  });
});

describe("benchPortFor", () => {
  test("sta nella sua banda, lontano dalle porte della suite E2E e dalla 3333", () => {
    for (const path of ["/Users/x/topics-app", "/Users/x/.topics/worktrees/topics-app/wf_1", "/tmp/a/"]) {
      const p = benchPortFor(path);
      expect(p).toBeGreaterThanOrEqual(ROUTE_BENCH_PORT_BASE);
      expect(p).toBeLessThan(ROUTE_BENCH_PORT_BASE + ROUTE_BENCH_PORT_SPAN);
      expect(p).not.toBe(3333);
      expect(p).not.toBe(13334);
      // La banda degli shard e' 13500-13899, i loro tunnel 14334 e 14500-14899.
      expect(p).toBeGreaterThan(14899);
    }
  });

  test("stesso checkout, stessa porta (con o senza slash finale)", () => {
    expect(benchPortFor("/Users/x/topics-app")).toBe(benchPortFor("/Users/x/topics-app/"));
  });

  test("checkout diversi, porte diverse", () => {
    expect(benchPortFor("/Users/x/topics-app")).not.toBe(benchPortFor("/Users/x/topics-app-2"));
  });
});

describe("route-fault", () => {
  test("senza TOPICS_E2E il guasto NON si arma, per quanto lo si chieda", () => {
    // La condizione che tiene il ritardo lontano dal server di produzione.
    expect(readRouteFault({ TOPICS_ROTTE_FAULT_MS: "40" })).toBeNull();
    expect(readRouteFault({ TOPICS_E2E: "0", TOPICS_ROTTE_FAULT_MS: "40" })).toBeNull();
  });

  test("senza un ritardo positivo non si arma", () => {
    expect(readRouteFault({ TOPICS_E2E: "1" })).toBeNull();
    expect(readRouteFault({ TOPICS_E2E: "1", TOPICS_ROTTE_FAULT_MS: "0" })).toBeNull();
    expect(readRouteFault({ TOPICS_E2E: "1", TOPICS_ROTTE_FAULT_MS: "boh" })).toBeNull();
  });

  test("con entrambe le condizioni si arma sul prefisso chiesto", () => {
    expect(readRouteFault({ TOPICS_E2E: "1", TOPICS_ROTTE_FAULT_MS: "40" })).toEqual({
      delayMs: 40,
      pathPrefix: "/api/topics",
    });
    expect(
      readRouteFault({ TOPICS_E2E: "1", TOPICS_ROTTE_FAULT_MS: "5", TOPICS_ROTTE_FAULT_PATH: "/api/all-boards" }),
    ).toEqual({ delayMs: 5, pathPrefix: "/api/all-boards" });
  });

  test("il ritardo colpisce solo il prefisso, e da spento non costa niente", async () => {
    const fault = { delayMs: 30, pathPrefix: "/api/topics" };

    const t0 = performance.now();
    await applyRouteFault("/api/all-boards/tasks", fault);
    expect(performance.now() - t0).toBeLessThan(15);

    const t1 = performance.now();
    await applyRouteFault("/api/topics/abc/messages", fault);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(25);

    const t2 = performance.now();
    await applyRouteFault("/api/topics", null);
    expect(performance.now() - t2).toBeLessThan(15);
  });
});

describe("la baseline non si registra da una macchina carica", () => {
  // Il guasto e' stato RIPRODOTTO, non temuto: con load average 5,32 su questo
  // Mac il banco ha scritto `all_boards_tasks` a 9,87 ms dove a macchina ferma
  // sta a 0,75. Tredici volte, e le due passate erano d'accordo - quindi la
  // guardia sull'instabilita' taceva. Il confronto A-contro-B vede il tremolio,
  // non il carico UNIFORME, e una baseline gonfiata disarma il cancello per
  // sempre invece di allargarlo un po'.
  test("sopra mezzo core occupato si rifiuta", () => {
    expect(machineTooLoaded(5.32, 12)).toBe(false);   // 0,44: sotto, e infatti quella run passo'
    expect(machineTooLoaded(7.0, 12)).toBe(true);     // 0,58
    expect(machineTooLoaded(6.0, 4)).toBe(true);      // 1,5
  });

  test("una macchina ferma non viene mai fermata", () => {
    expect(machineTooLoaded(0, 12)).toBe(false);
    expect(machineTooLoaded(1.2, 12)).toBe(false);
  });

  test("zero core non fa esplodere il conto (divisione per zero)", () => {
    expect(machineTooLoaded(1, 0)).toBe(true);        // 1/1: si rifiuta, non NaN
    expect(machineTooLoaded(0.1, 0)).toBe(false);
  });
});

describe("il pavimento lo detta il RUMORE, non una costante", () => {
  // Il conto che l'avversario aveva fatto sulla prima versione: con 1,5 ms
  // uguali per tutti, `/api/topics` (0,36 ms) prendeva un tetto di 1,86, cioe'
  // poteva peggiorare 5,17 volte restando verde, e `dispatch_capacity` (0,18)
  // arrivava a 9,33 volte. Un pavimento assoluto su rotte sotto il millisecondo
  // non e' una soglia larga: e' una soglia che non puo' scattare.
  const withNoise = (median: number, noise: number): Baseline => ({
    ...baseline,
    routes: { ...baseline.routes, topics: { median_ms: median, noise_ms: noise } },
  } as Baseline);

  test("una rotta STABILE prende un tetto stretto", () => {
    const b = withNoise(0.36, 0.01);
    // La fixture tollera il 40%: 0,36 x 1,4 = 0,504. Il pavimento del rumore
    // vale 2 x 0,01 = 0,02, sotto il minimo di 0,05, quindi 0,36 + 0,05 = 0,41:
    // vince la percentuale, ed e' giusto cosi'.
    expect(regressions(at({ topics: 0.5 }), b)).toEqual([]);
    expect(regressions(at({ topics: 0.51 }), b)).toHaveLength(1);
    // Col vecchio pavimento fisso questa misura era VERDE fino a 1,86.
    expect(budgetMs(0.36, 60, 1.5)).toBeCloseTo(1.86, 2);
  });

  test("una rotta BALLERINA se lo allarga da sola, e solo lei", () => {
    const b = withNoise(0.36, 0.4);   // pavimento 0,8
    expect(regressions(at({ topics: 1.1 }), b)).toEqual([]);
    expect(regressions(at({ topics: 1.2 }), b)).toHaveLength(1);
  });

  test("senza `noise_ms` si ricade sul pavimento generale: le baseline vecchie non esplodono", () => {
    const legacy = { ...baseline, routes: { ...baseline.routes, topics: { median_ms: 0.36 } } } as Baseline;
    expect(regressions(at({ topics: 1.8 }), legacy)).toEqual([]);
  });
});

describe("un costo costante aggiunto a monte non passa piu' inosservato", () => {
  // Il caso che il banco DICE di voler prendere e che la prima versione lasciava
  // passare: un middleware nuovo nella porta unica (auth, audit, rate-limit) che
  // costa +1,4 ms a ogni richiesta. Col pavimento assoluto da 1,5 ms restava
  // sotto il tetto di TUTTE e quattro le rotte insieme, cioe' il difetto piu'
  // sistemico del server era esattamente quello invisibile.
  const stable: Baseline = {
    ...baseline,
    routes: {
      topics: { median_ms: 0.36, noise_ms: 0.01 },
      topic_messages: { median_ms: 3.38, noise_ms: 0.1 },
      all_boards_tasks: { median_ms: 0.75, noise_ms: 0.02 },
      dispatch_capacity: { median_ms: 0.18, noise_ms: 0.01 },
    },
  } as Baseline;

  test("col pavimento dal rumore lo vede, e lo vede su tutte", () => {
    const withMiddleware = at({
      topics: 0.36 + 1.4,
      topic_messages: 3.38 + 1.4,
      all_boards_tasks: 0.75 + 1.4,
      dispatch_capacity: 0.18 + 1.4,
    });
    expect(regressions(withMiddleware, stable)).toHaveLength(4);
  });

  test("col vecchio pavimento fisso NON lo vedeva: e' il conto che lo dimostra", () => {
    // Tre rotte su quattro restavano sotto `mediana + 1,5`.
    for (const [base, measured] of [[0.36, 1.76], [0.75, 2.15], [0.18, 1.58]] as const) {
      expect(measured).toBeLessThanOrEqual(budgetMs(base, 40, 1.5));
    }
  });
});
