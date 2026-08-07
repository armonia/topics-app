import { describe, expect, it } from "bun:test";
import {
  PERMISSION_CHOICES,
  PERMISSION_HINTS,
  PERMISSION_LABELS,
  isPermissionDecision,
  summarizeToolInput,
} from "./permission-decision";

describe("le tre decisioni, e nient'altro", () => {
  it("hanno tutte un'etichetta e una riga che dice cosa fanno", () => {
    for (const choice of PERMISSION_CHOICES) {
      expect(PERMISSION_LABELS[choice]).toBeTruthy();
      expect(PERMISSION_HINTS[choice]).toBeTruthy();
    }
    expect(PERMISSION_CHOICES).toEqual(["allow", "allow_always", "deny"]);
  });

  it("il no è per ultimo: si legge prima cosa si concede", () => {
    expect(PERMISSION_CHOICES[PERMISSION_CHOICES.length - 1]).toBe("deny");
  });
});

describe("isPermissionDecision — sul confine si valida, non si spera", () => {
  it("passa solo le tre", () => {
    expect(isPermissionDecision("allow")).toBe(true);
    expect(isPermissionDecision("allow_always")).toBe(true);
    expect(isPermissionDecision("deny")).toBe(true);
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
