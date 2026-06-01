import { describe, expect, test } from "bun:test";
import { stripAnsi, extractLatestNextBlock } from "./terminal-scrape";
import { parseNextRows } from "./master-next-parser";

const ESC = "\x1b";

describe("stripAnsi", () => {
  test("removes SGR color codes", () => {
    const s = `${ESC}[31mrosso${ESC}[0m normale`;
    expect(stripAnsi(s)).toBe("rosso normale");
  });

  test("removes cursor moves and erase sequences", () => {
    const s = `${ESC}[2K${ESC}[1Gtesto${ESC}[10;5H`;
    expect(stripAnsi(s)).toBe("testo");
  });

  test("removes OSC window-title (BEL and ESC-backslash terminated)", () => {
    expect(stripAnsi(`${ESC}]0;title${"\x07"}ciao`)).toBe("ciao");
    expect(stripAnsi(`${ESC}]2;t${ESC}\\ciao`)).toBe("ciao");
  });

  test("strips CR and stray control chars but keeps newline + tab", () => {
    // \r removed, \x00 removed entirely, \n and \t preserved.
    expect(stripAnsi("a\r\nb\tc\x00d")).toBe("a\nb\tcd");
  });

  test("keeps plain text untouched", () => {
    expect(stripAnsi("## Next\n- APRI **x** — y")).toBe("## Next\n- APRI **x** — y");
  });

  test("empty / falsy input", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("extractLatestNextBlock", () => {
  test("extracts a simple block", () => {
    const buf = "blah blah\n## Next\n- APRI **Auth** — fai\n";
    expect(extractLatestNextBlock(buf)).toBe("- APRI **Auth** — fai");
  });

  test("takes the LAST block when scrollback has several", () => {
    const buf = [
      "## Next", "- APRI **Auth** — vecchio",
      "altra roba",
      "## Next", "- COMPLETA **Billing** — nuovo",
    ].join("\n");
    expect(extractLatestNextBlock(buf)).toBe("- COMPLETA **Billing** — nuovo");
  });

  test("stops at the next heading", () => {
    const buf = "## Next\n- APRI **Auth** — x\n## Altro\nignorami";
    expect(extractLatestNextBlock(buf)).toBe("- APRI **Auth** — x");
  });

  test("works through ANSI noise", () => {
    const buf = `${ESC}[2K${ESC}[36m## Next${ESC}[0m\n- ${ESC}[1mAPRI${ESC}[0m **Auth** — agisci`;
    expect(extractLatestNextBlock(buf)).toBe("- APRI **Auth** — agisci");
  });

  test("no block → empty string", () => {
    expect(extractLatestNextBlock("solo una risposta normale")).toBe("");
    expect(extractLatestNextBlock("")).toBe("");
  });

  test("end-to-end: scraped block feeds parseNextActions", () => {
    const sessions = [{ topicId: "t-auth", name: "Auth" }, { topicId: "t-bill", name: "Billing" }];
    const buf = `${ESC}[32mHo valutato.${ESC}[0m\n\n## Next\n- APRI **Auth** — rispondi\n- COMPLETA **Billing** — fatto\n`;
    const block = extractLatestNextBlock(buf);
    const actions = parseNextRows(block, sessions);
    expect(actions).toEqual([
      { verb: "apri", topicId: "t-auth", reason: "Rispondi" },
      { verb: "completa", topicId: "t-bill", reason: "Fatto" },
    ]);
  });
});
