/**
 * @covers GATE-05
 */
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
import { readRouteFault, applyRouteFault, currentRouteFault, setRouteFault } from "../server/lib/route-fault";
import { baselineEnvKey, baselineCandidates, pickBaselinePath } from "./route-latency-baseline-pick";

/**
 * The latency gate, exercised on the numbers instead of on the server.
 *
 * Every check below answers one single question: "in which case does this gate
 * lie?". There are three different ways of lying, and all three have to be
 * closed:
 *   1. it stays GREEN while a route really did get worse;
 *   2. it goes RED because of the machine's jitter, and then it gets turned off;
 *   3. it compares two measurements taken over different amounts of data, and
 *      then the number means nothing in either direction.
 */

const baseline: Baseline = {
  tolerance_pct: 40,
  floor_ms: 1.5,
  noise_guard_pct: 60,
  samples: 15,
  corpus: { topics: 24, messages: 300, tasks: 40, description_chars: 1200 },
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
    // This is the whole reason the median is used and not the mean: on these
    // samples the mean is 21.4 ms and would accuse a regression that is not there.
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
    // 0.5 ms + 40% = 0.7 ms: any machine goes past that by chance. The floor
    // brings the cap to 2.0 ms, which is the only threshold that means anything.
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
    // This is exactly what the server's synthetic fault does
    // (TOPICS_ROTTE_FAULT_MS=40): the proof that the gate can say no.
    const bad = regressions(at({ topics: 43 }), baseline);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("topics");
    expect(bad[0]).toContain("43");
  });

  test("ROSSO su una rotta che raddoppia, anche se sono pochi millisecondi", () => {
    // 12 -> 25 ms: no floor saves it, and this is the shape of a query gone
    // N+1 over a long conversation.
    expect(regressions(at({ topic_messages: 25 }), baseline)).toHaveLength(1);
  });

  test("il guasto su /api/topics accende ENTRAMBE le rotte che iniziano cosi'", () => {
    // The fault prefix is `/api/topics`, which also covers
    // `/api/topics/:id/messages`: the gate has to name both of them, not stop
    // at the first one.
    const bad = regressions(at({ topics: 43, topic_messages: 52 }), baseline);
    expect(bad).toHaveLength(2);
  });

  test("una rotta senza baseline leggibile si DENUNCIA, non si salta", () => {
    // The contract changed, and for a measured reason: this used to read
    // `if (base === undefined) continue`, so renaming a key, setting it to null
    // or QUOTING the number ("0.36") was enough for that route to stop being
    // judged and for the gate to exit 0. A baseline that cannot be read is not
    // "no regression": it is a disarmed gate.
    const lame = { ...baseline, routes: { ...baseline.routes } } as Baseline;
    delete (lame.routes as Record<string, unknown>).topics;
    const said = regressions(at({ topics: 900 }), lame);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("non puo' giudicare");
  });

  test("un numero QUOTATO nella baseline non spegne la rotta in silenzio", () => {
    // The most insidious shape of all: the JSON stays valid, the key is there,
    // and `got > NaN` is false for any measurement whatsoever.
    const quoted = { ...baseline, routes: { ...baseline.routes } } as Baseline;
    (quoted.routes as Record<string, unknown>).topics = { median_ms: "0.36" };
    const said = regressions(at({ topics: 900 }), quoted);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("non puo' giudicare");
  });
});

describe("il tubo e' il metro: quando salta lui, non si misura niente", () => {
  // The fourth way of lying, the one that was missing: the machine is slow for
  // the WHOLE run, so the two passes resemble each other perfectly and the gate
  // calls a regression a number that is talking about the laptop. It really
  // happened on 2026-08-14: `all_boards_tasks` at 8 ms against a baseline of
  // 0.75, identical on a tree PRIOR to every change made that day.

  test("tubo a posto: non scatta, e una rotta peggiorata resta ROSSA", () => {
    // The half that matters: the guard must not turn into an excuse. With the
    // pipe where it belongs, the verdict on the other routes is the one before.
    expect(calibrationOutOfScale(at({}), baseline)).toBeNull();
    expect(calibrationOutOfScale(at({ topics: 43 }), baseline)).toBeNull();
    expect(regressions(at({ topics: 43 }), baseline)).toHaveLength(1);
  });

  test("tubo fuori scala: scatta, e riporta misura, tetto e baseline", () => {
    // baseline 1 ms, tolerance 40%, floor 1.5 ms -> cap 2.5 ms.
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

  test("il metro si legge anche in RAPPORTO: il caso vero della CI del 15/08", () => {
    // The numbers are the runner's, rescaled onto this file's fake baseline. On
    // CI: dispatch_capacity 0.87 against a baseline of 0.18 = 4.8x, under its
    // own cap of 1.68 because the absolute floor of 1.5 ms over a small baseline
    // grants 9.3 times itself. In that same run all_boards_tasks was at 4.1x and
    // came out red: the gate was accusing the product of a slowdown SMALLER than
    // the one its own ruler was declaring.
    //
    // Here: pipe baseline = 1 ms, cap = 2.5 ms. At 2.6 ms the pipe is at 2.6x
    // and has to fire, even though against the cap it would squeak through.
    const cap = budgetMs(1, baseline.tolerance_pct, baseline.floor_ms);
    expect(cap).toBe(2.5); // if this changes, the two numbers below must be redone
    const sopra = calibrationOutOfScale(at({ [CALIBRATION_KEY]: 2.6 }), baseline);
    expect(sopra, "2,6x la baseline e' una macchina che si e' allargata, non un prodotto peggiorato").not.toBeNull();
    // ...and it does NOT fire just below, otherwise a route getting worse on its
    // own would stop coming out red, which is how this gate lies.
    expect(calibrationOutOfScale(at({ [CALIBRATION_KEY]: 2.4 }), baseline)).toBeNull();
  });

  test("una macchina lenta alza TUTTO, e la risposta e' 2 e non 1", () => {
    // The real shape of the fault: every route inflated, the pipe included. It
    // used to exit 1 ("regression") on three routes; now the pipe says nothing
    // is measurable.
    const loaded = at({ topics: 9, topic_messages: 30, all_boards_tasks: 12, dispatch_capacity: 6 });
    expect(regressions(loaded, baseline).length).toBeGreaterThan(0); // the old verdict
    expect(calibrationOutOfScale(loaded, baseline)).not.toBeNull(); // but the ruler broke
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
    // The difference between "the machine is shaking" and "the route is slow" is
    // all right here. With the synthetic delay armed, both passes measure the
    // same high number, so the gate has to say regression (exit 1), not
    // "not comparable" (exit 2).
    const a = at({ topics: 43.1 });
    const b = at({ topics: 43.4 });
    expect(unstableRoutes(a, b, 60, 1.5)).toEqual([]);
    expect(regressions(at({ topics: Math.max(43.1, 43.4) }), baseline)).toHaveLength(1);
  });
});

describe("corpusMismatch", () => {
  test("stesso corpus, nessuna obiezione", () => {
    expect(corpusMismatch({ topics: 24, messages: 300, tasks: 40, description_chars: 1200 }, baseline.corpus)).toBeNull();
  });

  test("un database quasi vuoto non si confronta con una baseline piena", () => {
    // The easiest way of certifying a green that was never measured: seeding
    // fails halfway through and the routes answer over nothing.
    const gap = corpusMismatch({ topics: 24, messages: 0, tasks: 40, description_chars: 1200 }, baseline.corpus);
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
      // The shard band is 13500-13899, their tunnels 14334 and 14500-14899.
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
    // The condition that keeps the delay away from the production server.
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

  test("si arma a CALDO, senza riavviare: e' quello che rende l'autoprova una prova", async () => {
    // Arming from the environment forces a server restart, so the healthy measurement and the
    // faulty one come from two DIFFERENT processes - which have different numbers even with no
    // fault. This way they come from the same one, the only shape in which the difference says
    // anything.
    const prima = currentRouteFault();
    try {
      setRouteFault({ delayMs: 30, pathPrefix: "/api/topics" });
      expect(currentRouteFault()).toEqual({ delayMs: 30, pathPrefix: "/api/topics" });

      // applyRouteFault's default follows the live arming, not a copy taken at boot.
      const t0 = performance.now();
      await applyRouteFault("/api/topics/abc/messages");
      expect(performance.now() - t0).toBeGreaterThanOrEqual(25);

      setRouteFault(null);
      expect(currentRouteFault()).toBeNull();
      const t1 = performance.now();
      await applyRouteFault("/api/topics/abc/messages");
      expect(performance.now() - t1).toBeLessThan(15);
    } finally {
      setRouteFault(prima);
    }
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
  // The fault was REPRODUCED, not feared: with a load average of 5.32 on this
  // Mac the bench wrote `all_boards_tasks` at 9.87 ms where on an idle machine
  // it sits at 0.75. Thirteen times over, and the two passes agreed - so the
  // instability guard stayed quiet. The A-against-B comparison sees the jitter,
  // not the UNIFORM load, and an inflated baseline disarms the gate forever
  // instead of widening it a little.
  test("sopra mezzo core occupato si rifiuta", () => {
    expect(machineTooLoaded(5.32, 12)).toBe(false);   // 0.44: under, and indeed that run went through
    expect(machineTooLoaded(7.0, 12)).toBe(true);     // 0.58
    expect(machineTooLoaded(6.0, 4)).toBe(true);      // 1.5
  });

  test("una macchina ferma non viene mai fermata", () => {
    expect(machineTooLoaded(0, 12)).toBe(false);
    expect(machineTooLoaded(1.2, 12)).toBe(false);
  });

  test("zero core non fa esplodere il conto (divisione per zero)", () => {
    expect(machineTooLoaded(1, 0)).toBe(true);        // 1/1: refuses, not NaN
    expect(machineTooLoaded(0.1, 0)).toBe(false);
  });
});

describe("il pavimento lo detta il RUMORE, non una costante", () => {
  // The arithmetic the adversary ran on the first version: with 1.5 ms the same
  // for everyone, `/api/topics` (0.36 ms) got a cap of 1.86, meaning it could
  // get 5.17 times worse and stay green, and `dispatch_capacity` (0.18) reached
  // 9.33 times. An absolute floor over sub-millisecond routes is not a wide
  // threshold: it is a threshold that cannot fire.
  const withNoise = (median: number, noise: number): Baseline => ({
    ...baseline,
    routes: { ...baseline.routes, topics: { median_ms: median, noise_ms: noise } },
  } as Baseline);

  test("una rotta STABILE prende un tetto stretto", () => {
    const b = withNoise(0.36, 0.01);
    // The fixture tolerates 40%: 0.36 x 1.4 = 0.504. The noise floor is worth
    // 2 x 0.01 = 0.02, under the minimum of 0.05, so 0.36 + 0.05 = 0.41: the
    // percentage wins, and rightly so.
    expect(regressions(at({ topics: 0.5 }), b)).toEqual([]);
    expect(regressions(at({ topics: 0.51 }), b)).toHaveLength(1);
    // With the old fixed floor this measurement was GREEN all the way to 1.86.
    expect(budgetMs(0.36, 60, 1.5)).toBeCloseTo(1.86, 2);
  });

  test("una rotta BALLERINA se lo allarga da sola, e solo lei", () => {
    const b = withNoise(0.36, 0.4);   // floor 0.8
    expect(regressions(at({ topics: 1.1 }), b)).toEqual([]);
    expect(regressions(at({ topics: 1.2 }), b)).toHaveLength(1);
  });

  test("senza `noise_ms` si ricade sul pavimento generale: le baseline vecchie non esplodono", () => {
    const legacy = { ...baseline, routes: { ...baseline.routes, topics: { median_ms: 0.36 } } } as Baseline;
    expect(regressions(at({ topics: 1.8 }), legacy)).toEqual([]);
  });
});

describe("un costo costante aggiunto a monte non passa piu' inosservato", () => {
  // The case the bench SAYS it wants to catch and that the first version let
  // through: a new middleware in the single door (auth, audit, rate-limit)
  // costing +1.4 ms on every request. With the absolute floor of 1.5 ms it
  // stayed under the cap of ALL four routes at once, meaning the server's most
  // systemic defect was exactly the invisible one.
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
    // Three routes out of four stayed under `median + 1.5`.
    for (const [base, measured] of [[0.36, 1.76], [0.75, 2.15], [0.18, 1.58]] as const) {
      expect(measured).toBeLessThanOrEqual(budgetMs(base, 40, 1.5));
    }
  });
});

/**
 * WHICH BASELINE GETS COMPARED, which is the question this gate answered wrong
 * for days without saying so.
 *
 * With a single file, every run was asking "is this machine as fast as the idle
 * M2 Max the number was recorded on?". On the user's workstation, measured on
 * 2026-08-20 at load 24-27, that meant `topic_messages` at 27.29 against 15.18
 * ms between two consecutive passes: not a regression, but Dia eating 86% of a
 * core. The comment on `calibrationOutOfScale` already pointed at the remedy -
 * "a baseline recorded ON the runner and chosen per machine" - and these are the
 * functions that hold it.
 */
describe("scelta della baseline per ambiente", () => {
  test("in CI si sceglie la baseline del runner", () => {
    expect(baselineEnvKey({ GITHUB_ACTIONS: "true" } as NodeJS.ProcessEnv)).toBe("ci");
    expect(baselineEnvKey({ CI: "true" } as NodeJS.ProcessEnv)).toBe("ci");
  });

  test("su una postazione si sceglie quella locale", () => {
    expect(baselineEnvKey({} as NodeJS.ProcessEnv)).toBe("local");
    // `CI` set to something else is not CI: only the string "true" counts,
    // because a `CI=0` inherited from someone else's script must not change the
    // ruler.
    expect(baselineEnvKey({ CI: "0" } as NodeJS.ProcessEnv)).toBe("local");
  });

  test("il file dell'ambiente viene PRIMA di quello storico", () => {
    const [primo, secondo] = baselineCandidates("ci", "/r");
    expect(primo).toBe("/r/scripts/route-latency-baseline.ci.json");
    expect(secondo).toBe("/r/scripts/route-latency-baseline.json");
  });

  test("senza il file dell'ambiente si RIPIEGA sullo storico, invece di fallire", () => {
    // This is what keeps the gate the same as before for anyone who has not
    // recorded their own yet: an error here would have broken a working bar.
    const solaStorica = (p: string) => p.endsWith("route-latency-baseline.json");
    expect(pickBaselinePath("local", solaStorica, "/r")).toBe("/r/scripts/route-latency-baseline.json");
  });

  test("quando c'e' quello dell'ambiente, vince lui", () => {
    const entrambe = () => true;
    expect(pickBaselinePath("local", entrambe, "/r")).toBe("/r/scripts/route-latency-baseline.local.json");
  });

  test("senza NESSUNA baseline risponde null, e chi chiama decide", () => {
    // Not an invented path: `null` forces the caller to say what to do, which
    // here is "write where you would have written".
    expect(pickBaselinePath("ci", () => false, "/r")).toBeNull();
  });
});
