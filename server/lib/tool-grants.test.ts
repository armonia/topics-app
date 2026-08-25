/**
 * @covers AGENT-04
 */
import { describe, expect, it } from "bun:test";
import { decideGrant, grantMatches, TOPICS_BRIDGE_PREFIX } from "./tool-grants";

describe("grantMatches", () => {
  it("nome esatto", () => {
    expect(grantMatches("Write", "Write")).toBe(true);
    expect(grantMatches("Write", "WriteFile")).toBe(false);
  });

  it("prefisso con asterisco", () => {
    expect(grantMatches("mcp__gateway__*", "mcp__gateway__kiwi__search-flight")).toBe(true);
    expect(grantMatches("mcp__gateway__*", "mcp__exa__web_search")).toBe(false);
  });

  it("l'asterisco NUDO non è una regola — «tutto» ha già un nome, e si chiama yolo", () => {
    expect(grantMatches("*", "Write")).toBe(false);
    expect(grantMatches("*", "mcp__gateway__kiwi__search-flight")).toBe(false);
  });

  it("stringhe vuote non concedono niente", () => {
    expect(grantMatches("", "Write")).toBe(false);
    expect(grantMatches("Write", "")).toBe(false);
    expect(grantMatches("  ", "Write")).toBe(false);
  });
});

describe("decideGrant", () => {
  it("senza regole si CHIEDE — mai un sì per inerzia", () => {
    expect(decideGrant({ toolName: "Write", patterns: [] })).toBe("ask");
    expect(decideGrant({ toolName: "mcp__gateway__kiwi__search-flight", patterns: [] })).toBe("ask");
  });

  it("una regola che copre → si consente", () => {
    expect(decideGrant({ toolName: "Write", patterns: ["Write"] })).toBe("allow");
    expect(decideGrant({ toolName: "mcp__exa__web_search_exa", patterns: ["mcp__exa__*"] })).toBe("allow");
  });

  it("le mani di Topics non si chiedono mai", () => {
    // Il 7 agosto una richiesta di permesso è arrivata su
    // `mcp__topics__ask_user_question`: per mostrare un pannello serviva il
    // permesso di mostrare un pannello.
    expect(decideGrant({ toolName: `${TOPICS_BRIDGE_PREFIX}ask_user_question`, patterns: [] })).toBe("allow");
    expect(decideGrant({ toolName: `${TOPICS_BRIDGE_PREFIX}update_task`, patterns: [] })).toBe("allow");
  });

  it("«mani di Topics» è un PREFISSO, non un pezzo qualsiasi del nome", () => {
    // Un server ostile che si chiamasse `evil` con un tool `mcp__topics__x`
    // dentro il nome non deve poter passare dalla porta di servizio.
    expect(decideGrant({ toolName: "mcp__evil__mcp__topics__run", patterns: [] })).toBe("ask");
  });

  it("un nome vuoto si chiede (e quindi, senza nessuno, si nega)", () => {
    expect(decideGrant({ toolName: "", patterns: ["*"] })).toBe("ask");
  });
});
