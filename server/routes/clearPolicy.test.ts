/**
 * @covers CMD-09
 */
import { describe, test, expect } from "bun:test";
import { clearActionFor } from "./clearPolicy";
import { ClaudeCodeProvider } from "../providers/claude-code";
import { OpenClawProvider } from "../providers/openclaw";

/**
 * Il difetto che questi test bloccano: `/clear` chiamava
 * `provider.sendToSession?.(sessionKey, "/clear")` — un optional-call su un
 * metodo che claude-code non implementa. Nessun errore, nessun log: la chat si
 * svuotava a schermo e il modello ricordava tutto, perché il turno dopo faceva
 * `--resume` sulla stessa sessione.
 *
 * Le ultime due asserzioni sono quelle che contano davvero: non guardano un
 * finto provider, guardano i PROTOTIPI veri. Se un domani qualcuno togliesse
 * `resetSession` da ClaudeCodeProvider, il difetto tornerebbe identico e
 * silenzioso — e questo test diventerebbe rosso.
 */
describe("clearActionFor", () => {
  test("provider a respawn (ha resetSession) → si dimentica la sessione", () => {
    expect(clearActionFor({ resetSession: () => {} })).toEqual({ kind: "reset" });
  });

  test("provider in banda (solo sendToSession) → il /clear viaggia nella sessione", () => {
    expect(clearActionFor({ sendToSession: () => {} })).toEqual({ kind: "in-band" });
  });

  test("con entrambi vince il reset: è totale e non dipende da come il provider legge una stringa", () => {
    expect(clearActionFor({ resetSession: () => {}, sendToSession: () => {} })).toEqual({ kind: "reset" });
  });

  test("nessuno dei due (o nessun provider) → 'none', e il chiamante lo può DIRE", () => {
    // Il punto: 'none' è un caso esplicito, non un `?.` che non fa niente.
    expect(clearActionFor({})).toEqual({ kind: "none" });
    expect(clearActionFor(null)).toEqual({ kind: "none" });
    expect(clearActionFor(undefined)).toEqual({ kind: "none" });
    // Un campo che esiste ma non è chiamabile non conta come capacità.
    expect(clearActionFor({ resetSession: true, sendToSession: "yes" })).toEqual({ kind: "none" });
  });

  test("i provider VERI cadono nel ramo giusto (prototipi, non finti oggetti)", () => {
    expect(clearActionFor(ClaudeCodeProvider.prototype as object)).toEqual({ kind: "reset" });
    expect(clearActionFor(OpenClawProvider.prototype as object)).toEqual({ kind: "in-band" });
  });
});
