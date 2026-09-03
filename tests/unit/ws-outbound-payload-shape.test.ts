/**
 * Lo schema deve accettare il payload che l'emittente manda DAVVERO.
 *
 * `ws-outbound-coverage.test.ts` verifica che ogni tipo emesso abbia uno schema e
 * viceversa — cioè che i due ELENCHI combacino. Non guarda dentro: uno schema può
 * esistere, essere registrato, comparire in entrambi gli elenchi, e rifiutare
 * ogni singolo frame che il server manda.
 *
 * È esattamente cosa succedeva a `agent:profile:deleted`: lo schema pretendeva
 * `agentId`, l'unico emittente (`server/routes/agent-profiles.ts`) mandava
 * `profileId`. Risultato: `devValidateOutbound` scriveva un warning nei log del
 * server e il client SCARTAVA il frame come malformato (`useWebSocket.ts`).
 * Nessuno consumava quell'evento, quindi il disallineamento non ha mai fatto
 * rumore — ma il primo consumatore non avrebbe mai visto una cancellazione, e
 * avrebbe cercato il bug nel posto sbagliato.
 *
 * Qui i payload sono scritti a mano, uno per evento, COPIANDOLI dalla forma che
 * il sorgente costruisce. È lavoro manuale per costruzione: un payload dedotto
 * automaticamente proverebbe solo che il generatore e lo schema concordano.
 * Si aggiunge una riga quando si aggiunge un broadcast — la lista non pretende di
 * essere esaustiva, ma ogni riga che c'è è una forma reale verificata.
  * @covers WIRE-08
 */
import { describe, expect, test } from "bun:test";
import { validateOutbound } from "../../shared/ws-outbound";

/** Forme copiate dai punti di emissione reali. */
const REAL_PAYLOADS: { where: string; payload: Record<string, unknown> }[] = [
  // ── stream lento / ripreso (server/routes/chat.ts) ────────────────────────
  {
    where: "chat.ts — timeout morbido",
    payload: {
      type: "stream:slow",
      sessionKey: "topic:abc",
      topicId: "abc",
      messageId: "m1",
      graceMs: 60_000,
    },
  },
  {
    where: "server/routes/chat.ts (onRetry)",
    payload: {
      type: "stream:retry",
      sessionKey: "topic:abc",
      topicId: "abc",
      messageId: "m1",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: "stream overloaded_error",
    },
  },
  {
    where: "chat.ts — lo stream riprende",
    payload: { type: "stream:resumed", sessionKey: "topic:abc", topicId: "abc" },
  },
  {
    // The wait fields are the whole point: a client that attaches during a
    // backoff learns it from here, not from the `stream:retry` it never saw.
    where: "server.ts — catchup di un turno in attesa (retry + slow)",
    payload: {
      type: "stream:catchup",
      sessionKey: "topic:abc",
      topicId: "abc",
      messageId: "m1",
      content: "mezza frase",
      thinking: "",
      isThinking: false,
      toolCalls: [],
      blocks: [],
      retry: { attempt: 2, maxAttempts: 10, delayMs: 30_000, reason: "API 529", at: 1_756_915_200_000 },
      slow: true,
    },
  },

  // ── output dei processi (server/routes/processes.ts) ──────────────────────
  {
    where: "processes.ts:532 — nuovo output, accorpato a max 1/s per processo",
    payload: { type: "scripts:output", processId: "p1" },
  },

  // ── cap globale dei dispatch (server/routes/tasks.ts) ─────────────────────
  {
    where: "tasks.ts:788 — il cap globale cambia, riguarda ogni board aperta",
    payload: { type: "board:global-cap", maxAgentsAuto: true, maxAgents: 4 },
  },
];

describe("i payload reali passano il loro schema", () => {
  for (const { where, payload } of REAL_PAYLOADS) {
    test(`${payload.type} — ${where}`, () => {
      const r = validateOutbound(payload);
      expect(r.ok, r.ok ? "" : `${payload.type}: ${r.error}`).toBe(true);
    });
  }

  test("la guardia morde: un campo obbligatorio mancante fallisce", () => {
    // Senza questo, un registro che facesse passthrough su tutto renderebbe i
    // test sopra verdi senza verificare niente.
    const r = validateOutbound({ type: "board:global-cap" });
    expect(r.ok).toBe(false);
  });
});
