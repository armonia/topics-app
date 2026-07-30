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
 */
import { describe, expect, test } from "bun:test";
import { validateOutbound } from "../../shared/ws-outbound";

/** Forme copiate dai punti di emissione reali. */
const REAL_PAYLOADS: { where: string; payload: Record<string, unknown> }[] = [
  // ── famiglia agent (server/routes/agent-profiles.ts) ──────────────────────
  {
    where: "agent-profiles.ts:156 — creazione profilo",
    payload: {
      type: "agent:profile:created",
      profile: { id: "a1", name: "master", role: "orchestrator", status: "idle", capabilities: [] },
    },
  },
  {
    where: "agent-profiles.ts:208 — aggiornamento profilo",
    payload: {
      type: "agent:profile:updated",
      profile: { id: "a1", name: "master", role: "orchestrator", status: "busy", capabilities: ["ts"] },
    },
  },
  {
    where: "agent-profiles.ts:217 — cancellazione profilo (mandava profileId, lo schema chiedeva agentId)",
    payload: { type: "agent:profile:deleted", profileId: "a1" },
  },
  {
    where: "agent-profiles.ts:260 — assegnazione",
    payload: { type: "agent:assigned", assignment: { agentId: "a1", topicId: "t1" } },
  },
  {
    where: "agent-profiles.ts:276 — rimozione assegnazione",
    payload: { type: "agent:unassigned", agentId: "a1", topicId: "t1" },
  },

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
    where: "chat.ts — lo stream riprende",
    payload: { type: "stream:resumed", sessionKey: "topic:abc", topicId: "abc" },
  },

  // ── output dei processi (server/routes/processes.ts) ──────────────────────
  {
    where: "processes.ts:532 — nuovo output, accorpato a max 1/s per processo",
    payload: { type: "scripts:output", processId: "p1" },
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
    const r = validateOutbound({ type: "agent:profile:deleted" });
    expect(r.ok).toBe(false);
  });
});
