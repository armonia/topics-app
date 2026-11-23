/**
 * `IDENTITY.md` in both formats the agents' folders hold: the fields list
 * (`- **Name:** …`) and the `# name` heading. Names are placeholders.
 *
 * @covers AGENTS-NAV-01
 */
import { describe, expect, test } from "bun:test";
import { parseIdentity, writeIdentity } from "./agent-identity";

const FIELDS = [
  "# IDENTITY.md - Who Am I?",
  "",
  "- **Name:** Alpha",
  "- **Creature:** the one who keeps the books",
  "- **Vibe:** short and dry",
  "",
  "Full rules in `AGENTS.md`.",
  "",
].join("\n");

const FIELDS_WITH_ID = FIELDS.replace("- **Name:** Alpha", "- **Name:** Beta (id `b2`)");

const HEADING = "# Gamma\nAnswers the support line\n\nLonger character notes.\n";

describe("parseIdentity", () => {
  test("fields format: the Name field, never the file's title", () => {
    expect(parseIdentity(FIELDS)).toEqual({ name: "Alpha", job: "the one who keeps the books" });
  });

  test("fields format: the id note after the name is dropped", () => {
    expect(parseIdentity(FIELDS_WITH_ID).name).toBe("Beta");
  });

  test("heading format: the heading and the next non-empty line", () => {
    expect(parseIdentity(HEADING)).toEqual({ name: "Gamma", job: "Answers the support line" });
    expect(parseIdentity("# Gamma\n\nAnswers\n")).toEqual({ name: "Gamma", job: "Answers" });
  });

  test("empty text: both empty", () => {
    expect(parseIdentity("")).toEqual({ name: "", job: "" });
  });
});

describe("writeIdentity", () => {
  test("fields format: only the value changes, every other byte stays", () => {
    const out = writeIdentity(FIELDS, { job: "keeps the books and the keys" });
    expect(out).toBe(FIELDS.replace("the one who keeps the books", "keeps the books and the keys"));
    expect(parseIdentity(out)).toEqual({ name: "Alpha", job: "keeps the books and the keys" });
  });

  test("fields format: renaming keeps the id note", () => {
    const out = writeIdentity(FIELDS_WITH_ID, { name: "Delta" });
    expect(out).toContain("- **Name:** Delta (id `b2`)");
    expect(out).toContain("# IDENTITY.md - Who Am I?");
    expect(parseIdentity(out).name).toBe("Delta");
  });

  test("heading format: heading and job line replaced, the notes stay", () => {
    expect(writeIdentity(HEADING, { name: "Epsilon" })).toBe("# Epsilon\nAnswers the support line\n\nLonger character notes.\n");
    expect(writeIdentity(HEADING, { job: "Runs the night shift" })).toBe("# Gamma\nRuns the night shift\n\nLonger character notes.\n");
  });

  test("empty text: a heading file", () => {
    expect(writeIdentity("", { name: "Zeta", job: "Writes" })).toBe("# Zeta\nWrites\n");
  });

  test("a round trip of an unchanged value is the same text", () => {
    expect(writeIdentity(FIELDS, parseIdentity(FIELDS))).toBe(FIELDS);
    expect(writeIdentity(HEADING, parseIdentity(HEADING))).toBe(HEADING);
  });
});
