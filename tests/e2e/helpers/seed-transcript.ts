import type { APIRequestContext } from "@playwright/test";
import { E2E_BASE } from "./test-server";

/** Seeds the measured question, three tool-only rows, answer transcript shape. */
export async function seedTranscript(
  request: APIRequestContext,
  sessionKey: string,
  count: number,
  tag: string,
): Promise<void> {
  const ids = Array.from({ length: count }, (_, i) => `${tag}-${String(i).padStart(5, "0")}`);
  const base = Date.parse("2026-08-01T09:00:00.000Z");

  for (let i = 0; i < count; i++) {
    const slot = i % 5;
    const body = slot === 0
      ? { role: "user", content: `[${tag} ${i}] And what about the ${i}th thing? Please look at the file and tell me what it does.` }
      : slot === 4
        ? {
            role: "assistant",
            content: `[${tag} ${i}] Here is what I found. ` +
              "The module keeps its own copy of the state and reconciles it on load. ".repeat(3),
          }
        : {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: `${tag}-tc-${i}`,
              name: slot === 1 ? "Bash" : slot === 2 ? "Read" : "Grep",
              args: { command: `rg --line-number "thing-${i}" server/` },
              status: "success",
              result: `line ${i}: matched\n`.repeat(3),
            }],
          };
    const response = await request.post(`${E2E_BASE}/api/test/seed-message`, {
      ignoreHTTPSErrors: true,
      data: {
        ...body,
        sessionKey,
        id: ids[i],
        parentId: i === 0 ? null : ids[i - 1],
        sortOrder: 1000 + i,
        timestamp: new Date(base + i * 1000).toISOString(),
      },
    });
    if (!response.ok()) {
      throw new Error(`seed-message refused row ${i}: ${response.status()} ${await response.text()}`);
    }
  }
}
