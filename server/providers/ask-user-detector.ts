/**
 * Detector for `tool_use` blocks that semantically request a human answer
 * before the model can continue. Two recognised shapes today:
 *
 *   1. `AskUserQuestion` from the Claude Agent SDK — the model emits a
 *      `tool_use` block with `name === "AskUserQuestion"` and an `input`
 *      object that carries a `questions` array. Each question carries 2-4
 *      mutually-exclusive options (the SDK adds an implicit "Other" at
 *      render time; we mirror that on the client).
 *
 *   2. MCP `elicitation/create` (and the variant tool names servers expose)
 *      — the tool name starts with `mcp__` and the input carries a
 *      `requestedSchema`. We pass the schema through to the client which
 *      renders a typed form against a subset of JSON Schema.
 *
 * Tools that look kind-of like either but are malformed get classified as
 * `raw` instead of being dropped — better to show the user a textarea than
 * a never-ending spinner. Tools we don't recognise at all return `null` so
 * the dispatcher uses the normal (non-suspending) tool path.
 *
 * The detector is intentionally pure: no side-effects, no provider lookup.
 * The provider that owns the stream calls it and decides what to do with
 * the result.
 */

import type { UserInputSchema, AskUserQuestionItem } from "../types";

export interface ToolUseLike {
  name: string;
  input: unknown;
}

/**
 * Returns the user-input shape if the tool requires a human answer,
 * otherwise `null`. See module docstring for the recognised cases.
 */
export function detectUserInputRequest(toolUse: ToolUseLike): UserInputSchema | null {
  // --- Claude Agent SDK: AskUserQuestion, and the Topics MCP bridge tool ---
  // The SDK's built-in `AskUserQuestion` is only registered in the CLI's
  // INTERACTIVE mode; Topics spawns the CLI headless (`--print` stream-json)
  // where it is absent, so the model can never emit it. The Topics bridge
  // re-exposes the exact same contract as `mcp__topics__ask_user_question`
  // (see server/mcp/topics-mcp-server.ts) — same `questions` input shape — so
  // it renders through the identical `kind: "questions"` panel.
  //
  // AND THE BARE NAME, which is the SAME tool once more. The native runtime
  // imports the Topics handlers straight from `mcp/topics-mcp-server`
  // (`topicsToolSpecs`), so there the tool has no fleet prefix at all: it is
  // plain `ask_user_question`. Matching only the prefixed form left that
  // runtime with a question nobody could answer - the panel is rendered from
  // THIS verdict (the `/api/sessions/:key/ask-user` route only supplies the
  // answer channel, and says so), so no verdict meant no form. Observed on
  // 2026-08-28: a chat parked on a `running` ask, the question sitting in the
  // database, and no control on screen. The turn cannot end and nobody can
  // unblock it.
  //
  // Exact match on the bare name, not a suffix: `endsWith("ask_user_question")`
  // would also swallow somebody else's `my_ask_user_question`.
  if (
    toolUse.name === "AskUserQuestion"
    || toolUse.name === "ask_user_question"
    || toolUse.name.endsWith("__ask_user_question")
  ) {
    const input = toolUse.input as { questions?: unknown } | undefined;
    if (!input || !Array.isArray(input.questions) || input.questions.length === 0) {
      // Malformed: fall through to raw so the user can still answer.
      return { kind: "raw", rawInput: toolUse.input };
    }
    const cleanedQuestions: AskUserQuestionItem[] = [];
    for (const raw of input.questions) {
      const q = sanitiseQuestion(raw);
      if (q) cleanedQuestions.push(q);
    }
    if (cleanedQuestions.length === 0) {
      return { kind: "raw", rawInput: toolUse.input };
    }
    // The SDK caps at 4 questions per call; trim defensively so a buggy
    // model can't blow up the UI with 50 radio groups.
    return {
      kind: "questions",
      questions: cleanedQuestions.slice(0, 4),
    };
  }

  // --- MCP elicitation ---
  // The wire name varies by server, but they all live under the `mcp__`
  // namespace and the input carries `requestedSchema`. We don't validate
  // the schema here — the form runtime narrows by `type`.
  if (toolUse.name.startsWith("mcp__")) {
    const input = toolUse.input as
      | { requestedSchema?: unknown; message?: unknown }
      | undefined;
    if (input && input.requestedSchema !== undefined) {
      return {
        kind: "elicitation",
        requestedSchema: input.requestedSchema,
        message: typeof input.message === "string" ? input.message : undefined,
      };
    }
  }

  return null;
}

/**
 * Defensive normaliser for a single `AskUserQuestionItem`. Returns `null`
 * if the shape is so far off we can't render it (no question text, no
 * options). Otherwise coerces strings, clamps option counts to [2, 4]
 * matching the SDK contract, and forwards `multiSelect` when truthy.
 */
function sanitiseQuestion(raw: unknown): AskUserQuestionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = typeof r.question === "string" ? r.question.trim() : "";
  if (!question) return null;
  const header = typeof r.header === "string" ? r.header.slice(0, 12) : "";
  const options = Array.isArray(r.options)
    ? r.options
        .map((o) => {
          if (!o || typeof o !== "object") return null;
          const rec = o as Record<string, unknown>;
          const label = typeof rec.label === "string" ? rec.label : "";
          if (!label) return null;
          const description = typeof rec.description === "string" ? rec.description : undefined;
          return { label, description };
        })
        .filter((o): o is NonNullable<typeof o> => o !== null)
    : [];
  // SDK contract: min 2, max 4 options (excluding the implicit "Other"
  // we add on the client). Anything outside that range is a sign the
  // tool call is malformed — bail to raw via the caller.
  if (options.length < 2) return null;
  const clamped = options.slice(0, 4);
  const multiSelect = r.multiSelect === true;
  return { question, header, options: clamped, multiSelect };
}
