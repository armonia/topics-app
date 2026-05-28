import { describe, expect, test } from "bun:test";
import { parseNextBlock, parseNextActions, type NextSessionRef } from "./master-next-parser";

const sessions: NextSessionRef[] = [
  { topicId: "11111111-1111-4111-8111-111111111111", name: "Auth refactor" },
  { topicId: "22222222-2222-4222-8222-222222222222", name: "Billing API" },
  { topicId: "terminal:abc123", name: "Claude Code" },
];

describe("parseNextBlock", () => {
  test("extracts the ## Next body", () => {
    const md = "Some reply.\n\n## Next\n- APRI **Auth refactor** — rispondi\n";
    expect(parseNextBlock(md)).toBe("- APRI **Auth refactor** — rispondi");
  });

  test("supports ### Next and 'Next action'", () => {
    expect(parseNextBlock("### Next action\n- COMPLETA **Billing API**")).toBe("- COMPLETA **Billing API**");
  });

  test("stops at the next heading", () => {
    const md = "## Next\n- APRI **Auth refactor** — x\n\n## Footer\nignored";
    expect(parseNextBlock(md)).toBe("- APRI **Auth refactor** — x");
  });

  test("returns null when there is no block", () => {
    expect(parseNextBlock("just a normal reply")).toBeNull();
    expect(parseNextBlock("")).toBeNull();
    expect(parseNextBlock(undefined)).toBeNull();
  });
});

describe("parseNextActions — happy path", () => {
  test("parses APRI and COMPLETA rows bound by bold name", () => {
    const md = "## Next\n- APRI **Auth refactor** — rispondi alla domanda\n- COMPLETA **Billing API** — consegnato";
    const out = parseNextActions(md, sessions);
    expect(out).toEqual([
      { verb: "apri", topicId: "11111111-1111-4111-8111-111111111111", reason: "Rispondi alla domanda" },
      { verb: "completa", topicId: "22222222-2222-4222-8222-222222222222", reason: "Consegnato" },
    ]);
  });

  test("binds by UUID when present", () => {
    const md = "## Next\n- APRI `11111111-1111-4111-8111-111111111111` — vai";
    const out = parseNextActions(md, sessions);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verb: "apri", topicId: "11111111-1111-4111-8111-111111111111" });
  });

  test("ARCHIVIA normalizes to completa", () => {
    const md = "## Next\n- ARCHIVIA **Billing API** — fatto";
    const out = parseNextActions(md, sessions);
    expect(out[0].verb).toBe("completa");
  });

  test("binds a terminal session by name substring", () => {
    const md = "## Next\n- COMPLETA Claude Code — la CLI è inattiva";
    const out = parseNextActions(md, sessions);
    expect(out[0]).toMatchObject({ verb: "completa", topicId: "terminal:abc123" });
  });

  test("inherits the verb from a section header", () => {
    const md = "## Next\n**APRI**\n- **Auth refactor** — premi invia\n- **Billing API** — conferma";
    const out = parseNextActions(md, sessions);
    expect(out.map((o) => o.verb)).toEqual(["apri", "apri"]);
  });
});

describe("parseNextActions — graceful degradation", () => {
  test("skips rows that bind to no known session", () => {
    const md = "## Next\n- APRI **Unknown thing** — niente\n- APRI **Auth refactor** — ok";
    const out = parseNextActions(md, sessions);
    expect(out).toHaveLength(1);
    expect(out[0].topicId).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("skips malformed rows without throwing, keeps valid ones", () => {
    const md = "## Next\n- (garbage no verb no session)\n- APRI **Billing API** — vai";
    const out = parseNextActions(md, sessions);
    expect(out).toEqual([
      { verb: "apri", topicId: "22222222-2222-4222-8222-222222222222", reason: "Vai" },
    ]);
  });

  test("de-dupes by (topicId, verb)", () => {
    const md = "## Next\n- APRI **Auth refactor** — uno\n- APRI **Auth refactor** — due";
    const out = parseNextActions(md, sessions);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("Uno");
  });

  test("a section header for a non-card verb resets inheritance", () => {
    const md = "## Next\n**ATTENDI**\n- **Auth refactor** — in volo\n**APRI**\n- **Billing API** — agisci";
    const out = parseNextActions(md, sessions);
    expect(out).toEqual([
      { verb: "apri", topicId: "22222222-2222-4222-8222-222222222222", reason: "Agisci" },
    ]);
  });

  test("empty / 'tutto pulito' block yields no actions", () => {
    expect(parseNextActions("## Next\nTutto pulito — niente da fare adesso.", sessions)).toEqual([]);
    expect(parseNextActions(undefined, sessions)).toEqual([]);
    expect(parseNextActions("## Next\n- APRI **Auth refactor**", [])).toEqual([]);
  });
});
