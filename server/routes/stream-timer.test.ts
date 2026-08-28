/**
 * Stream timer state machine — behavioral tests.
 *
 * The timer logic in topics.ts is intentionally inline (it closes over
 * `fullContent`, `partialMsg`, broadcast helpers, etc.) so we can't import
 * it directly. Instead this file unit-tests a *replica* of the same state
 * machine and exercises the invariants that the spec
 * `stream-timeout-resilience` codifies:
 *
 *   1. While ≥1 tool call is in `running` state, the soft inactivity timer
 *      is suspended (NEVER fires).
 *   2. After all tool calls finalize, the soft timer arms and fires after
 *      STREAM_TIMEOUT_MS of true silence.
 *   3. When the soft timeout fires, a "stream slow" annotation is added but
 *      the stream is NOT finalized yet — a grace period starts.
 *   4. A provider event during the grace period strips the annotation and
 *      transitions back to "streaming".
 *   5. The grace period expiring without events finalizes the stream as
 *      timed out and removes the annotation in favor of the hard marker.
 *   6. The hard cap is symmetric with the grace window: while the provider
 *      process is ALIVE it EXTENDS (a live, working turn is never killed —
 *      CLI parity: the terminal `claude` has no wall-clock session kill); only
 *      a DEAD process is finalized by the cap (the orphan backstop).
 *   7. Grace expiry with the provider process still ALIVE (auto-compact:
 *      the CLI is mute for 3+ min while compacting) EXTENDS the grace
 *      window instead of finalizing — only a dead process (or the hard
 *      cap) finalizes as timeout.
 *   8. Il soft timer è armato allo START, non al primo evento: un turno che
 *      non emette MAI nulla deve finire nella stessa macchina a stati, non
 *      nel silenzio.
 *   9. Un abort deciso da fuori la route (sweeper StaleStream) finalizza e
 *      spegne ogni timer: è il segnale che chiude la risposta SSE.
 *  10. L'insieme dei tool in corso si aggiorna PRIMA di riarmare il timer, a
 *      tutte e due le estremità. `armSoftTimer` non riceve un conteggio: legge
 *      l'insieme com'è nell'istante della chiamata. Le prime due prove di
 *      questo file lo assumevano da sempre; la route faceva il contrario, e i
 *      due difetti erano speculari — watchdog spento dopo l'ultimo risultato di
 *      tool, «sta rallentando» spurio al primo tool del turno.
 *
 *  11. An ANNOUNCED tool is not a working tool. On providers that tell the two
 *      apart (`tool-phases`) the suspension hangs on the start of EXECUTION,
 *      not on the announcement: otherwise the fastest guard is blind for the
 *      whole window in which the model writes the call. On providers that
 *      cannot tell them apart, the announcement keeps counting.
 *
 * @covers CHAT-REL-03
 *
 * The replica below is kept in one-to-one structural correspondence with
 * the route code; if either drifts, this file should fail and the
 * chat.ts code should be re-aligned, NOT the test. (Il codice vero sta in
 * `routes/chat.ts`: `armSoftTimer`, `resetStreamTimer`, `settleTrackedTool`.)
 */

import { describe, expect, test } from "bun:test";
import { toolsSuspendSoftTimer } from "../lib/soft-timer-suspension";

// ── Replica of the route timer state machine (mirror of topics.ts) ──────
// Constants match the production values exactly. Don't drift them.
const STREAM_TIMEOUT_MS = 60_000;
const STREAM_GRACE_MS = 60_000;
const STREAM_HARD_TIMEOUT_MS = 30 * 60_000;
// L'annotazione NON viene piu' scritta nel contenuto (fix del 30/07: finiva nella
// storia e tornava al modello a ogni turno successivo). Resta qui perche' la
// replica deve modellare anche `stripSlowAnnotation`, che il codice vero tiene per
// i parziali RILETTI dal DB — un messaggio scritto da un server ancora in volo col
// codice vecchio puo' ancora portarla.
const STREAM_SLOW_ANNOTATION =
  "\n\n---\n*[⏱ stream lento — il provider è ancora connesso]*";

interface Harness {
  state: "streaming" | "soft-timed-out" | "finalized";
  fullContent: string;
  trackedToolCallIds: string[];
  /** Mirror of `executingToolCallIds`: tools that REALLY started. */
  executingToolCallIds: string[];
  log: string[];
  /** Callbacks the route would actually run; we just record them. */
  events: string[];
  /** Mirror of `topicProvider.isTurnProcessAlive?.(sessionKey)` — the route
   *  treats a missing method as falsy, so the replica defaults to false. */
  providerAlive: boolean;
}

/**
 * Build a fresh state machine wired to a Harness for inspection.
 *
 * `signalsExecStart` mirrors `topicProvider.capabilities.has("tool-phases")`:
 * false is the CLI, which never says when a call starts running, so for it the
 * announcement keeps counting as execution.
 */
function build(signalsExecStart = false) {
  const h: Harness = {
    state: "streaming",
    fullContent: "",
    trackedToolCallIds: [],
    executingToolCallIds: [],
    log: [],
    events: [],
    providerAlive: false,
  };

  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  const stripSlow = (s: string) =>
    s.endsWith(STREAM_SLOW_ANNOTATION)
      ? s.slice(0, -STREAM_SLOW_ANNOTATION.length)
      : s;

  const graceExpiry = () => {
    if (h.state !== "soft-timed-out") return;
    // Mirror of handleGraceExpiry's liveness branch: a live-but-mute child
    // (auto-compact) extends the grace window instead of finalizing.
    if (h.providerAlive) {
      h.events.push("grace-extended");
      graceTimer = setTimeout(graceExpiry, STREAM_GRACE_MS);
      return;
    }
    h.state = "finalized";
    h.fullContent = stripSlow(h.fullContent) + "\n\n---\n*[Response timed out]*";
    h.events.push("grace-expired");
  };

  const armSoft = () => {
    if (h.state !== "streaming") return;
    if (softTimer) clearTimeout(softTimer);
    if (toolsSuspendSoftTimer({
      announced: h.trackedToolCallIds.length,
      executing: h.executingToolCallIds.length,
      providerSignalsExecStart: signalsExecStart,
    })) { softTimer = null; return; }
    softTimer = setTimeout(() => {
      if (h.state !== "streaming") return;
      h.state = "soft-timed-out";
      // NON tocca `fullContent`: dal 30/07 la lentezza e' un EVENTO
      // (`stream:slow`, reso da TurnActivityIndicator), non testo appeso al
      // messaggio. Vedi il commento su STREAM_SLOW_ANNOTATION sopra.
      h.events.push("soft-timeout");
      graceTimer = setTimeout(graceExpiry, STREAM_GRACE_MS);
    }, STREAM_TIMEOUT_MS);
  };

  const recover = () => {
    if (h.state !== "soft-timed-out") return;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    h.state = "streaming";
    h.fullContent = stripSlow(h.fullContent);
    h.events.push("recovered");
  };

  const onEvent = () => {
    if (h.state === "finalized") return;
    if (h.state === "soft-timed-out") recover();
    armSoft();
  };

  // L'ORDINE è la cosa in prova, non un dettaglio di scrittura: `armSoft` legge
  // `trackedToolCallIds` com'è in questo istante, quindi ogni callback deve aver
  // già applicato l'evento a cui reagisce. Mirror di `onToolStart` e
  // `settleTrackedTool` in routes/chat.ts.
  const onToolStart = (id: string) => {
    h.trackedToolCallIds.push(id);
    onEvent();
  };
  /** Mirror di `settleTrackedTool`: PRIMA lo splice, POI il riarmo. */
  const settleTool = (id: string) => {
    const i = h.trackedToolCallIds.indexOf(id);
    if (i >= 0) h.trackedToolCallIds.splice(i, 1);
    const r = h.executingToolCallIds.indexOf(id);
    if (r >= 0) h.executingToolCallIds.splice(r, 1);
    onEvent();
  };
  /** Mirror of `markToolExecuting`: the call is running now, not announced. */
  const onToolExecStart = (id: string) => {
    if (!h.executingToolCallIds.includes(id)) h.executingToolCallIds.push(id);
    onEvent();
  };
  const onToolResult = settleTool;
  /**
   * Mirror dei quattro esiti della dispatch in-process (`browser_*` e control
   * tool): il tool lo esegue la route, e la sua promise si risolve fuori dal
   * flusso degli eventi del provider. Passano dallo STESSO `settleTrackedTool`
   * — prima non passavano da niente: toglievano l'id a mano e non riarmavano.
   */
  const onDispatchedToolDone = settleTool;

  // Mirror of handleHardTimeout: the hard cap is now symmetric with the grace
  // window — a live child is NEVER killed (CLI parity: no wall-clock session
  // kill of a working turn). Only a DEAD process is finalized by the cap.
  const hardExpiry = () => {
    if (h.state === "finalized") return;
    if (h.providerAlive) {
      h.events.push("hard-extended");
      hardTimer = setTimeout(hardExpiry, STREAM_HARD_TIMEOUT_MS);
      return;
    }
    h.state = "finalized";
    h.fullContent = stripSlow(h.fullContent) + "\n\n---\n*[Hard timeout (30 min) reached]*";
    h.events.push("hard-timeout");
  };
  hardTimer = setTimeout(hardExpiry, STREAM_HARD_TIMEOUT_MS);
  // Il soft timer parte allo start, non al primo evento: il silenzio iniziale
  // (provider che non emette MAI nulla) è il caso che prima passava inosservato.
  armSoft();

  const finalize = (reason: "done" | "aborted" | "error") => {
    if (softTimer) clearTimeout(softTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (h.state === "soft-timed-out") {
      h.fullContent = stripSlow(h.fullContent);
      h.events.push("recovered-on-finalize");
    }
    h.state = "finalized";
    h.events.push(`finalize:${reason}`);
  };

  // Mirror del listener su `externalAbort.signal`: lo sweeper StaleStream ha
  // già chiuso il turno in DB e via WS, qui resta da liberare il client SSE.
  const externalAbort = () => {
    if (h.state === "finalized") return;
    if (softTimer) clearTimeout(softTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    h.state = "finalized";
    h.events.push("sse-closed");
  };

  return { h, onEvent, onToolStart, onToolExecStart, onToolResult, onDispatchedToolDone, finalize, externalAbort };
}

// We use bun's fake timers via setTimeout monkey-patching: bun:test's
// `setSystemTime` helper isn't suitable for setTimeout, so we drive time
// manually using a simple stub.
function withFakeTimers<T>(fn: (advance: (ms: number) => void) => T): T {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  type Job = { id: number; at: number; cb: () => void; cancelled: boolean };
  const queue: Job[] = [];
  let now = 0;
  let nextId = 1;

  (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
    const job: Job = { id: nextId++, at: now + ms, cb, cancelled: false };
    queue.push(job);
    return job.id as any;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    const job = queue.find(j => j.id === id);
    if (job) job.cancelled = true;
  };

  const advance = (ms: number) => {
    const target = now + ms;
    while (true) {
      const due = queue
        .filter(j => !j.cancelled && j.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.cancelled = true;
      due.cb();
    }
    now = target;
  };

  try {
    return fn(advance);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

describe("stream timer state machine", () => {
  test("Fix A: long-running tool does NOT trigger soft timeout", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart } = build();
      onToolStart("tool-1");
      // 5 minutes of silence with the tool still running.
      advance(5 * 60_000);
      expect(h.state).toBe("streaming");
      expect(h.events).toEqual([]);
    });
  });

  test("Fix A: timer arms after tool finishes and fires after STREAM_TIMEOUT_MS", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult } = build();
      onToolStart("tool-1");
      advance(60_000); // 1 min while tool running — no fire
      onToolResult("tool-1");
      // Now the soft timer has just been (re-)armed. It should NOT fire
      // for the first ~119s after the tool result.
      advance(STREAM_TIMEOUT_MS - 1);
      expect(h.state).toBe("streaming");
      // Tick past the threshold.
      advance(2);
      expect(h.state).toBe("soft-timed-out");
      expect(h.events).toContain("soft-timeout");
    });
  });

  test("Fix D: un evento durante la grace recupera, e il contenuto non e' mai stato toccato", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      onEvent(); // arm soft timer
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
      // Il soft timeout cambia STATO e annuncia, e basta: il messaggio resta
      // quello che era.
      expect(h.fullContent).toBe("");
      // Half-grace, provider sneezes back to life.
      advance(30_000);
      onEvent();
      expect(h.state).toBe("streaming");
      expect(h.fullContent).toBe("");
      expect(h.events).toContain("recovered");
    });
  });

  test("grace expires without events → finalized as timed out", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      onEvent();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 1);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
      expect(h.fullContent).toContain("Response timed out");
      expect(h.fullContent).not.toContain("⏱ stream lento");
    });
  });

  test("Fix D recovery on finalize(done) strips annotation", () => {
    withFakeTimers((advance) => {
      const { h, onEvent, finalize } = build();
      onEvent();
      advance(STREAM_TIMEOUT_MS + 5_000);
      expect(h.state).toBe("soft-timed-out");
      // Provider's onDone arrives during grace — finalize(done) should
      // strip the slow annotation and treat the run as a recovery.
      finalize("done");
      expect(h.state).toBe("finalized");
      expect(h.fullContent).not.toContain("⏱ stream lento");
      expect(h.events).toContain("recovered-on-finalize");
    });
  });

  test("auto-compact: grace extends while the provider process is alive, then recovers", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true; // the child is compacting: mute but alive
      onEvent(); // arm soft timer
      // Real-world shape of the 2026-07-20 incident: 188s of total silence.
      advance(STREAM_TIMEOUT_MS + 1); // 60s → soft timeout
      expect(h.state).toBe("soft-timed-out");
      advance(STREAM_GRACE_MS); // 120s → grace expiry #1: alive → extend
      expect(h.state).toBe("soft-timed-out");
      advance(STREAM_GRACE_MS); // 180s → grace expiry #2: alive → extend
      expect(h.state).toBe("soft-timed-out");
      expect(h.events.filter((e) => e === "grace-extended").length).toBe(2);
      // ~195s: compaction done, the provider emits again → full recovery.
      advance(15_000);
      onEvent();
      expect(h.state).toBe("streaming");
      expect(h.fullContent).not.toContain("⏱ stream lento");
      expect(h.events).toContain("recovered");
    });
  });

  test("grace expiry with a DEAD provider process still finalizes as timeout", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true;
      onEvent();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 1); // one extension granted
      expect(h.state).toBe("soft-timed-out");
      h.providerAlive = false; // child dies during the extended window
      advance(STREAM_GRACE_MS);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
      expect(h.fullContent).toContain("Response timed out");
    });
  });

  test("provider alive forever + total silence → the hard cap EXTENDS, never kills a live turn (CLI parity)", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true; // wedged-but-alive child — like the terminal CLI, never SIGKILL it
      onEvent();
      // Three full hard windows (90 min) of total silence with the child alive.
      advance(STREAM_HARD_TIMEOUT_MS * 3 + 1);
      expect(h.state).not.toBe("finalized");
      expect(h.events.filter((e) => e === "hard-extended").length).toBeGreaterThanOrEqual(3);
      expect(h.events).not.toContain("hard-timeout");
    });
  });

  test("hard cap finalizes only a DEAD process (backstop) after 30 min", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult } = build();
      // providerAlive defaults to false: a dead/orphaned child. Tool churn keeps
      // the soft timer suspended so only the hard cap can fire.
      for (let i = 0; i < 30; i++) {
        onToolStart(`t-${i}`);
        advance(60_000);
        onToolResult(`t-${i}`);
      }
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("hard-timeout");
      expect(h.fullContent).toContain("Hard timeout");
    });
  });

  test("a turn making progress re-arms the soft window and the hard cap never trips while alive", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true;
      // Emit an event every ~20 min for 2 hours — real (if sparse) progress.
      for (let i = 0; i < 6; i++) {
        onEvent();
        advance(20 * 60_000);
      }
      // Never finalized: the child is alive throughout; the hard cap extended.
      expect(h.state).not.toBe("finalized");
      expect(h.events).not.toContain("hard-timeout");
    });
  });
});

/**
 * Le due falle che lasciavano la chat "appesa a caricare" (2026-07-29).
 */
describe("turno che non parte / finalizzato da fuori", () => {
  test("silenzio TOTALE dallo start: il soft timer scatta lo stesso", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      // Nessun evento: la CLI è viva ma non emette niente (MCP appeso, resume
      // che non parte). Prima il soft timer si armava solo dal primo evento,
      // quindi questo caso non produceva NÉ annuncio NÉ timeout.
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.events).toContain("soft-timeout");
      // L'annuncio c'è; il contenuto resta vuoto perché nessuno ci scrive.
      expect(h.fullContent).toBe("");
    });
  });

  test("silenzio totale + processo morto: si finalizza al termine della grace", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 2);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
    });
  });

  test("silenzio totale ma processo vivo: si estende, non si uccide", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      h.providerAlive = true;
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS * 5);
      expect(h.state).not.toBe("finalized");
      expect(h.events).toContain("grace-extended");
    });
  });

  test("abort esterno (sweeper StaleStream): chiude l'SSE e spegne i timer", () => {
    withFakeTimers((advance) => {
      const { h, onEvent, externalAbort } = build();
      onEvent();
      externalAbort();
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("sse-closed");
      // Nessun timer sopravvive all'abort: niente soft/grace/hard in ritardo su
      // uno stream già chiuso.
      advance(STREAM_HARD_TIMEOUT_MS * 2);
      expect(h.events.filter((e) => e === "soft-timeout")).toHaveLength(0);
      expect(h.events).not.toContain("hard-timeout");
    });
  });

  test("abort esterno dopo una finalizzazione normale: no-op", () => {
    withFakeTimers(() => {
      const { h, onEvent, finalize, externalAbort } = build();
      onEvent();
      finalize("done");
      externalAbort();
      expect(h.events).not.toContain("sse-closed");
      expect(h.events.filter((e) => e.startsWith("finalize:"))).toEqual(["finalize:done"]);
    });
  });
});

/**
 * L'ORDINE fra la mutazione dell'insieme dei tool e il riarmo del timer.
 *
 * `armSoftTimer` non riceve niente: legge `trackedToolCallIds` com'è nell'istante
 * in cui lo chiami. Chi riarma PRIMA di aver applicato il proprio evento gli fa
 * leggere lo stato di un attimo fa, e il risultato è un watchdog che si comporta
 * al contrario alle due estremità del turno.
 */
describe("l'insieme dei tool si aggiorna PRIMA di riarmare il timer", () => {
  test("ultimo risultato di tool, poi silenzio: il soft timeout scatta e la grace parte", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult } = build();
      onToolStart("solo-tool");
      advance(5 * 60_000); // il tool lavora: nessun timer, per contratto
      expect(h.events).toEqual([]);

      onToolResult("solo-tool");
      // Da qui in poi non c'è più niente in corso: il silenzio è silenzio.
      // Riarmando PRIMA dello splice, `armSoftTimer` vedeva ancora un tool
      // «in corso», metteva `softTimer = null` e nessuno lo rimetteva: il
      // watchdog restava spento per tutto il resto del turno.
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
      expect(h.events).toContain("soft-timeout");

      // E la grace è davvero partita: senza eventi, il turno si chiude.
      advance(STREAM_GRACE_MS + 1);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
    });
  });

  test("primo tool di un turno: il timer resta sospeso, nessun cartello «sta rallentando»", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart } = build();
      // Un tool che ci mette due minuti (un `bun test`, uno spawn MCP) è la
      // norma. Con la push DOPO il riarmo, `armSoftTimer` vedeva l'insieme
      // vuoto, armava un minuto contro un turno che stava aspettando per
      // costruzione, e a 60 s partiva `stream:slow` su un turno sanissimo.
      onToolStart("primo-tool");
      advance(STREAM_TIMEOUT_MS * 3);
      expect(h.state).toBe("streaming");
      expect(h.events).not.toContain("soft-timeout");
    });
  });

  test("un tool eseguito dalla route (browser_*/control): alla sua fine il timer torna armato", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult, onDispatchedToolDone } = build();
      // Due tool in volo, e a chiudere è quello che esegue la ROUTE: così
      // l'ultimo evento del provider (`onToolResult`) cade mentre c'è ancora
      // qualcosa in corso, e l'unica cosa che può riarmare il timer è la
      // chiusura della dispatch. Con un tool solo il test sarebbe passato per
      // il motivo sbagliato — sul codice vecchio lo armava `onToolStart`.
      onToolStart("Read-1");
      onToolStart("browser_open-1");
      advance(30_000);
      onToolResult("Read-1");
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("streaming"); // il browser tool sta ancora lavorando

      // Questi quattro esiti toglievano l'id a mano e basta: nessun riarmo, e
      // il turno restava senza watchdog fino al prossimo evento del provider —
      // che su un turno wedged non arriva mai.
      onDispatchedToolDone("browser_open-1");
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
      expect(h.events).toContain("soft-timeout");
    });
  });
});

/**
 * ANNOUNCING A TOOL IS NOT RUNNING ONE (2026-08-28).
 *
 * `onToolStart` fires at `content_block_start`: the model has started WRITING
 * the call, and on the native runtime execution only happens once the round has
 * closed. Suspending the soft timer there switched the fastest guard off for
 * that whole window (two minutes in the measured case), and a turn that died
 * inside it told nobody. The line not to cross is the other one: a tool that
 * really RUNS for a long time must keep suspending it.
 */
describe("annunciato non è in esecuzione", () => {
  test("tool annunciato e mai partito: il timer resta armato e il cartello arriva", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart } = build(true);
      onToolStart("annunciato-mai-partito");
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
      expect(h.events).toContain("soft-timeout");
      // And with no events the turn closes, instead of hanging open forever.
      advance(STREAM_GRACE_MS + 1);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
    });
  });

  test("tool che ESEGUE a lungo: sospeso come prima, la build da 12 minuti è salva", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolExecStart } = build(true);
      onToolStart("build");
      advance(3_000); // the model finishes writing the call
      onToolExecStart("build");
      advance(12 * 60_000);
      expect(h.state).toBe("streaming");
      expect(h.events).not.toContain("soft-timeout");
    });
  });

  test("finito il tool, il timer torna armato: l'esecuzione esce dall'insieme", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolExecStart, onToolResult } = build(true);
      onToolStart("t");
      onToolExecStart("t");
      advance(5 * 60_000);
      expect(h.events).toEqual([]);
      onToolResult("t");
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
    });
  });

  test("il provider che non sa distinguere non perde niente: l'annuncio sospende", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart } = build(false);
      onToolStart("cli-tool");
      advance(STREAM_TIMEOUT_MS * 3);
      expect(h.state).toBe("streaming");
      expect(h.events).not.toContain("soft-timeout");
    });
  });
});
