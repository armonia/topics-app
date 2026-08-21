/**
 * IL `result` VUOTO DI UNA COMPATTAZIONE CHIUDE IL TURNO.
 *
 * Il guasto che questo file inchioda, misurato dal vivo il 20/08/2026 su
 * topic:44d914ec: si scrive `/compact`, la CLI compatta davvero (il
 * `compact_boundary` arriva, il marker si salva, il divider «Contesto
 * compattato» si disegna in chat) — e il turno non finisce MAI. Trenta minuti
 * dopo il watchdog uccide il figlio e in chat compare «⚠️ Nessuna attività dal
 * modello per 30 minuti. Turno terminato.» sopra una compattazione riuscita.
 * La riga in DB porta `latency_ms = 1975077`, cioè trentatré minuti.
 *
 * La causa non era nel watchdog: era una riga sola nel provider,
 *
 *     if (!resultText || resultText === "waiting for message") return;
 *
 * che scartava OGNI `result` senza testo. E il `result` di una compattazione è
 * senza testo per costruzione — registrato dalla CLI 2.1.237, che è la forma
 * usata come fixture qui sotto:
 *
 *     {"type":"result","subtype":"success","is_error":false,
 *      "num_turns":0,"stop_reason":null,"result":"","duration_ms":46756}
 *
 * Non c'è nessuna risposta da mostrare perché l'esito della compattazione è il
 * divider, che viaggia su un altro evento. Ma quel frame è comunque LA fine del
 * turno: è l'unico che risolve la promessa (sbloccando la coda seriale dei turni
 * successivi), stacca lo `streamHandler` e ferma l'heartbeat.
 *
 * Da qui discendevano tre sintomi che sembravano tre bug diversi:
 *   - `/compact` "si pianta" e muore a mezz'ora;
 *   - i messaggi scritti dopo non partivano — il drain della coda è appeso alla
 *     FINE di uno stream, e questo stream non finiva mai;
 *   - la chat mostrava un errore su un'operazione riuscita.
 *
 * La sentinella `waiting for message` resta l'unica riga scartata: quella la
 * CLI la emette a vuoto, senza nessun turno in corso.
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

function fakePP(over: Record<string, unknown> = {}) {
  return {
    alive: true,
    aborting: false,
    sessionKey: "topic:test",
    streamHandler: null as null | Record<string, unknown>,
    pendingResolve: null as null | ((v: unknown) => void),
    pendingReject: null,
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    activeToolCalls: new Map(),
    settledToolCalls: new Set(),
    streamingToolInputs: new Map(),
    spawnMeta: { isNewSession: true, claudeSessionId: null },
    lastEventAt: Date.now(),
    ...over,
  };
}

function spyHandler() {
  const calls: string[] = [];
  return {
    calls,
    onError: (m: string) => calls.push(`error:${m}`),
    onAborted: () => calls.push("aborted"),
    onDone: (m?: { result?: string }) => calls.push(`done:${m?.result ?? ""}`),
  };
}

/** La forma REGISTRATA del result che la CLI emette dopo una compattazione. */
const RESULT_COMPACTION = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  stop_reason: null,
  result: "",
  duration_ms: 46756,
  total_cost_usd: 1.0386950000000001,
};

describe("result vuoto — la fine di un turno di compattazione", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const emit = (pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);

  test("il result senza testo di /compact CHIUDE il turno (onDone + promessa risolta)", () => {
    const h = spyHandler();
    let resolved = false;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved = true; } });

    emit(pp, RESULT_COMPACTION);

    // Senza questo il turno resta aperto e muore al watchdog dei 30 minuti.
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(true);
    // Handler staccato: il turno è finito, non è più in ascolto.
    expect(pp.streamHandler).toBeNull();
  });

  test("'waiting for message' resta rumore: non chiude niente", () => {
    const h = spyHandler();
    let resolved = false;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved = true; } });

    emit(pp, { type: "result", subtype: "success", is_error: false, result: "waiting for message" });

    expect(h.calls).toEqual([]);
    expect(resolved).toBe(false);
    expect(pp.streamHandler).toBe(h);
  });

  test("un result con testo continua a chiudere il turno, col suo testo", () => {
    const h = spyHandler();
    const pp = fakePP({ streamHandler: h });

    emit(pp, { type: "result", subtype: "success", is_error: false, result: "fatto" });

    expect(h.calls).toEqual(["done:fatto"]);
  });

  test("un result d'errore senza testo chiude comunque il turno", () => {
    // `error_during_execution` con `result: ""` esisteva già (vedi
    // RESULT_MISSING_SESSION nelle fixture) e cadeva nello stesso buco: il
    // recupero della sessione partiva, ma il turno restava aperto lo stesso.
    const h = spyHandler();
    let resolved = false;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved = true; } });

    emit(pp, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["qualcosa è andato storto"],
      result: "",
    });

    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(true);
  });
});
