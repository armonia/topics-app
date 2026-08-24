/**
 * @covers CHAT-REL-05
 *
 * Parziale: la pulizia degli stream attivi rimasti appesi. Il ramo che sgancia
 * lo stream alla chiusura ordinata del turno sta in chat-stream-abort.test.ts.
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

const MIN = 60_000;
const SK = "topic:e1ea0e41";
const MSG = "msg-1";

interface Harness {
  deps: StaleStreamSweepDeps;
  clock: { t: number };
  rows: Map<string, { content: string; partial: boolean }>;
  warnings: string[];
  aborted: string[];
  resyncs: string[];
  turnsEnded: string[];
  stream: SweepableStream;
}

function harness(opts?: {
  alive?: boolean;
  content?: string;
  silentMs?: number;
  humanHoldAgeMs?: number | null;
}): Harness {
  const clock = { t: Date.UTC(2026, 7, 15, 12, 0, 0) };
  const silent = opts?.silentMs ?? 7 * MIN;
  const rows = new Map([[MSG, { content: opts?.content ?? "", partial: true }]]);
  const warnings: string[] = [];
  const aborted: string[] = [];
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
    resyncStream: (sk) => resyncs.push(sk),
    cancelAsk: () => {},
    // La proroga vera: sposta l'orologio dello stream ad ADESSO. È esattamente
    // ciò che rendeva illeggibile il numero nel messaggio di log.
    updateStreamActivity: (sk) => {
      const s = activeStreams.get(sk);
      if (s) s.lastActivity = new Date(clock.t).toISOString();
    },
    getTopicId: () => "topic-1",
    // Come il vero `ctx.endStream`: chiude i tool rimasti 'running' E toglie la
    // voce dalla mappa. È lui il proprietario della cancellazione, non il giro.
    endStream: (sk) => { activeStreams.delete(sk); return []; },
    broadcast: () => {},
    finalizeMessage: ({ messageId, marker }) => {
      const row = rows.get(messageId);
      if (!row) return;
      row.partial = false;
      if (marker !== null) row.content = marker;
    },
    recordTurnEnd: (sk) => turnsEnded.push(sk),
    warn: (m) => warnings.push(m),
    info: (m) => warnings.push(m),
  };
  return { deps, clock, rows, warnings, aborted, resyncs, turnsEnded, stream };
}

describe("un figlio VIVO non viene chiuso dall'orologio", () => {
  /**
   * IL CASO DELL'ITEM T3, per intero: 7 minuti di silenzio, il provider giura
   * che il figlio è vivo, due tick. La riga parziale deve restare intatta.
   */
  test("due tick a 7 minuti di silenzio: la riga parziale non si tocca", () => {
    const h = harness({ alive: true, silentMs: 7 * MIN });
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("rescued");
    expect(h.resyncs).toEqual([SK]);
    // Passa un altro giro di silenzio: il soccorso è speso, il figlio è vivo.
    h.clock.t += 4 * MIN;
    expect(sweepStaleStreams(h.deps).get(SK)).toBe("extended");
    expect(h.rows.get(MSG)).toEqual({ content: "", partial: true });
    expect(h.turnsEnded).toEqual([]);
    expect(h.aborted).toEqual([]);
    expect(h.deps.activeStreams.has(SK)).toBe(true);
    // E non si ri-soccorre a ogni giro: il resync è UNO.
    expect(h.resyncs).toEqual([SK]);
  });

  test("dieci tick di fila non lo consumano: la proroga non è un conto alla rovescia", () => {
    const h = harness({ alive: true, silentMs: 4 * MIN });
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
    expect(h.rows.get(MSG)).toEqual({ content: "mezza risposta", partial: false });
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
    const h = harness({ alive: true, silentMs: 4 * MIN });
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
    const h = harness({ alive: true, silentMs: 4 * MIN });
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
