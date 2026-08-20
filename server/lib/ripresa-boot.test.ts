/**
 * Le prove di `ripresa-boot.ts`.
 *
 * Il «sì» è uno. I «no» sono cinque, e sono la ragione per cui questa macchina
 * si può accendere: ogni ripresa sbagliata è un turno vero, a pagamento, e in
 * un ciclo sono tutti.
 */
import { describe, expect, test } from "bun:test";
import { chatDaRiprendere, FINESTRA_RIPRESA_MS, type RigaDaValutare } from "./ripresa-boot";
import type { ContentBlock } from "../types";

const ORA = Date.UTC(2026, 7, 20, 21, 0, 0);
const interrotto: ContentBlock = { kind: "error", text: "Turno interrotto: il server si è riavviato." };
const prosa: ContentBlock = { kind: "text", text: "stavo misurando" };

const base: RigaDaValutare = {
  sessionKey: "topic:9f9e9629",
  ruolo: "assistant",
  blocks: [prosa, interrotto],
  timestampMs: ORA - 60_000,
};

describe("quale chat riprende da sola", () => {
  test("ultimo turno interrotto, poco fa: si riprende", () => {
    expect(chatDaRiprendere(base, ORA)).toBe(true);
  });

  test("l'ultima parola è dell'utente: ha ripreso lui", () => {
    // Ha riscritto nel frattempo. Rimandare il suo messaggio vecchio gli
    // farebbe rispondere due volte, di cui una a una domanda superata.
    expect(chatDaRiprendere({ ...base, ruolo: "user" }, ORA)).toBe(false);
  });

  test("nessun verdetto di interruzione: il turno è finito bene, o l'ha fermato lui", () => {
    // `cancelledNotice` tace su `user`, quindi un turno fermato a mano NON ha
    // il blocco `error`: questo controllo è anche il modo in cui il suo Ferma
    // viene rispettato.
    expect(chatDaRiprendere({ ...base, blocks: [prosa] }, ORA)).toBe(false);
  });

  test("già ripreso: mai due volte", () => {
    const b = [...base.blocks!, { kind: "ripreso" } as ContentBlock];
    expect(chatDaRiprendere({ ...base, blocks: b }, ORA)).toBe(false);
  });

  test("fuori finestra: non si risponde a una domanda di ieri", () => {
    expect(chatDaRiprendere({ ...base, timestampMs: ORA - FINESTRA_RIPRESA_MS - 1 }, ORA)).toBe(false);
    // Al bordo interno si riprende ancora.
    expect(chatDaRiprendere({ ...base, timestampMs: ORA - FINESTRA_RIPRESA_MS + 1 }, ORA)).toBe(true);
  });

  test("senza blocchi non si decide niente", () => {
    expect(chatDaRiprendere({ ...base, blocks: [] }, ORA)).toBe(false);
    expect(chatDaRiprendere({ ...base, blocks: null }, ORA)).toBe(false);
  });
});
