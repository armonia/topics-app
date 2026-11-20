/**
 * @covers ASK-01
 *
 * A question about something visual carries its pictures: one set for the
 * question, one picture per option. The detector is the single place the
 * three engines (native, the Claude CLI and Codex) read a question through,
 * so a picture that survives it reaches the panel from all of them.
 */
import { describe, expect, test } from "bun:test";
import { detectUserInputRequest } from "./ask-user-detector";
import { TOOLS } from "../mcp/tool-catalog";

const input = {
  questions: [
    {
      question: "Which of the four proposals?",
      header: "Design",
      images: ["/m/overview.png", "/m/second.png"],
      options: [
        { label: "Quiet", image: "/m/quiet.png", recommended: true },
        { label: "Loud", image: "/m/loud.png" },
        { label: "Plain" },
      ],
    },
  ],
};

// How each engine names the same tool: the native runtime has the bare name,
// the Claude CLI the bridge prefix, Codex its own server prefix.
const ENGINES: Array<[string, string]> = [
  ["native", "ask_user_question"],
  ["Claude CLI", "mcp__topics__ask_user_question"],
  ["Codex", "topics__ask_user_question"],
];

describe("the question keeps its pictures", () => {
  for (const [engine, name] of ENGINES) {
    test(`${engine}: images, option image and recommended reach the panel`, () => {
      const out = detectUserInputRequest({ name, input });
      expect(out?.kind).toBe("questions");
      const q = out && out.kind === "questions" ? out.questions[0]! : null;
      expect(q?.images).toEqual(["/m/overview.png", "/m/second.png"]);
      expect(q?.options.map((o) => o.image)).toEqual(["/m/quiet.png", "/m/loud.png", undefined]);
      expect(q?.options[0]?.recommended).toBe(true);
      expect(q?.options[1]?.recommended).toBeUndefined();
    });
  }

  test("at most four pictures per question, and only strings", () => {
    const out = detectUserInputRequest({
      name: "ask_user_question",
      input: { questions: [{ question: "Q?", images: ["a.png", 3, "", "b.png", "c.png", "d.png", "e.png"], options: [{ label: "A" }, { label: "B" }] }] },
    });
    const q = out && out.kind === "questions" ? out.questions[0]! : null;
    expect(q?.images).toEqual(["a.png", "b.png", "c.png", "d.png"]);
  });

  test("a question with no pictures has no `images` key at all", () => {
    const out = detectUserInputRequest({ name: "ask_user_question", input: { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] } });
    const q = out && out.kind === "questions" ? out.questions[0]! : null;
    expect(q && "images" in q).toBe(false);
  });

  test("the tool schema offers both fields", () => {
    const tool = TOOLS.find((t) => t.name === "ask_user_question")!;
    const item = (tool.inputSchema as any).properties.questions.items.properties;
    expect(item.images.items.type).toBe("string");
    expect(item.options.items.properties.image.type).toBe("string");
  });
});
