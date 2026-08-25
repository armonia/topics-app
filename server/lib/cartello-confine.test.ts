/**
 * IL CONFINE SERVER→CLIENT, che nessun test attraversava.
 *
 * Il server decide il cartello (`cancelledNotice`) e lo scrive come blocco
 * `error`; il client decide banner ambra e bottone «Riprova» con
 * `turnErrorOf` / `turnIsOnlyError`. Sono due moduli in due alberi diversi,
 * provati ognuno per conto suo — e se le loro idee di «cartello» divergono, il
 * risultato e' che la spiegazione ESISTE in database e non si vede a schermo.
 * Cioe' il guasto del 20/08 daccapo, con un'altra faccia: l'utente vede una
 * risposta troncata e nessun perche'.
 *
 * Il difetto che questo test rende impossibile e' banale e per questo
 * probabile: cambiare il prefisso ⚠️ da una parte sola, o mettere nel blocco un
 * testo che `turnErrorOf` non riconosce.
  * @covers NOTICE-01
 */
import { test, expect } from "bun:test";
import { cancelledNotice } from "./cancelled-notice";
import { turnErrorOf, turnIsOnlyError, LEGACY_ERROR_PREFIX } from "../../client/src/components/Chat/turnError";

const casi = ["server-shutdown", "watchdog", "wall-clock", undefined] as const;

test("ogni cartello che il server scrive, il client lo RICONOSCE", () => {
  for (const cause of casi) {
    const avviso = cancelledNotice(cause ? { end: "cancelled", cause } : { end: "cancelled" })!;
    expect(avviso).toBeDefined();

    // IL CONTRATTO E' IL PREFISSO, e va verificato sul testo COM'E' PRODOTTO —
    // non su una copia gia' ripulita. Il client ha due strade per accendere il
    // banner: il blocco `error` (forma nuova) e il prefisso in `content`
    // (righe gia' in DB, e client vecchi che il blocco non lo conoscono). La
    // seconda vive o muore su questo carattere.
    expect(avviso.startsWith(LEGACY_ERROR_PREFIX)).toBe(true);
    // La strada VECCHIA, da sola: solo `content`, nessun blocco.
    expect(turnErrorOf({ content: avviso, blocks: [] })).not.toBeNull();

    // Com'e' scritto in finalizeStream: blocco error senza il prefisso, e
    // content col prefisso quando la riga sarebbe vuota.
    const blocco = { kind: 'error' as const, text: avviso.replace(/^⚠️\s*/, "") };
    const riga = { content: avviso, blocks: [blocco] };
    // 1. Il banner si accende.
    expect(turnErrorOf(riga)).not.toBeNull();
    // 2. E «Riprova» compare: la riga non porta altro lavoro.
    expect(turnIsOnlyError({ ...riga, toolCalls: [] })).toBe(true);
  }
});

test("un turno con del LAVORO non offre Riprova (rimandare rifarebbe tutto)", () => {
  const avviso = cancelledNotice({ end: "cancelled", cause: "server-shutdown" })!;
  const riga = {
    content: "Ho gia' fatto delle cose",
    blocks: [{ kind: 'text' as const, text: "Ho gia' fatto delle cose" },
             { kind: 'error' as const, text: avviso.replace(/^⚠️\s*/, "") }],
    toolCalls: [{ id: "t1" }],
  };
  expect(turnErrorOf(riga)).not.toBeNull();   // il banner si', spiega cos'e' successo
  expect(turnIsOnlyError(riga)).toBe(false);  // il bottone no
});

test("lo stop a mano non accende niente: nessun blocco, nessun banner", () => {
  expect(cancelledNotice({ end: "cancelled", cause: "user" })).toBeNull();
  expect(turnErrorOf({ content: "risposta a meta'", blocks: [] })).toBeNull();
});
