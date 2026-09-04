/**
 * @covers PERM-07
 */
import { describe, expect, it } from "bun:test";
import {
  PERMISSION_CHOICES,
  PERMISSION_HINT_KEY,
  PERMISSION_LABEL_KEY,
  cliDecisionFor,
  decisionFreesSession,
  isPermissionDecision,
  summarizeToolInput,
} from "./permission-decision";

describe("i tre bottoni in fila, e il quarto che NON ci sta", () => {
  it("hanno tutti un'etichetta e una riga che dice cosa fanno", () => {
    for (const choice of PERMISSION_CHOICES) {
      expect(PERMISSION_LABEL_KEY[choice]).toBe(`permission.decision.${choice}.label`);
      expect(PERMISSION_HINT_KEY[choice]).toBe(`permission.decision.${choice}.hint`);
    }
    expect(PERMISSION_CHOICES).toEqual(["allow", "allow_always", "deny"]);
  });

  it("il no è per ultimo: si legge prima cosa si concede", () => {
    expect(PERMISSION_CHOICES[PERMISSION_CHOICES.length - 1]).toBe("deny");
  });

  it("«passa a libero» ha le sue parole ma resta FUORI dalla fila", () => {
    // Se un giorno finisce in `PERMISSION_CHOICES`, il pannello lo disegna come
    // un quarto bottone identico agli altri — a un pollice da «Consenti» — e
    // l'unica decisione che toglie la barriera di sicurezza diventa la più
    // facile da premere per sbaglio. Questo caso è lì per accorgersene.
    expect(PERMISSION_LABEL_KEY.allow_free).toBeTruthy();
    expect(PERMISSION_HINT_KEY.allow_free).toBeTruthy();
    expect(PERMISSION_CHOICES).not.toContain("allow_free");
  });

  // What that line has to SAY is asserted where the words now live, on both
  // catalogues at once: `client/src/lib/i18n-catalogue.test.ts`. Here there are
  // only keys, and a key cannot be read.
});

describe("verso la CLI viaggiano sempre e solo le tre che capisce", () => {
  it("«passa a libero» diventa un `allow`", () => {
    // La CLI risponde `behavior: allow | deny` e non sa niente di modalità di
    // autonomia: consegnarle `allow_free` sarebbe una parola sconosciuta al
    // posto di un permesso.
    expect(cliDecisionFor("allow_free")).toBe("allow");
  });

  it("le altre tre passano intatte", () => {
    expect(cliDecisionFor("allow")).toBe("allow");
    expect(cliDecisionFor("allow_always")).toBe("allow_always");
    expect(cliDecisionFor("deny")).toBe("deny");
  });

  it("una sola decisione libera la sessione, e si riconosce da sé", () => {
    expect(decisionFreesSession("allow_free")).toBe(true);
    expect(decisionFreesSession("allow")).toBe(false);
    expect(decisionFreesSession("allow_always")).toBe(false);
    expect(decisionFreesSession("deny")).toBe(false);
  });
});

describe("isPermissionDecision — sul confine si valida, non si spera", () => {
  it("passa le quattro", () => {
    expect(isPermissionDecision("allow")).toBe(true);
    expect(isPermissionDecision("allow_always")).toBe(true);
    expect(isPermissionDecision("deny")).toBe(true);
    expect(isPermissionDecision("allow_free")).toBe(true);
  });

  it("tutto il resto è FUORI — e il chiamante risponde 400, non «sì» né un no muto", () => {
    // È la differenza con la versione a domande: lì un testo qualsiasi
    // diventava `deny` in silenzio, e chi aveva scritto «ok» vedeva negato.
    expect(isPermissionDecision("ok")).toBe(false);
    expect(isPermissionDecision("Consenti")).toBe(false);
    expect(isPermissionDecision("")).toBe(false);
    expect(isPermissionDecision(undefined)).toBe(false);
    expect(isPermissionDecision(null)).toBe(false);
    expect(isPermissionDecision(true)).toBe(false);
    expect(isPermissionDecision({ decision: "allow" })).toBe(false);
  });
});

describe("summarizeToolInput — un permesso senza il COSA è solo un pulsante", () => {
  it("mette per primo il campo che dice cosa succede", () => {
    const s = summarizeToolInput({ content: "x".repeat(100), file_path: "/tmp/a.sh" });
    expect(s.startsWith("file_path: /tmp/a.sh")).toBe(true);
  });

  it("resta su una riga e non esplode con valori lunghi", () => {
    const s = summarizeToolInput({ command: "y".repeat(5000) });
    expect(s).not.toContain("\n");
    expect(s.length).toBeLessThanOrEqual(160);
  });

  it("input vuoto → nessun riassunto (niente riga a vuoto nel pannello)", () => {
    expect(summarizeToolInput({})).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
    expect(summarizeToolInput(null)).toBe("");
  });

  it("mostra i valori veri, non i tipi: è quello su cui si decide", () => {
    const s = summarizeToolInput({ flyFrom: "NAP", flyTo: "RAK" });
    expect(s).toContain("NAP");
    expect(s).toContain("RAK");
  });
});
