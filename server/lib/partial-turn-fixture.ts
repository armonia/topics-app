/**
 * A TURN IN FLIGHT, made by hand: the rows a provider would have left behind
 * halfway through an answer, with N tool calls already over and one still
 * running.
 *
 * Only the E2E seeding verb (`POST /api/test/streams/partial`,
 * server/routes/e2e.ts) builds one, and only so the weight of the WS catch-up
 * can be READ on a real socket -- see scripts/ws-catchup-probe.ts. It lives
 * here rather than inside that route because the route file is already at its
 * size threshold, and because a fixture with proportions taken from a real
 * thread deserves to be reviewable on its own.
 */
import type { StoredMessage } from "../types";
import type { ToolCall } from "../../shared/types";

/** The output of one tool. The measured median on a real thread is ~4 KB. */
function fakeOutput(kb: number): string {
  const line = "the line of a tool output, as long as a real one\n";
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/** The rows of the turn, plus the id of the assistant row the stream registry points at. */
export function partialTurnRows(
  sessionKey: string,
  opts: { finishedTools: number; toolKb: number },
): { messageId: string; rows: StoredMessage[]; toolCalls: number } {
  const output = fakeOutput(Math.max(1, opts.toolKb));
  const command = `bash -lc ${JSON.stringify(output)}`;
  const prefix = sessionKey.replace(/[^a-z0-9]/gi, "").slice(-24);
  const call = (id: string, status: "success" | "running"): ToolCall => ({
    id, name: "Bash", args: { command }, status,
    ...(status === "success" ? { result: output, endedAt: 2 } : {}),
    detail: { type: "shell", command, output },
    startedAt: 1,
  }) as ToolCall;
  const calls = [
    ...Array.from({ length: Math.max(0, opts.finishedTools) }, (_, i) => call(`${prefix}-${i}`, "success")),
    call(`${prefix}-live`, "running"),
  ];
  const messageId = `${prefix}-a`;
  return {
    messageId,
    toolCalls: calls.length,
    rows: [
      { id: `${prefix}-u`, role: "user", content: "question", timestamp: new Date(1).toISOString() },
      {
        id: messageId, role: "assistant", content: "half of an answer",
        timestamp: new Date(2).toISOString(), parentId: `${prefix}-u`, partial: true,
        blocks: calls.map((tc) => ({ kind: "tool", toolCall: tc })) as never,
        toolCalls: calls,
      },
    ],
  };
}
