/**
 * @covers BENCH-04
 */
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionsPerCycle,
  aggregateComparisons,
  bracketCost,
  collectFailures,
  comparePair,
  parseArmsVariance,
  evaluateCase,
  exactCost,
  fingerprintDrift,
  InputError,
  isComparableTaskRow,
  main,
  measureRun,
  median,
  parseCasesFile,
  parsePairFile,
  percentile,
  transcriptModel,
  type BoardTaskRow,
  type EdgeCase,
  type PairFile,
  type HistoryStats,
} from "./board-vs-chat";
import { isComparablePost048 } from "./board-baseline";
import { createTranscriptUsageReader, ZERO_USAGE, type SessionUsage } from "../server/services/transcript-usage";

/**
 * I casi DEGENERI, che sono l'unica ragione per cui una barra è credibile.
 *
 * Una barra che dice sempre verde non è una barra: qui sotto stanno i modi in
 * cui questo confronto potrebbe mentire — un braccio mancante spacciato per
 * parità, un task pre-048 mediato con gli altri, un caso limite «coperto» senza
 * una prova eseguita, una divisione per zero travestita da 0% — e ognuno deve
 * produrre un rosso o un `unpaired`, mai un verde silenzioso.
 */

const usage = (u: Partial<SessionUsage>): SessionUsage => ({
  ...ZERO_USAGE,
  ...u,
  billableTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0),
});

const noDeps = {
  readTranscript: (): SessionUsage => ZERO_USAGE,
  boardTask: (): BoardTaskRow | null => null,
  migration048At: "2026-07-15T10:52:05.319Z",
};

const pair = (runs: PairFile["runs"]): PairFile => ({ schemaVersion: 1, work: "t1", runs });

describe("statistica su liste degeneri", () => {
  test("mediana e percentile su lista vuota non esplodono e non inventano", () => {
    expect(median([])).toBe(0);
    expect(percentile([], 90)).toBe(0);
  });

  test("mediana di un numero pari di valori è la media dei due centrali", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("p90 non esce dall'array", () => {
    expect(percentile([1, 2, 3], 90)).toBe(3);
    expect(percentile([5], 50)).toBe(5);
  });
});

describe("migration 048 — ciò che non è comparabile non entra nelle medie", () => {
  const at = "2026-07-15T10:52:05.319Z";

  test("un task PARTITO prima dello scorporo non è comparabile", () => {
    expect(isComparableTaskRow({ in_progress_at: "2026-07-01T00:00:00.000Z", completed_at: null }, at)).toBe(false);
  });

  test("un task partito dopo lo è", () => {
    expect(isComparableTaskRow({ in_progress_at: "2026-08-01T00:00:00.000Z", completed_at: null }, at)).toBe(true);
  });

  /**
   * Il difetto che questa riga chiude: il taglio stava sulla FINE
   * (`completed_at ?? updated_at`), quindi un task PARTITO prima della 048 e
   * chiuso dopo entrava nelle medie con `agent_tokens` gonfiato ~2,4×. Su
   * topics-app-ar3jt5 erano 3 righe, due con cache-read a zero. Il taglio è
   * sull'inizio, e questo test lo tiene lì.
   */
  test("partito prima e chiuso dopo resta vecchio: si taglia sull'INIZIO", () => {
    expect(
      isComparableTaskRow({ in_progress_at: "2026-07-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:00.000Z" }, at),
    ).toBe(false);
  });

  test("senza in_progress_at si ripiega su completed_at, non si inventa un verde", () => {
    expect(isComparableTaskRow({ in_progress_at: null, completed_at: "2026-07-01T00:00:00.000Z" }, at)).toBe(false);
    expect(isComparableTaskRow({ in_progress_at: null, completed_at: "2026-08-01T00:00:00.000Z" }, at)).toBe(true);
    expect(isComparableTaskRow({ in_progress_at: null, completed_at: null }, at)).toBe(false);
  });

  test("senza la soglia NIENTE è comparabile — nel dubbio si esclude, non si include", () => {
    expect(isComparableTaskRow({ in_progress_at: "2026-08-01T00:00:00.000Z", completed_at: null }, null)).toBe(false);
  });

  test("stessa soglia di board-baseline: le due definizioni sono UNA", () => {
    for (const row of [
      { in_progress_at: "2026-07-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:00.000Z" },
      { in_progress_at: "2026-08-01T00:00:00.000Z", completed_at: null },
      { in_progress_at: null, completed_at: "2026-08-01T00:00:00.000Z" },
    ]) {
      expect(isComparableTaskRow(row, at)).toBe(isComparablePost048(row, at, "start"));
    }
  });

  test("un taskId pre-048 nel file appaiato non porta numeri: resta a zero e lo DICE", () => {
    const m = measureRun(
      { arm: "board", taskId: "old" },
      {
        ...noDeps,
        boardTask: () => ({
          id: "old", agent_tokens: 9_000_000, agent_cache_read_tokens: 0,
          model: "claude-opus-5", in_progress_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:00.000Z", status: "done",
        }),
      },
    );
    expect(m.workTokens).toBe(0);
    expect(m.notes.join(" ")).toContain("ANTERIORE alla migration 048");
  });
});

describe("un confronto non appaiato non è una parità", () => {
  test("manca il braccio chat → unpaired, non verde", () => {
    const c = comparePair(pair([{ arm: "board", usage: { inputTokens: 10 } }]), noDeps, 0);
    expect(c.status).toBe("unpaired");
    expect(c.axes).toHaveLength(0);
  });

  test("un braccio che non ha consegnato → unpaired", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 10 }, delivered: true },
        { arm: "chat", usage: { inputTokens: 100 }, delivered: false },
      ]),
      noDeps, 0,
    );
    expect(c.status).toBe("unpaired");
    expect(c.reason).toContain("chat");
  });

  test("un braccio a zero token è una misura mancante, non una vittoria della board", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 0 } },
        { arm: "chat", usage: { inputTokens: 500 } },
      ]),
      noDeps, 0,
    );
    expect(c.status).toBe("unpaired");
  });

  test("chiedere un appaiamento e non ottenerne nemmeno uno è un fallimento, non un silenzio", () => {
    const c = comparePair(pair([{ arm: "board", usage: { inputTokens: 10 } }]), noDeps, 0);
    const failures = collectFailures({ comparisons: [c], cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures.some((f) => f.id === "no-comparable-pair")).toBe(true);
  });

  test("senza --pair, zero confronti non fallisce: è un'assenza dichiarata", () => {
    const failures = collectFailures({ comparisons: [], cases: [], history: null, maxActions: 2, pairRequested: false });
    expect(failures).toHaveLength(0);
  });
});

describe("i due assi non si sommano mai", () => {
  test("board vince sul lavoro e perde sulla rilettura: è comunque rosso", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 100, cacheReadTokens: 9_000 } },
        { arm: "chat", usage: { inputTokens: 1_000, cacheReadTokens: 1_000 } },
      ]),
      noDeps, 0,
    );
    expect(c.status).toBe("evaluated");
    const work = c.axes.find((a) => a.axis === "work");
    const cache = c.axes.find((a) => a.axis === "cacheRead");
    expect(work?.ok).toBe(true);
    expect(cache?.ok).toBe(false);

    const failures = collectFailures({ comparisons: [c], cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.gate).toBe("token-parity");
    expect(failures[0]?.message).toContain("rilettura cache");
    // Somma delle due (9.100 vs 2.000) e lavoro da solo (100 vs 1.000) danno
    // verdetti OPPOSTI: è esattamente il caso che un totale unico nasconderebbe.
  });

  test("parità stretta: uguale passa, un token in più no", () => {
    const eq = comparePair(
      pair([{ arm: "board", usage: { inputTokens: 100 } }, { arm: "chat", usage: { inputTokens: 100 } }]),
      noDeps, 0,
    );
    expect(eq.axes.every((a) => a.ok)).toBe(true);

    const over = comparePair(
      pair([{ arm: "board", usage: { inputTokens: 101 } }, { arm: "chat", usage: { inputTokens: 100 } }]),
      noDeps, 0,
    );
    expect(over.axes.find((a) => a.axis === "work")?.ok).toBe(false);
  });

  test("chat a zero su un asse: nessun delta percentuale inventato", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 100, cacheReadTokens: 0 } },
        { arm: "chat", usage: { inputTokens: 100, cacheReadTokens: 0 } },
      ]),
      noDeps, 0,
    );
    expect(c.axes.find((a) => a.axis === "cacheRead")?.deltaPct).toBeNull();
    expect(c.axes.find((a) => a.axis === "cacheRead")?.ok).toBe(true);
  });

  test("il braccio CLI non è un cancello: fa esplodere il sovrapprezzo, non il verdetto", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 100 } },
        { arm: "chat", usage: { inputTokens: 200 } },
        { arm: "cli", usage: { inputTokens: 1 } },
      ]),
      noDeps, 0,
    );
    expect(c.cliOverhead?.workPct).toBe(9900);
    const failures = collectFailures({ comparisons: [c], cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures).toHaveLength(0);
  });
});

describe("azioni umane", () => {
  test("oltre il tetto sul braccio board → rosso", () => {
    const c = comparePair(
      pair([
        { arm: "board", usage: { inputTokens: 10 }, humanActions: 3 },
        { arm: "chat", usage: { inputTokens: 100 }, humanActions: 9 },
      ]),
      noDeps, 0,
    );
    const failures = collectFailures({ comparisons: [c], cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.gate).toBe("human-actions");
    // Le azioni della CHAT non sono un cancello: il tetto è una promessa della board.
    expect(failures[0]?.id).toContain("board");
  });

  test("azioni non misurate non diventano zero", () => {
    const c = comparePair(
      pair([{ arm: "board", usage: { inputTokens: 10 } }, { arm: "chat", usage: { inputTokens: 100 } }]),
      noDeps, 0,
    );
    expect(c.measures.find((m) => m.arm === "board")?.humanActions).toBeNull();
  });

  test("azioni per ciclo: senza cicli di review il denominatore è 1, non 0", () => {
    expect(actionsPerCycle({ human_comments: 3, approval_decisions: 1, review_cycles: 0 })).toBe(4);
    expect(actionsPerCycle({ human_comments: 4, approval_decisions: 2, review_cycles: 3 })).toBe(2);
  });

  const history = (over: Partial<HistoryStats> = {}): HistoryStats => ({
    projectId: null, comparable: 3, preMigration048: 0, migration048At: "2026-07-15T10:52:05.319Z",
    integrity: { rule: "r", impossibleProfiles: 0, offenders: [] },
    workTokens: { median: 0, mean: 0, p90: 0, total: 0 },
    cacheReadTokens: { median: 0, mean: 0, p90: 0, total: 0 },
    costUsd: { lowUsd: 0, highUsd: 0, pricedTasks: 0, unpricedTasks: 0 },
    humanActions: { median: 0, mean: 0, p90: 0, max: 0, overLimit: [] },
    ...over,
  });

  test("la mediana storica oltre il tetto fa rosso", () => {
    const failures = collectFailures({
      comparisons: [], cases: [], maxActions: 2, pairRequested: false,
      history: history({ humanActions: { median: 2.5, mean: 2.5, p90: 3, max: 4, overLimit: [] } }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.gate).toBe("human-actions");
  });

  /**
   * Il secondo modo in cui la soglia poteva sbagliare in silenzio: una riga
   * pre-048 sfuggita al taglio ha cache-read a ZERO (la colonna non esisteva) e
   * work gonfiato ~2,4×. Se una così è dentro le mediane, il numero è falso, e
   * un numero falso deve essere rosso — non una nota.
   */
  test("un comparabile con cache-read a zero è un pre-048 travestito: rosso", () => {
    const failures = collectFailures({
      comparisons: [], cases: [], maxActions: 2, pairRequested: false,
      history: history({
        integrity: {
          rule: "un task comparabile (post-048) DEVE avere agent_cache_read_tokens > 0",
          impossibleProfiles: 2,
          offenders: [
            { taskId: "d6baaf5e", workTokens: 380457, inProgressAt: "2026-07-01T00:00:00.000Z", completedAt: "2026-08-01T00:00:00.000Z" },
            { taskId: "fa7550fe", workTokens: 1311573, inProgressAt: null, completedAt: "2026-08-01T00:00:00.000Z" },
          ],
        },
      }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.gate).toBe("input");
    expect(failures[0]?.message).toContain("d6baaf5e");
  });
});

/**
 * Il difetto che questo blocco chiude: con tre repliche dello stesso lavoro la
 * barra emetteva SEI verdetti indipendenti a tolleranza zero, ognuno su un
 * campione solo, mentre il braccio di paragone variava più del delta giudicato.
 * Due di quei verdetti uscivano verdi — non perché la board vincesse, ma perché
 * la corsa di chat di quella terna era un fuori-scala.
 */
describe("repliche dello stesso lavoro — un verdetto solo, non N", () => {
  const replica = (n: number, boardWork: number, chatWork: number): PairFile => ({
    schemaVersion: 1,
    workId: "t1",
    replicate: n,
    replicatesTotal: 3,
    work: "t1 — lo stesso lavoro",
    runs: [
      { arm: "board", usage: { inputTokens: boardWork, cacheReadTokens: boardWork * 10 }, humanActions: 1, humanActionsStructural: 3 },
      { arm: "chat", usage: { inputTokens: chatWork, cacheReadTokens: chatWork * 10 }, humanActions: 1 },
    ],
  });
  // Mediane: board 90 vs chat 61 (+47,5%), ma la prima replica ha la board
  // che vince — esattamente la forma dei dati veri.
  const built = () =>
    aggregateComparisons(
      [replica(1, 116, 136), replica(2, 75, 61), replica(3, 90, 60)].map((f) => comparePair(f, noDeps, 0)),
      0,
      2,
    );

  test("le righe per-replica smettono di essere cancelli", () => {
    const { comparisons } = built();
    expect(comparisons).toHaveLength(3);
    for (const c of comparisons) for (const a of c.axes) expect(a.gated).toBe(false);
    // …e senza aggregati nessuno di quei rossi per-replica conta.
    expect(collectFailures({ comparisons, cases: [], history: null, maxActions: 2, pairRequested: true })).toHaveLength(0);
  });

  test("il cancello si sposta sulla mediana del gruppo, e resta rosso quando la board costa di più", () => {
    const { comparisons, aggregates } = built();
    expect(aggregates).toHaveLength(1);
    const agg = aggregates[0];
    expect(agg?.gating).toBe(true);
    expect(agg?.replicates).toBe(3);
    const work = agg?.axes.find((a) => a.axis === "work");
    expect(work?.board.median).toBe(90);
    expect(work?.chat.median).toBe(61);
    expect(work?.boardCheaperIn).toBe(1);
    expect(work?.ok).toBe(false);
    const failures = collectFailures({ comparisons, aggregates, cases: [], history: null, maxActions: 2, pairRequested: true });
    // Due assi, non sei verdetti: una affermazione per asse.
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.gate === "token-parity")).toBe(true);
    expect(failures[0]?.id).toContain("mediana di 3");
  });

  test("la forbice del braccio di paragone è nel referto, non dedotta", () => {
    const work = built().aggregates[0]?.axes.find((a) => a.axis === "work");
    // chat va da 60 a 136: 2,27×. Il delta per-replica più grande è +49%, quindi
    // il rumore del comparatore è più largo del segnale.
    expect(work?.chat.ratio).toBeCloseTo(136 / 60, 5);
    expect(work?.comparatorNoisierThanDelta).toBe(true);
    expect(work?.deltaPctPerReplicate.map((d) => Math.round(d))).toEqual([-15, 23, 50]);
  });

  test("un lavoro con UNA sola replica resta un cancello per sé", () => {
    const { comparisons, aggregates } = aggregateComparisons(
      [comparePair(replica(1, 200, 100), noDeps, 0)], 0, 2,
    );
    expect(comparisons[0]?.axes.every((a) => a.gated)).toBe(true);
    expect(aggregates[0]?.gating).toBe(false);
    const failures = collectFailures({ comparisons, aggregates, cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures).toHaveLength(2);
    expect(failures[0]?.id).not.toContain("mediana");
  });

  /**
   * Il conto a mano dell'interfaccia è una costante scritta nel file: se finisce
   * in `humanActions` il cancello confronta un letterale con un letterale, non
   * varia mai, e ripetuto su tre repliche conta una decisione come tre guasti.
   */
  test("il conto STRUTTURALE non è un cancello: si stampa e basta", () => {
    const { comparisons, aggregates } = built();
    const failures = collectFailures({ comparisons, aggregates, cases: [], history: null, maxActions: 2, pairRequested: true });
    expect(failures.some((f) => f.gate === "human-actions")).toBe(false);
    expect(aggregates[0]?.humanActions).toMatchObject({ measuredMax: 1, structuralMax: 3, ok: true });
  });

  test("le azioni umane MISURATE oltre il tetto fanno rosso UNA volta per lavoro, non una per replica", () => {
    const over = (n: number): PairFile => ({
      ...replica(n, 10, 100),
      runs: [
        { arm: "board", usage: { inputTokens: 10 }, humanActions: 5 },
        { arm: "chat", usage: { inputTokens: 100 }, humanActions: 1 },
      ],
    });
    const { comparisons, aggregates } = aggregateComparisons(
      [over(1), over(2), over(3)].map((f) => comparePair(f, noDeps, 0)), 0, 2,
    );
    const failures = collectFailures({ comparisons, aggregates, cases: [], history: null, maxActions: 2, pairRequested: true });
    const human = failures.filter((f) => f.gate === "human-actions");
    expect(human).toHaveLength(1);
    expect(human[0]?.message).toContain("MISURATE");
  });
});

describe("la varianza delle corse arriva nel referto", () => {
  const bundle = {
    baseCommit: "d760d733",
    baseTreeSha: "db608ba9",
    paired: true,
    summary: [
      { arm: "chat", runs: 3, delivered: 3, workTokens: { min: 60_184, median: 61_104, max: 135_610 }, cacheReadTokens: { min: 1, median: 2, max: 3 }, costUsd: { min: 1, median: 2, max: 3 }, wallClockMs: { min: 1, median: 2, max: 3 } },
    ],
    costOrderingPerTriple: ["cli < chat < board-sim", "cli < chat < board-sim"],
    pairingNotes: ["stesso albero"],
  };

  test("min/mediana/max e la forbice del braccio arrivano interi", () => {
    const v = parseArmsVariance(bundle, "/x/arms.json");
    expect(v?.baseTreeSha).toBe("db608ba9");
    expect(v?.summary[0]?.workTokens.ratio).toBeCloseTo(135_610 / 60_184, 5);
    expect(v?.costOrderingPerTriple).toHaveLength(2);
  });

  test("un bundle senza summary è null, non un oggetto vuoto spacciato per dato", () => {
    expect(parseArmsVariance({ summary: [] }, "/x")).toBeNull();
    expect(parseArmsVariance("nope", "/x")).toBeNull();
  });
});

describe("casi limite — una prova è un comando eseguito, non una lettura", () => {
  const base: EdgeCase = {
    id: "x", title: "t", coverage: "covered",
    proof: { kind: "command", cmd: "bun test x", exitCode: 0, output: "1 pass" },
    humanActions: 1,
  };

  test("coperto con comando verde e output → ok", () => {
    expect(evaluateCase(base, 2).ok).toBe(true);
  });

  test("scoperto → rosso, anche con una prova perfetta", () => {
    const v = evaluateCase({ ...base, coverage: "uncovered" }, 2);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("scoperto");
  });

  test("prova «l'ho letto nel sorgente» → rosso", () => {
    for (const kind of ["source", "none"] as const) {
      const v = evaluateCase({ ...base, proof: { kind } }, 2);
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toContain("non è una prova eseguita");
    }
  });

  test("comando senza esito → rosso", () => {
    const v = evaluateCase({ ...base, proof: { kind: "command", cmd: "x", output: "y" } }, 2);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("senza esito");
  });

  test("comando senza output incollato → rosso", () => {
    const v = evaluateCase({ ...base, proof: { kind: "command", cmd: "x", exitCode: 0, output: "   " } }, 2);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("output");
  });

  test("prova rossa → rosso", () => {
    const v = evaluateCase({ ...base, proof: { kind: "command", cmd: "x", exitCode: 1, output: "boom" } }, 2);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("exitCode 1");
  });

  test("un esito atteso diverso da zero è legittimo: il rifiuto è la prova", () => {
    const v = evaluateCase(
      { ...base, proof: { kind: "command", cmd: "curl …", exitCode: 22, expectExit: 22, output: "409 review_needs_commit" } },
      2,
    );
    expect(v.ok).toBe(true);
  });

  test("un caso che costa troppe azioni umane è rosso anche se coperto e provato", () => {
    const v = evaluateCase({ ...base, humanActions: 4 }, 2);
    expect(v.ok).toBe(false);
    const failures = collectFailures({ comparisons: [], cases: [v], history: null, maxActions: 2, pairRequested: false });
    expect(failures[0]?.gate).toBe("human-actions");
  });

  test("workaround provato passa, ma resta marcato come tale", () => {
    const v = evaluateCase({ ...base, coverage: "workaround" }, 2);
    expect(v.ok).toBe(true);
    expect(v.coverage).toBe("workaround");
  });
});

describe("costi — esatti quando si può, forbice quando il dato non basta", () => {
  test("senza modello il costo è ignoto, non zero", () => {
    expect(bracketCost(null, 1_000_000, 1_000_000).kind).toBe("unknown");
    expect(exactCost(null, usage({ inputTokens: 1_000_000 })).kind).toBe("unknown");
  });

  test("la forbice contiene il costo esatto dello stesso lavoro", () => {
    const u = usage({ inputTokens: 600_000, outputTokens: 200_000, cacheWriteTokens: 200_000, cacheReadTokens: 5_000_000 });
    const exact = exactCost("claude-opus-5", u);
    const brk = bracketCost("claude-opus-5", u.billableTokens, u.cacheReadTokens);
    expect(exact.lowUsd).not.toBeNull();
    expect(brk.lowUsd!).toBeLessThanOrEqual(exact.lowUsd!);
    expect(brk.highUsd!).toBeGreaterThanOrEqual(exact.lowUsd!);
  });

  test("la scrittura a un'ora costa più di quella a cinque minuti (non è un dettaglio)", () => {
    const cheap = exactCost("claude-opus-5", usage({ cacheWriteTokens: 1_000_000 }));
    const dear = exactCost("claude-opus-5", usage({ cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 }));
    expect(dear.lowUsd!).toBeGreaterThan(cheap.lowUsd!);
  });
});

describe("file in ingresso — un file storto è un errore, non uno zero", () => {
  test("schemaVersion sbagliata", () => {
    expect(() => parsePairFile({ schemaVersion: 2, work: "x", runs: [] }, "f")).toThrow(InputError);
  });

  test("senza «work» non si sa cosa si sta appaiando", () => {
    expect(() => parsePairFile({ schemaVersion: 1, runs: [{ arm: "board", usage: {} }] }, "f")).toThrow(/work/);
  });

  test("un braccio senza numeri non è un braccio", () => {
    expect(() => parsePairFile({ schemaVersion: 1, work: "x", runs: [{ arm: "board" }] }, "f")).toThrow(/transcriptPath/);
  });

  test("taskId su un braccio che non è board", () => {
    expect(() => parsePairFile({ schemaVersion: 1, work: "x", runs: [{ arm: "chat", taskId: "t1" }] }, "f")).toThrow(/board/);
  });

  test("arm sconosciuto", () => {
    expect(() => parsePairFile({ schemaVersion: 1, work: "x", runs: [{ arm: "slack", usage: {} }] }, "f")).toThrow(/arm/);
  });

  test("token negativi", () => {
    expect(() => parsePairFile({ schemaVersion: 1, work: "x", runs: [{ arm: "board", usage: { inputTokens: -1 } }] }, "f"))
      .toThrow(/>= 0/);
  });

  test("coverage inventata", () => {
    expect(() => parseCasesFile({ schemaVersion: 1, cases: [{ id: "a", coverage: "boh", proof: { kind: "test" } }] }, "f"))
      .toThrow(/coverage/);
  });

  test("un caso senza id", () => {
    expect(() => parseCasesFile({ schemaVersion: 1, cases: [{ coverage: "covered", proof: { kind: "test" } }] }, "f"))
      .toThrow(/id/);
  });
});

describe("transcript", () => {
  test("un transcript assente non produce numeri finti, produce una nota", () => {
    const m = measureRun({ arm: "chat", transcriptPath: "/non/esiste.jsonl" }, noDeps);
    expect(m.workTokens).toBe(0);
    expect(m.notes.join(" ")).toContain("transcript assente");
  });

  test("il nome del modello salta le righe <synthetic>", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, [
      JSON.stringify({ message: { model: "claude-opus-5[1m]", usage: { input_tokens: 1 } } }),
      JSON.stringify({ message: { model: "<synthetic>", usage: { input_tokens: 0 } } }),
      "",
    ].join("\n"));
    expect(transcriptModel(file)).toBe("claude-opus-5[1m]");
  });

  test("i numeri di un transcript vengono dal reader del server, deduplicati per message.id", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-"));
    const file = join(dir, "t.jsonl");
    // La stessa risposta, scritta due volte perché aveva due content block: il
    // reader la conta UNA volta. È il bug che la migration 048 ha chiuso.
    const row = JSON.stringify({
      message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 900 } },
    });
    writeFileSync(file, [row, row, ""].join("\n"));

    // Il reader VERO del server, lo stesso che alimenta `tasks.agent_tokens`:
    // se un giorno questo test smette di dare 150, è il reader ad essere
    // cambiato, e allora è cambiata anche la board.
    const reader = createTranscriptUsageReader();
    const m = measureRun({ arm: "chat", transcriptPath: file }, { ...noDeps, readTranscript: (p) => reader.read(p) });
    expect(m.source).toBe("transcript");
    expect(m.workTokens).toBe(150);
    expect(m.cacheReadTokens).toBe(900);
    expect(m.cost.kind).toBe("exact");
  });
});

describe("main — la barra vera, end-to-end", () => {
  // Una radice FINTA di proposito: i test non devono dipendere da quali file
  // appaiati o quale matrice esistono nel repo in questo momento, altrimenti
  // domani diventano rossi per un file che non hanno scritto loro.
  const repoRoot = mkdtempSync(join(tmpdir(), "bvc-root-"));
  // …ma la MATRICE dei casi limite deve esserci: la sua assenza è un rosso, non
  // un silenzio, quindi le prove che vogliono un verde se la scrivono.
  mkdirSync(join(repoRoot, "docs", "board-vs-chat"), { recursive: true });
  // La matrice porta l'esito REGISTRATO delle prove, non le riesegue: vale solo
  // finché le sorgenti coperte non si muovono. Qui la sorgente finta esiste
  // davvero dentro la radice finta, così l'impronta è verificabile senza
  // dipendere da un file del repo vero.
  const COVERED_SRC = "server/finto.ts";
  mkdirSync(join(repoRoot, "server"), { recursive: true });
  const coveredBody = "export const x = 1;\n";
  writeFileSync(join(repoRoot, COVERED_SRC), coveredBody);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const casesBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      fingerprint: { algo: "sha256", files: { [COVERED_SRC]: sha(coveredBody) } },
      cases: [{
        id: "x", title: "t", coverage: "covered", humanActions: 1,
        proof: { kind: "command", cmd: "bun test x", exitCode: 0, output: "1 pass" },
      }],
      ...over,
    });
  writeFileSync(join(repoRoot, "docs", "board-vs-chat", "cases.json"), casesBody());

  /**
   * Il difetto che questa riga chiude: senza matrice il terzo cancello finiva
   * in `notEvaluated`, che NON è fatale, e lo script usciva 0 — un cancello che
   * si spegne da solo non è un cancello.
   */
  test("senza la matrice dei casi limite esce 1: il terzo cancello non si auto-disattiva", () => {
    const bare = mkdtempSync(join(tmpdir(), "bvc-empty-"));
    expect(main(["--json", "--db", "/non/esiste.db"], bare)).toBe(1);
  });

  test("con la matrice presente, e nient'altro da valutare, esce 0", () => {
    expect(main(["--json", "--db", "/non/esiste.db"], repoRoot)).toBe(0);
  });

  /**
   * Il difetto che queste tre righe chiudono: la matrice porta l'esito
   * REGISTRATO di ogni prova e `main` si fida di quel numero invece di
   * rieseguire. Finché niente lega il file alle sorgenti che copre, un refactor
   * che rompe la matrice la lascia verde — cioè il cancello più costoso da
   * fidarsi e il più facile da far marcire.
   */
  test("una matrice senza impronta è rossa: senza legame alle sorgenti non si può dichiarare stantia", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-nofp-"));
    mkdirSync(join(dir, "docs", "board-vs-chat"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "board-vs-chat", "cases.json"),
      JSON.stringify({
        schemaVersion: 1,
        cases: [{ id: "x", title: "t", coverage: "covered", humanActions: 1, proof: { kind: "command", cmd: "c", exitCode: 0, output: "ok" } }],
      }),
    );
    expect(main(["--json", "--db", "/non/esiste.db"], dir)).toBe(1);
    expect(() => parseCasesFile(JSON.parse(readFileSync(join(dir, "docs", "board-vs-chat", "cases.json"), "utf8")), "f"))
      .toThrow(/fingerprint/);
  });

  test("appena una sorgente coperta cambia di un byte, la matrice è STANTIA e si esce 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-stale-"));
    mkdirSync(join(dir, "docs", "board-vs-chat"), { recursive: true });
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, COVERED_SRC), coveredBody);
    writeFileSync(join(dir, "docs", "board-vs-chat", "cases.json"), casesBody());
    expect(main(["--json", "--db", "/non/esiste.db"], dir)).toBe(0);
    // Un byte. Non un refactor: un byte.
    writeFileSync(join(dir, COVERED_SRC), `${coveredBody} `);
    expect(main(["--json", "--db", "/non/esiste.db"], dir)).toBe(1);
  });

  test("anche una sorgente coperta che SPARISCE è deriva, non un file da saltare", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-gone-"));
    mkdirSync(join(dir, "docs", "board-vs-chat"), { recursive: true });
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "docs", "board-vs-chat", "cases.json"), casesBody());
    // Il file coperto non è mai stato creato in questa radice: l'impronta dice
    // uno sha256, il disco dice «assente». Deve essere rosso.
    expect(main(["--json", "--db", "/non/esiste.db"], dir)).toBe(1);
  });

  test("la deriva si legge in chiaro, file per file", () => {
    const fp = { algo: "sha256" as const, files: { [COVERED_SRC]: sha(coveredBody), "server/mai-esistito.ts": sha("x") } };
    expect(fingerprintDrift(fp, repoRoot)).toEqual([
      `server/mai-esistito.ts: atteso ${sha("x").slice(0, 12)}, trovato assente`,
    ]);
    expect(fingerprintDrift({ algo: "sha256", files: { [COVERED_SRC]: sha(coveredBody) } }, repoRoot)).toEqual([]);
  });

  /** Un file appaiato in cui la board perde: attrezzo sano, misura negativa. */
  const losingPair = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-pair-"));
    const f = join(dir, "t1.pair.json");
    writeFileSync(f, JSON.stringify({
      schemaVersion: 1,
      work: "t1 — degenere",
      runs: [
        { arm: "board", usage: { inputTokens: 1_000 }, model: "claude-opus-5" },
        { arm: "chat", usage: { inputTokens: 100 }, model: "claude-opus-5" },
      ],
    }));
    return f;
  };

  test("una board che perde esce 3 (misura negativa), non 1 (attrezzo rotto)", () => {
    // I due rossi non sono la stessa cosa e non devono avere lo stesso codice:
    // 1 dice «non fidarti dei numeri», 3 dice «i numeri dicono no».
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--pair", losingPair()], repoRoot)).toBe(3);
  });

  test("con --gate harness la stessa misura negativa esce 0", () => {
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--gate", "harness", "--pair", losingPair()], repoRoot)).toBe(0);
  });

  test("un attrezzo rotto esce 1 anche con --gate harness, e vince sul verdetto", () => {
    // Terna illeggibile (input) INSIEME a una misura negativa: deve uscire 1,
    // perché un verdetto calcolato su input rotti non è un verdetto.
    const dir = mkdtempSync(join(tmpdir(), "bvc-rotto-"));
    const bad = join(dir, "rotto.pair.json");
    writeFileSync(bad, "{ questo non è json");
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--pair", bad, "--pair", losingPair()], repoRoot)).toBe(1);
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--gate", "harness", "--pair", bad], repoRoot)).toBe(1);
  });

  test("lo stesso file con la board che vince esce 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-pair-ok-"));
    const f = join(dir, "t1.pair.json");
    writeFileSync(f, JSON.stringify({
      schemaVersion: 1,
      work: "t1 — board vince",
      runs: [
        { arm: "board", usage: { inputTokens: 100, cacheReadTokens: 10 }, model: "claude-opus-5", humanActions: 2 },
        { arm: "chat", usage: { inputTokens: 1_000, cacheReadTokens: 1_000 }, model: "claude-opus-5", humanActions: 6 },
      ],
    }));
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--pair", f], repoRoot)).toBe(0);
  });

  test("un file illeggibile è un fallimento di input, non un verde", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvc-bad-"));
    const f = join(dir, "bad.pair.json");
    writeFileSync(f, "{ non json");
    expect(main(["--json", "--no-history", "--db", "/non/esiste.db", "--pair", f], repoRoot)).toBe(1);
  });

  test("un'opzione sconosciuta esce 2 invece di ignorarla", () => {
    expect(main(["--boh"], repoRoot)).toBe(2);
  });

  test("un file passato NUDO non viene ingoiato in silenzio", () => {
    // `board-vs-chat.ts run.pair.json` è la svista naturale: ignorarla farebbe
    // uscire 0 su un file che nessuno ha letto.
    expect(main(["run.pair.json"], repoRoot)).toBe(2);
  });

  test("--print-schema esce 0 e stampa il contratto", () => {
    expect(main(["--print-schema"], repoRoot)).toBe(0);
  });
});
