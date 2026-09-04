/**
 * @covers CHAT-REL-05
 *
 * Partial: the sweep of active streams left hanging. The branch that detaches a
 * stream on an orderly turn end is in chat-stream-abort.test.ts.
 */
// La BARRA: un turno il cui figlio è VIVO non viene mai chiuso da un orologio,
// e chi legge il log deve poter credere al numero che ci trova scritto.
//
// Perché questo test esiste. `stale-stream-verdict.ts` era già provato, ma il
// CABLAGGIO no: quel test restava verde con lo spazzino di `server.ts` riportato
// indietro per intero, perché niente eseguiva il giro. Qui si esegue il giro
// vero — la stessa funzione che il `setInterval` di `server.ts` chiama — con le
// dipendenze iniettate: sette minuti di silenzio costano un millisecondo.
import { test, expect, describe } from "bun:test";
import {
  sweepStaleStreams,
  INTERRUPTED_MARKER,
  type SilenceMark,
  type StaleStreamSweepDeps,
  type SweepableStream,
} from "../../server/lib/stale-stream-sweep";
import { timelineWithInterruptedVerdict } from "../../server/lib/interrupted-turn-block";
import type { ContentBlock } from "../../shared/types";

const MIN = 60_000;
const SK = "topic:e1ea0e41";
const MSG = "msg-1";

interface Harness {
  deps: StaleStreamSweepDeps;
  clock: { t: number };
  rows: Map<string, { content: string; partial: boolean; toolCalls?: unknown; blocks?: unknown }>;
  warnings: string[];
  aborted: string[];
  /** Who was told to stop the provider's turn, and in what order with `endStream`. */
  providerAborts: string[];
  order: string[];
  resyncs: string[];
  turnsEnded: string[];
  stream: SweepableStream;
}

function harness(opts?: {
  alive?: boolean;
  content?: string;
  /** The turn's timeline, for the rows whose verdict has somewhere to go. */
  blocks?: unknown;
  silentMs?: number;
  humanHoldAgeMs?: number | null;
  /**
   * A tool of this turn is EXECUTING. It is the difference between "silent
   * because it is working" and "silent, full stop": no clock touches the first,
   * the second declares itself stuck after ten minutes.
   */
  toolRunning?: boolean;
  /**
   * How long that tool has been 'running', stamped on the row the way production
   * does it (`startedAt` at announce). Absent = no stamp at all, which is the
   * case where doubt must not kill.
   */
  toolRunningForMs?: number;
  /** The board is running (or queuing) OUR pre-review checks for this turn's card. */
  waitingOnOurChecks?: boolean;
}): Harness {
  const clock = { t: Date.UTC(2026, 7, 15, 12, 0, 0) };
  const silent = opts?.silentMs ?? 7 * MIN;
  // THE SHAPE IS `rowToMessage`'s (server/utils.ts:574-641), not the raw SQLite
  // row's: in production `getMessageById` hydrates the row and writes
  // `toolCalls` in camelCase. A fake handing back `tool_calls` kept green a
  // branch the product never took.
  const rows = new Map<string, { content: string; partial: boolean; toolCalls?: unknown; blocks?: unknown }>([
    [MSG, {
      content: opts?.content ?? "",
      partial: true,
      ...(opts?.blocks ? { blocks: opts.blocks } : {}),
      ...(opts?.toolRunning
        ? (() => {
            const startedAt = opts.toolRunningForMs === undefined
              ? {}
              : { startedAt: clock.t - opts.toolRunningForMs };
            return {
              toolCalls: [{ id: "t1", name: "bash", status: "running", ...startedAt }],
              // The client renders tool state from the BLOCKS when they exist,
              // and the shape there is nested: `{kind:'tool', toolCall:{status}}`.
              blocks: [{ kind: "tool", toolCall: { id: "t1", name: "bash", status: "running", ...startedAt } }],
            };
          })()
        : {}),
    }],
  ]);
  const warnings: string[] = [];
  const aborted: string[] = [];
  const providerAborts: string[] = [];
  const order: string[] = [];
  const resyncs: string[] = [];
  const turnsEnded: string[] = [];
  const stream: SweepableStream = {
    sessionKey: SK,
    lastActivity: new Date(clock.t - silent).toISOString(),
    content: "",
    messageId: MSG,
    abortController: { abort: () => aborted.push(SK) },
  };
  const activeStreams = new Map<string, SweepableStream>([[SK, stream]]);
  const silence = new Map<string, SilenceMark>();
  const deps: StaleStreamSweepDeps = {
    now: () => clock.t,
    timeoutMs: 3 * MIN,
    askTtlMs: 30 * MIN,
    activeStreams,
    rescued: new Set<string>(),
    silence,
    getMessageById: (id) => rows.get(id),
    humanHoldAgeMs: () => opts?.humanHoldAgeMs ?? null,
    childAlive: () => opts?.alive ?? true,
    waitingOnOurChecks: () => opts?.waitingOnOurChecks ?? false,
    resyncStream: (sk) => resyncs.push(sk),
    cancelAsk: () => {},
    // La proroga vera: sposta l'orologio dello stream ad ADESSO. È esattamente
    // ciò che rendeva illeggibile il numero nel messaggio di log.
    updateStreamActivity: (sk) => {
      const s = activeStreams.get(sk);
      // `+1`: the real bump (server/utils.ts:1657-1663) stamps `new Date()`
      // WHEN it is called, i.e. after the `now` the tick captured at its top.
      // Stamping exactly `now` was the one value for which the "the turn
      // started talking again" comparison did not fire: the test lived in a
      // pose production never takes.
      if (s) s.lastActivity = new Date(clock.t + 1).toISOString();
    },
    getTopicId: () => "topic-1",
    abortProvider: (sk) => { providerAborts.push(sk); order.push("abortProvider"); },
    // Come il vero `ctx.endStream`: chiude i tool rimasti 'running' E toglie la
    // voce dalla mappa. È lui il proprietario della cancellazione, non il giro.
    endStream: (sk) => { order.push("endStream"); activeStreams.delete(sk); return []; },
    broadcast: () => {},
    finalizeMessage: ({ messageId, marker, interruption }) => {
      const row = rows.get(messageId);
      if (!row) return;
      row.partial = false;
      if (marker !== null) row.content = marker;
      // Same rule the real deps applies in `server.ts`: the reason goes on the
      // timeline, and a row whose timeline is empty is left alone.
      const timeline = timelineWithInterruptedVerdict(row.blocks as ContentBlock[] | null, interruption);
      if (timeline) row.blocks = timeline;
    },
    recordTurnEnd: (sk) => turnsEnded.push(sk),
    warn: (m) => warnings.push(m),
    info: (m) => warnings.push(m),
  };
  return { deps, clock, rows, warnings, aborted, providerAborts, order, resyncs, turnsEnded, stream };
}

describe("un figlio VIVO non viene chiuso dall'orologio", () => {
  /**
   * IL CASO DELL'ITEM T3, per intero: 7 minuti di silenzio, il provider giura
   * che il figlio è vivo, due tick. La riga parziale deve restare intatta.
   */
  test("due tick a 7 minuti di silenzio: la riga parziale non si tocca", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("rescued");
    expect(h.resyncs).toEqual([SK]);
    // Passa un altro giro di silenzio: il soccorso è speso, il figlio è vivo.
    h.clock.t += 4 * MIN;
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("extended");
    // On the FIELDS, not on the whole object: the row now also carries the
    // running tool, and a `toEqual` on the object would pin the shape of the
    // fixture instead of the fact that matters — the partial was left alone.
    expect(h.rows.get(MSG)?.content).toBe("");
    expect(h.rows.get(MSG)?.partial).toBe(true);
    expect(h.turnsEnded).toEqual([]);
    expect(h.aborted).toEqual([]);
    expect(h.deps.activeStreams.has(SK)).toBe(true);
    // E non si ri-soccorre a ogni giro: il resync è UNO.
    expect(h.resyncs).toEqual([SK]);
  });

  test("dieci tick di fila non lo consumano: la proroga non è un conto alla rovescia", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: true });
    for (let i = 0; i < 10; i++) {
      sweepStaleStreams(h.deps);
      h.clock.t += 4 * MIN;
    }
    expect(h.rows.get(MSG)?.partial).toBe(true);
    expect(h.turnsEnded).toEqual([]);
  });

  test("quando il figlio muore il turno si chiude, con il marcatore se non c'era prosa", () => {
    const h = harness({ alive: false, silentMs: 7 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
    expect(h.rows.get(MSG)).toEqual({ content: INTERRUPTED_MARKER, partial: false });
    expect(h.turnsEnded).toEqual([SK]);
    expect(h.aborted).toEqual([SK]);
    expect(h.deps.activeStreams.has(SK)).toBe(false);
  });

  test("con la prosa già streammata il contenuto resta il suo", () => {
    const h = harness({ alive: false, silentMs: 7 * MIN, content: "mezza risposta" });
    sweepStaleStreams(h.deps);
    // No timeline on this row: it renders from `content`, so writing a first
    // block would hide the half answer instead of explaining it.
    expect(h.rows.get(MSG)).toEqual({ content: "mezza risposta", partial: false });
  });

  /**
   * THE 2026-09-03 REPORT, in one test.
   *
   * The reaper kills the child of a turn that had already written a long
   * answer. The prose stays (no marker), and until now that was ALL that
   * happened: the reason lived in the server log, and the chat looked "stuck
   * with no feedback at all". Now the row carries the cause in the shape the
   * composer's banner reads.
   */
  test("un turno tagliato a metà risposta dice PERCHÉ, sulla sua timeline", () => {
    const h = harness({
      alive: false,
      silentMs: 7 * MIN,
      content: "mezza risposta",
      blocks: [{ kind: "text", text: "mezza risposta" }],
    });
    sweepStaleStreams(h.deps);

    const row = h.rows.get(MSG);
    expect(row?.content).toBe("mezza risposta");
    const blocks = row?.blocks as ContentBlock[];
    expect(blocks).toHaveLength(2);
    const verdetto = blocks[1] as { kind: string; cause?: string; text: string; at?: string };
    expect(verdetto.kind).toBe("error");
    // The CAUSE as a code: it is what the banner decides on, not the sentence.
    expect(verdetto.cause).toBe("watchdog");
    expect(verdetto.at).toBeTruthy();
    // And the warning sign stays in the old format only.
    expect(verdetto.text.startsWith("\u26a0")).toBe(false);
  });

  test("due giri di seguito non impilano due verdetti", () => {
    const h = harness({
      alive: false,
      silentMs: 7 * MIN,
      content: "mezza risposta",
      blocks: [{ kind: "text", text: "mezza risposta" }],
    });
    sweepStaleStreams(h.deps);
    h.deps.activeStreams.set(SK, h.stream);
    sweepStaleStreams(h.deps);
    expect((h.rows.get(MSG)?.blocks as ContentBlock[]).filter((b) => b.kind === "error")).toHaveLength(1);
  });

  /**
   * ...BUT A TOOL 'RUNNING' FOR HOURS IS NOT A CHILD AT WORK.
   *
   * On 2026-09-02 `topic:6b9605e5` and `topic:ada7e7db` sat spinning with a
   * `bash` stuck on `running`: the command had exited, but a backgrounded
   * subshell held the server's pipes open and `runCommand` was waiting for
   * `close`. From in here it was indistinguishable from a long build — 128 and
   * 75 "extending" lines — and the phantom streams also postponed the automatic
   * restart that would have swept them at boot.
   */
  test("un tool 'running' da tre ore e mezza viene chiuso, non prorogato", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true, toolRunningForMs: 210 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
    expect(h.rows.get(MSG)?.partial).toBe(false);
    expect(h.turnsEnded).toEqual([SK]);
    expect(h.aborted).toEqual([SK]);
    expect(h.deps.activeStreams.has(SK)).toBe(false);
    // The log says WHY: whoever reads it must tell this apart from the "alive
    // but stopped with no tool" case, which has a different cure.
    expect(h.warnings.some((w) => /tool 'running' da 210 min/.test(w))).toBe(true);
  });

  test("mezz'ora scarsa di tool resta lavoro: la build lunga non si tocca", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true, toolRunningForMs: 29 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("rescued");
    expect(h.rows.get(MSG)?.partial).toBe(true);
    expect(h.turnsEnded).toEqual([]);
  });

  test("dentro la finestra di silenzio non succede niente", () => {
    const h = harness({ alive: true, silentMs: 1 * MIN });
    expect(sweepStaleStreams(h.deps).size).toBe(0);
    expect(h.resyncs).toEqual([]);
  });
});

describe("il numero nel log è il silenzio VERO", () => {
  const eta = (riga: string): number => {
    const m = /silent for (\d+) min/.exec(riga);
    if (!m) throw new Error(`nessuna età in: ${riga}`);
    return Number(m[1]);
  };

  /**
   * IL DIFETTO M5. Ogni proroga chiama `updateStreamActivity`, quindi al giro
   * dopo `lastActivity` dice «tre minuti fa» qualunque sia il silenzio davvero
   * accumulato: il messaggio non è mai cresciuto oltre la distanza fra due
   * proroghe, e un turno zitto da mezz'ora si annunciava sempre uguale.
   */
  test("l'età cresce di proroga in proroga invece di restare inchiodata", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: true });
    sweepStaleStreams(h.deps); // rescue: spende il soccorso
    const eta_: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.clock.t += 5 * MIN;
      h.warnings.length = 0;
      expect(sweepStaleStreams(h.deps).get(SK)).toBe("extended");
      eta_.push(eta(h.warnings.find((w) => w.includes("extending")) ?? ""));
    }
    // 4 + 5 = 9, poi 14, poi 19. Con il difetto: 5, 5, 5.
    expect(eta_).toEqual([9, 14, 19]);
  });

  test("se il turno ricomincia a parlare il conteggio riparte", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: true });
    sweepStaleStreams(h.deps); // rescue
    h.clock.t += 5 * MIN;
    sweepStaleStreams(h.deps); // extend, silenzio 9 min
    // Output vero: il turno muove l'orologio da solo, oltre la nostra proroga.
    h.clock.t += 1 * MIN;
    h.stream.lastActivity = new Date(h.clock.t).toISOString();
    h.clock.t += 4 * MIN;
    h.warnings.length = 0;
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("extended");
    expect(eta(h.warnings.find((w) => w.includes("extending")) ?? "")).toBe(4);
  });
});

describe("i pannelli aperti sull'umano non contano come morte", () => {
  test("una domanda a schermo dentro il TTL rinvia, non finalizza", () => {
    const h = harness({ alive: true, silentMs: 20 * MIN, humanHoldAgeMs: 5 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("held");
    expect(h.rows.get(MSG)?.partial).toBe(true);
  });

  test("il pannello su un figlio MORTO non salva il turno", () => {
    const h = harness({ alive: false, silentMs: 20 * MIN, humanHoldAgeMs: 5 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
  });
});

describe("le voci rimaste indietro si buttano in silenzio", () => {
  test("il messaggio è già finalizzato nel DB: la voce sparisce senza broadcast", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN });
    const row = h.rows.get(MSG);
    if (row) row.partial = false;
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("dropped");
    expect(h.deps.activeStreams.has(SK)).toBe(false);
    expect(h.turnsEnded).toEqual([]);
  });

  test("le mappe di servizio non crescono per sempre", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN });
    sweepStaleStreams(h.deps);
    expect(h.deps.rescued.size).toBe(1);
    expect(h.deps.silence.size).toBe(1);
    h.deps.activeStreams.delete(SK);
    sweepStaleStreams(h.deps);
    expect(h.deps.rescued.size).toBe(0);
    expect(h.deps.silence.size).toBe(0);
  });
});

/**
 * THE THIRD STATE, live: alive, silent and with nothing in flight.
 *
 * The tests above said "a LIVE child is never closed by the clock", and they
 * meant a child that is WORKING — the 12-minute build. What they encoded was
 * only "alive", and on 2026-08-28 the difference cost real work: once the probe
 * was fixed to tell the truth about who owns the session, `topic:0299ac2d` hung
 * for FIFTEEN MINUTES with zero characters and zero tools, extended on every
 * tick, until it was stopped by hand.
 *
 * "The process is alive" does not mean "the turn is moving". From here down the
 * two cases sit side by side, so the line that separates them is visible.
 * @covers CHAT-01
 */
describe("alive is not enough: it must also be doing something", () => {
  test("with a tool in flight no clock closes it, however long", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: true });
    for (let i = 0; i < 20; i++) {
      sweepStaleStreams(h.deps);
      h.clock.t += 4 * MIN;
    }
    expect(h.rows.get(MSG)?.partial).toBe(true);
    expect(h.turnsEnded).toEqual([]);
  });

  test("with nothing in flight, past the cap it closes and the turn ends", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: false });
    for (let i = 0; i < 20; i++) {
      sweepStaleStreams(h.deps);
      h.clock.t += 4 * MIN;
    }
    expect(h.rows.get(MSG)?.partial).toBe(false);
    expect(h.turnsEnded).toEqual([SK]);
  });
});

/**
 * FINALIZING THE ROW IS NOT STOPPING THE TURN.
 *
 * Everything the finalize branch did (`endStream`, the marker, `recordTurnEnd`,
 * the SSE abort) describes the turn as over. None of it reaches the agent
 * loop of a native turn, which runs INSIDE the server process: on 2026-08-27
 * and 2026-08-29 a turn the user had been told was closed kept spending
 * tokens and running tools, and its blocks landed on the next turn's row. The
 * two watchdogs of `routes/chat.ts` abort the provider on their way out; the
 * sweeper did not.
 */
describe("the sweeper stops the provider's turn, not only the row", () => {
  test("dead child: the provider is aborted, before the row is closed", () => {
    const h = harness({ alive: false, silentMs: 7 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
    expect(h.providerAborts).toEqual([SK]);
    // The loop first, then the row: the same order `/api/chat/abort` keeps, so
    // the provider's own `onAborted` still finds the route's state machine open.
    expect(h.order).toEqual(["abortProvider", "endStream"]);
  });

  test("hung tool: the provider is aborted", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true, toolRunningForMs: 210 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
    expect(h.providerAborts).toEqual([SK]);
  });

  /**
   * 2026-09-04, 11:53-11:59: three deliveries closed as "a promise that never
   * returns" at 31-32 minutes of `update_task(status='review')`, while the
   * board was still grinding their pre-review checks behind a slot queue. The
   * wait was ours; the stall detector already knew it, the sweeper did not.
   */
  test("a tool held open by OUR pre-review checks is extended past the hung cap, provider untouched", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true, toolRunningForMs: 40 * MIN, waitingOnOurChecks: true });
    h.deps.rescued.add(SK);
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("extended");
    expect(h.providerAborts).toEqual([]);
    expect(h.warnings.some((w) => w.includes("waiting on OUR pre-review checks"))).toBe(true);
  });

  test("frozen (alive, nothing in flight, past the cap): the provider is aborted", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN, toolRunning: false });
    let outcome: string | undefined;
    for (let i = 0; i < 20 && outcome !== "finalized"; i++) {
      outcome = sweepStaleStreams(h.deps).get(SK);
      h.clock.t += 4 * MIN;
    }
    expect(outcome).toBe("finalized");
    expect(h.providerAborts).toEqual([SK]);
  });

  test("rescue, extend and held never touch the provider", () => {
    const rescued = harness({ alive: true, silentMs: 7 * MIN, toolRunning: true });
    expect(sweepStaleStreams(rescued.deps).get(SK)).toBe("rescued");
    rescued.clock.t += 4 * MIN;
    expect(sweepStaleStreams(rescued.deps).get(SK)).toBe("extended");
    expect(rescued.providerAborts).toEqual([]);

    const held = harness({ alive: true, silentMs: 20 * MIN, humanHoldAgeMs: 5 * MIN });
    expect(sweepStaleStreams(held.deps).get(SK)).toBe("held");
    expect(held.providerAborts).toEqual([]);
  });

  test("a provider abort that throws does not stop the finalize", () => {
    const h = harness({ alive: false, silentMs: 7 * MIN });
    h.deps.abortProvider = () => { throw new Error("no owner"); };
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("finalized");
    expect(h.rows.get(MSG)?.partial).toBe(false);
    expect(h.turnsEnded).toEqual([SK]);
  });
});
