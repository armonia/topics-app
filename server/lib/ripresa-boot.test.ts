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

/**
 * NON OGNI BLOCCO `error` È UN'INTERRUZIONE NOSTRA.
 *
 * Il cancello era `blocks.some(b => b.kind === "error")`: qualunque verdetto di
 * guasto. Ma in quel blocco ci finisce TUTTO ciò che va storto, e sul database
 * vivo gli ultimi messaggi con un blocco `error` erano 25 «ai-bridge: ack
 * timeout», 4 «Process exited with code», 1 «API 400».
 *
 * Nessuno di quelli è un turno da riprendere: sono guasti deterministici, e
 * rimandare il messaggio ricompra lo stesso fallimento — su un turno lungo
 * riaprendo tutti i giri di tool già fatti. I test di questo file non li
 * coprivano: passavano perché la loro fixture usa già il testo del cartello
 * giusto, cioè per fortuna e non per costruzione.
 */
describe("i guasti che NON sono un'interruzione", () => {
  const conErrore = (text: string): RigaDaValutare => ({
    ...base,
    blocks: [prosa, { kind: "error", text } as ContentBlock],
  });

  test("i testi VERI presi dal database non fanno scattare la ripresa", () => {
    for (const guasto of [
      "ai-bridge: ack timeout (list, 5s)",
      "ai-bridge: ack timeout (spawn topic:f4841e2f, 20s)",
      "Process exited with code 1",
      "API 400",
      "Nessuna risposta: il turno si è chiuso senza produrre niente.",
    ]) {
      expect(chatDaRiprendere(conErrore(guasto), ORA), guasto).toBe(false);
    }
  });

  test("e il cartello di interruzione continua a farla scattare", () => {
    expect(chatDaRiprendere(base, ORA)).toBe(true);
    for (const c of [
      "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.",
      "Turno interrotto: ha superato il limite di tempo concesso.",
    ]) {
      expect(chatDaRiprendere(conErrore(c), ORA), c).toBe(true);
    }
  });

  /**
   * L'annullamento SENZA causa dichiarata prende un cartello ma non si
   * riprende: non si indovina chi ha annullato. Stessa regola di
   * `meritaRipresaAutomatica`.
   */
  test("il cartello generico non basta", () => {
    expect(chatDaRiprendere(conErrore("Turno interrotto prima della fine."), ORA)).toBe(false);
  });
});
