import { describe, expect, test } from "bun:test";
import { askSideQuestion } from "./sideQuestion";

describe("/btw session isolation", () => {
  test("writes and reads the fork while the main transcript stays unchanged", async () => {
    const mainSessionKey = "topic:main";
    const sideSessionKey = "topic:side";
    const transcripts: Record<string, Array<{ role: string; content: string }>> = {
      [mainSessionKey]: [{ role: "user", content: "main prompt" }, { role: "assistant", content: "main answer" }],
      [sideSessionKey]: [{ role: "assistant", content: "copied context" }],
    };
    const mainBefore = structuredClone(transcripts[mainSessionKey]);
    const sentTo: string[] = [];

    const answer = await askSideQuestion({
      mainSessionKey,
      sideSessionKey,
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async (sessionKey, content) => {
        sentTo.push(sessionKey);
        transcripts[sessionKey]!.push({ role: "user", content }, { role: "assistant", content: "side answer" });
        return true;
      },
      getSessionMessages: (sessionKey) => transcripts[sessionKey] ?? [],
    });

    expect(sentTo).toEqual([sideSessionKey]);
    expect(answer).toBe("side answer");
    expect(transcripts[mainSessionKey]).toEqual(mainBefore);
  });

  test("refuses to use the main session as the side fork", async () => {
    await expect(askSideQuestion({
      mainSessionKey: "topic:main",
      sideSessionKey: "topic:main",
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async () => true,
      getSessionMessages: () => [],
    })).rejects.toThrow("forked session");
  });
});
