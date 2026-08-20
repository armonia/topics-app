/**
 * IL TURNO CHE LA CLI APRE DA SOLA — e che fino a ieri si perdeva intero.
 *
 * ── Il fatto, misurato ─────────────────────────────────────────────────────
 * Un `Monitor` (il tool di Claude Code che sorveglia un comando lungo e avvisa
 * quando succede qualcosa) NON consegna il suo evento dentro il turno che l'ha
 * armato: quel turno è finito da un pezzo. Lo consegna aprendo un TURNO NUOVO.
 * Registrato il 20/08/2026 con la CLI 2.1.237 lanciata con la stessa argv che
 * usa Topics (`--print --input-format stream-json --include-partial-messages`),
 * Monitor su `sleep 12; echo BUILD-FALLITO-XYZ`:
 *
 *     [16.1s] assistant tool_use:Monitor
 *     [21.5s] result/success  "Armato."          ← il turno finisce QUI
 *     [28.8s] system/task_notification            ← l'evento del Monitor
 *     [29.3s] system/init                         ← la CLI riapre DA SOLA
 *     [32.5s] assistant text:"Event ricevuto: `BUILD-FALLITO-XYZ`"
 *     [35.6s] result/success "Event ricevuto: `BUILD-FALLITO-XYZ`"
 *
 * ── Perché si perdeva ──────────────────────────────────────────────────────
 * `onDone` azzera `pp.streamHandler`: dopo un `result` nessuno ascolta più
 * quella sessione. Gli eventi del turno risvegliato trovavano `handler === null`
 * e cadevano uno per uno, in silenzio — né in chat né nel DB. Il tool
 * funzionava; spariva la RISPOSTA, che è la sola cosa per cui lo si arma. Ecco
 * perché il Monitor si presentava come «forse c'era e si è perso».
 *
 * ── Cosa pinna questo file ─────────────────────────────────────────────────
 * Il contratto del provider, ai suoi due estremi:
 *  · un turno che nasce senza handler SVEGLIA qualcuno invece di cadere;
 *  · gli eventi arrivati mentre la sveglia lavora NON si perdono: si consegnano
 *    dopo, nell'ordine giusto.
 * E le tre esclusioni che tengono la sveglia onesta: durante una riadozione
 * (che rilegge di proposito turni già finiti), quando un handler c'è già, e per
 * gli eventi che non sono contenuto.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import type { StreamHandler } from "./types";

function makeProviderWithStubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp };
}

/** Un handler che registra solo ciò che serve a queste asserzioni. */
function makeHandler() {
  const texts: string[] = [];
  const tools: string[] = [];
  let done: string | null = null;
  const handler: StreamHandler = {
    onTextDelta: (t: string) => { texts.push(t); },
    onToolStart: (_id: string, name: string) => { tools.push(name); },
    onToolResult: () => {},
    onDone: (r) => { done = r?.result ?? ""; },
    onError: () => {},
  };
  return { handler, texts, tools, get done() { return done; } };
}

const emit = (provider: unknown, pp: unknown, event: unknown) =>
  (provider as any).handleStreamEvent(pp, event);

/** Un evento `assistant` con un solo blocco di testo, come li manda la CLI. */
const testo = (text: string) => ({
  type: "assistant",
  message: { id: `msg_${text.length}`, role: "assistant", content: [{ type: "text", text }] },
});

describe("claude-code · il turno che nasce da solo", () => {
  test("senza handler, un evento di contenuto SVEGLIA invece di cadere", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken1");
    const sveglie: string[] = [];
    provider.observeWokenTurns((sk) => sveglie.push(sk));

    // Il turno precedente è finito: nessun handler. È lo stato esatto in cui
    // arrivava la risposta del Monitor.
    expect(pp.streamHandler).toBeNull();
    emit(provider, pp, testo("Event ricevuto: BUILD-FALLITO-XYZ"));

    expect(sveglie).toEqual(["topic:woken1"]);
  });

  test("la sveglia si chiama UNA volta, non a ogni evento del risveglio", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken2");
    const sveglie: string[] = [];
    provider.observeWokenTurns((sk) => sveglie.push(sk));

    // La CLI manda un `assistant` per BLOCCO di contenuto: se ogni evento
    // svegliasse, un turno risvegliato aprirebbe dieci righe in chat.
    emit(provider, pp, testo("prima"));
    emit(provider, pp, testo("seconda"));
    emit(provider, pp, testo("terza"));

    expect(sveglie).toEqual(["topic:woken2"]);
  });

  test("gli eventi arrivati durante l'adozione si consegnano DOPO, in ordine", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken3");
    provider.observeWokenTurns(() => { /* adozione asincrona: qui non fa nulla */ });

    // Fra la sveglia e l'handler passa una INSERT sul DB: in quel buco la CLI
    // continua a parlare. Questi tre eventi sono ciò che si perdeva.
    // Un `assistant` porta un BLOCCO, e il blocco è già il pezzo nuovo: il
    // provider lo appende a `fullText` così com'è (vedi `onTextDelta` in
    // claude-code.ts). Quindi il testo atteso è la concatenazione, ed è anche
    // il modo in cui questo test dimostra l'ORDINE: invertirli darebbe
    // "due parti" invece di "prima parte, seconda".
    emit(provider, pp, testo("prima parte, "));
    emit(provider, pp, { type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    emit(provider, pp, testo("seconda"));

    const h = makeHandler();
    expect(provider.adoptWokenTurn("topic:woken3", h.handler)).toBe(true);

    // Consegnati tutti e tre, nell'ordine di arrivo.
    expect(h.texts.join("")).toBe("prima parte, seconda");
    expect(h.tools).toEqual(["Bash"]);
  });

  test("il turno adottato si chiude normalmente: il `result` arriva a onDone", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken4");
    provider.observeWokenTurns(() => {});
    emit(provider, pp, testo("Event ricevuto"));

    const h = makeHandler();
    provider.adoptWokenTurn("topic:woken4", h.handler);
    emit(provider, pp, { type: "result", subtype: "success", is_error: false, result: "Event ricevuto", duration_ms: 900 });

    expect(h.done).toBe("Event ricevuto");
    // Turno chiuso: l'handler è stato mollato, come per ogni altro turno.
    expect(pp.streamHandler).toBeNull();
  });

  test("una RIADOZIONE non sveglia niente: sta rileggendo turni già finiti", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken5");
    const sveglie: string[] = [];
    provider.observeWokenTurns((sk) => sveglie.push(sk));

    // È la guardia che conta davvero. `reattach` ripercorre di proposito uno
    // store che contiene turni VECCHI: senza questa esclusione ogni riavvio del
    // server «sveglierebbe» un turno di ieri e ne scriverebbe la risposta in
    // chat una seconda volta.
    pp.replayMute = true;
    emit(provider, pp, testo("risposta di un turno di ieri"));
    pp.replayMute = false;

    pp.replaySilent = true;
    emit(provider, pp, testo("un altro turno di ieri"));
    pp.replaySilent = false;

    expect(sveglie).toEqual([]);
  });

  test("con un handler vivo non si sveglia nessuno: è un turno normale", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken6");
    const sveglie: string[] = [];
    provider.observeWokenTurns((sk) => sveglie.push(sk));

    const h = makeHandler();
    pp.streamHandler = h.handler;
    emit(provider, pp, testo("una risposta chiesta da qualcuno"));

    expect(sveglie).toEqual([]);
    expect(h.texts.join("")).toBe("una risposta chiesta da qualcuno");
  });

  test("adottare quando qualcun altro guida già è un NO, non un doppione", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken7");
    provider.observeWokenTurns(() => {});
    emit(provider, pp, testo("evento del monitor"));

    // La corsa vera: l'utente scrive un messaggio proprio mentre il Monitor
    // consegna. Il turno umano ha già preso la sessione; il risveglio non deve
    // installarsi sopra di lui e sdoppiare la riga.
    const umano = makeHandler();
    pp.streamHandler = umano.handler;

    const risveglio = makeHandler();
    expect(provider.adoptWokenTurn("topic:woken7", risveglio.handler)).toBe(false);
    expect(pp.streamHandler).toBe(umano.handler);
    expect(risveglio.texts).toEqual([]);
  });

  test("adottare una sessione morta è un NO", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:woken8");
    provider.observeWokenTurns(() => {});
    emit(provider, pp, testo("evento"));
    pp.alive = false;

    expect(provider.adoptWokenTurn("topic:woken8", makeHandler().handler)).toBe(false);
  });

  test("senza nessuno in ascolto il comportamento resta quello di prima", () => {
    // Nessun `observeWokenTurns`: il provider non deve rompersi né trattenere
    // per sempre gli eventi di una sessione che nessuno adotterà.
    const { provider, pp } = makeProviderWithStubProcess("topic:woken9");
    expect(() => emit(provider, pp, testo("nel vuoto"))).not.toThrow();
    expect(pp.streamHandler).toBeNull();
  });
});
