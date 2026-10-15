#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.299-e2e-btw\n");
  process.exit(0);
}
if (value("--output-format") === "json") {
  process.stdin.resume();
} else if (value("--input-format") === "stream-json") {
  const sessionId = value("--session-id") ?? value("--resume") ?? crypto.randomUUID();
  const log = (entry: unknown) => {
    const path = process.env.BTW_LOG;
    if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
  };
  log({ argv });
  let pending = "";
  let sequence = 0;
  process.stdin.on("data", async (chunk: Buffer) => {
    pending += chunk.toString();
    let lineEnd = -1;
    while ((lineEnd = pending.indexOf("\n")) >= 0) {
      const raw = pending.slice(0, lineEnd).trim();
      pending = pending.slice(lineEnd + 1);
      if (!raw) continue;
      const input = JSON.parse(raw) as { message?: { content?: unknown } };
      // A plain message reaches the CLI as a string; blocks only when Topics adds a slash context.
      const content = input.message?.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") : "";
      const question = text.split("\n").at(-1) ?? "";
      if (question.includes("main-hold")) {
        const deadline = Date.now() + 45_000;
        while (process.env.BTW_RELEASE && !existsSync(process.env.BTW_RELEASE) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const answer = question.includes("side-probe") ? "SIDE-ANSWER-PROBE" : "MAIN-ANSWER-PROBE";
      const uuid = crypto.randomUUID();
      const transcriptDir = join(homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
      mkdirSync(transcriptDir, { recursive: true });
      appendFileSync(join(transcriptDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "assistant", uuid, isSidechain: false, message: { content: [{ type: "text", text: answer }], stop_reason: "end_turn" } })}\n`);
      const out = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
      out({ type: "system", subtype: "init", model: "claude-e2e", cwd: process.cwd(), tools: [] });
      out({ type: "assistant", message: { id: `fake-${++sequence}`, role: "assistant", model: "claude-e2e", content: [{ type: "text", text: answer }], usage: { input_tokens: 8, output_tokens: 3 } } });
      out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: answer, duration_ms: 5, total_cost_usd: 0 });
      log({ question, answer, uuid });
    }
  });
  process.on("SIGTERM", () => process.exit(0));
} else {
  setInterval(() => {}, 1 << 30);
}
