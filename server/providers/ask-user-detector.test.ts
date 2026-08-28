/**
 * @covers ASK-01
 */
import { describe, expect, test } from "bun:test";
import { detectUserInputRequest } from "./ask-user-detector";

describe("detectUserInputRequest — AskUserQuestion happy path", () => {
  test("classifies a single well-formed question as kind=questions", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which auth method?",
            header: "Auth",
            options: [
              { label: "OAuth", description: "Provider-managed" },
              { label: "JWT", description: "Self-issued" },
            ],
          },
        ],
      },
    });

    expect(result).toEqual({
      kind: "questions",
      questions: [
        {
          question: "Which auth method?",
          header: "Auth",
          options: [
            { label: "OAuth", description: "Provider-managed" },
            { label: "JWT", description: "Self-issued" },
          ],
          multiSelect: false,
        },
      ],
    });
  });

  test("the Topics MCP bridge tool maps to the SAME questions panel", () => {
    // The CLI drops built-in AskUserQuestion in headless mode, so Topics
    // re-exposes it as mcp__topics__ask_user_question with an identical input
    // shape. The detector must route it through kind=questions, not the
    // generic mcp__ elicitation branch (which would render typed fields).
    const result = detectUserInputRequest({
      name: "mcp__topics__ask_user_question",
      input: {
        questions: [
          {
            question: "Tema?",
            header: "Tema",
            options: [{ label: "Chiaro" }, { label: "Scuro" }],
          },
        ],
      },
    });
    expect(result?.kind).toBe("questions");
    if (result?.kind === "questions") {
      expect(result.questions[0].question).toBe("Tema?");
      expect(result.questions[0].options).toHaveLength(2);
    }
  });

  test("propagates multiSelect when truthy", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick features",
            header: "Features",
            options: [
              { label: "Auth" },
              { label: "Email" },
              { label: "Logging" },
            ],
            multiSelect: true,
          },
        ],
      },
    });

    expect(result?.kind).toBe("questions");
    if (result?.kind === "questions") {
      expect(result.questions[0].multiSelect).toBe(true);
    }
  });

  test("clamps to the SDK's 4-question maximum", () => {
    const baseQ = {
      question: "Q?",
      header: "Q",
      options: [{ label: "A" }, { label: "B" }],
    };
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: { questions: Array.from({ length: 7 }, () => baseQ) },
    });
    expect(result?.kind).toBe("questions");
    if (result?.kind === "questions") {
      expect(result.questions.length).toBe(4);
    }
  });

  test("clamps to the SDK's 4-option maximum per question", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Q?",
            header: "Q",
            options: Array.from({ length: 6 }, (_, i) => ({ label: `Opt${i}` })),
          },
        ],
      },
    });
    expect(result?.kind).toBe("questions");
    if (result?.kind === "questions") {
      expect(result.questions[0].options.length).toBe(4);
    }
  });
});

describe("detectUserInputRequest — fallbacks for malformed AskUserQuestion", () => {
  test("missing input → raw fallback (user can still answer freely)", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: undefined,
    });
    expect(result).toEqual({ kind: "raw", rawInput: undefined });
  });

  test("empty questions array → raw fallback", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: { questions: [] },
    });
    expect(result).toEqual({ kind: "raw", rawInput: { questions: [] } });
  });

  test("every question has < 2 options → raw fallback", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: {
        questions: [
          { question: "Q?", header: "Q", options: [{ label: "Only one" }] },
        ],
      },
    });
    expect(result?.kind).toBe("raw");
  });

  test("non-string question text → question dropped; remaining valid ones kept", () => {
    const result = detectUserInputRequest({
      name: "AskUserQuestion",
      input: {
        questions: [
          { question: 42, header: "X", options: [{ label: "A" }, { label: "B" }] },
          { question: "Real?", header: "R", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
    });
    expect(result?.kind).toBe("questions");
    if (result?.kind === "questions") {
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].question).toBe("Real?");
    }
  });
});

describe("detectUserInputRequest — MCP elicitation", () => {
  test("mcp__* tool with requestedSchema → kind=elicitation", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const result = detectUserInputRequest({
      name: "mcp__server__elicit",
      input: { requestedSchema: schema, message: "Tell me your name" },
    });
    expect(result).toEqual({
      kind: "elicitation",
      requestedSchema: schema,
      message: "Tell me your name",
    });
  });

  test("mcp__* tool WITHOUT requestedSchema → not classified (returns null)", () => {
    const result = detectUserInputRequest({
      name: "mcp__server__doSomething",
      input: { arg1: "x" },
    });
    expect(result).toBeNull();
  });

  test("message field absent → undefined in result", () => {
    const result = detectUserInputRequest({
      name: "mcp__server__elicit",
      input: { requestedSchema: { type: "string" } },
    });
    expect(result?.kind).toBe("elicitation");
    if (result?.kind === "elicitation") {
      expect(result.message).toBeUndefined();
    }
  });
});

describe("detectUserInputRequest — unknown tools pass through", () => {
  test("unrelated tool name → null (normal tool path)", () => {
    expect(detectUserInputRequest({ name: "Bash", input: { command: "ls" } })).toBeNull();
    expect(detectUserInputRequest({ name: "Read", input: { file_path: "/tmp/x" } })).toBeNull();
    expect(detectUserInputRequest({ name: "WebFetch", input: { url: "https://x" } })).toBeNull();
  });

  /**
   * THE NAME THE NATIVE RUNTIME USES.
   *
   * The same Topics tool arrives under two names. Through the MCP fleet it is
   * `mcp__topics__ask_user_question`; the native runtime imports the very same
   * handlers straight from `mcp/topics-mcp-server` (`topicsToolSpecs`), so
   * there it is the BARE `ask_user_question`.
   *
   * Only the first one used to match, and the consequence was not a cosmetic
   * one: the panel is rendered from this detector's verdict (the route comment
   * on `/api/sessions/:key/ask-user` says it in as many words - it only
   * supplies the answer CHANNEL). No verdict, no form: on 2026-08-28 a chat sat
   * on a `running` ask with the question in the database and no control on
   * screen for the human to answer it. The turn cannot end, and nobody can
   * unblock it.
   */
  test("il nome NUDO del runtime nativo e' la stessa domanda", () => {
    const schema = detectUserInputRequest({
      name: "ask_user_question",
      input: { questions: [{ question: "Come procediamo?", options: [{ label: "A" }, { label: "B" }] }] },
    });
    expect(schema?.kind).toBe("questions");
  });

  test("name that prefix-matches askuser but isn't exact → null", () => {
    expect(
      detectUserInputRequest({
        name: "AskUserQuestionV2",
        input: { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] },
      }),
    ).toBeNull();
  });
});
