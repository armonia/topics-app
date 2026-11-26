/**
 * The reattach leg says `dispatched` only when the dispatcher asks for it.
 *
 * Sent on every reattach, it made the attention state read each adopted chat
 * turn as a card's (rule 2 of `attention/compose.ts`): after every reload of the
 * server the chat went idle, a question it asked never lit amber and its end
 * never lit «finished» (23/11: 10 of 11 chats with a turn open had no row).
 *
 * @covers ATTN-02
 */
import { describe, expect, test } from "bun:test";
import { bootHeadlessTurns } from "./headless-turns";

/** The body of the one request a reattach leg makes. */
async function reattachBody(...args: [string?, { dispatched?: boolean }?]): Promise<Record<string, unknown>> {
  let sent = "";
  const scope = {
    topicsRouter: async (req: Request) => { sent = await req.text(); return new Response(null); },
  };
  const { runHeadlessReattach } = bootHeadlessTurns(scope as never);
  const [provider, opts] = args;
  await runHeadlessReattach("topic:reattach-body", { timeoutMs: 1000 }, provider, opts);
  return JSON.parse(sent);
}

describe("runHeadlessReattach", () => {
  test("a chat's turn adopted at boot is not a card's: no `dispatched` on the wire", async () => {
    const body = await reattachBody("topics");
    expect(body).toMatchObject({ mode: "reattach", provider: "topics", messages: [] });
    expect("dispatched" in body).toBe(false);
  });

  test("the dispatcher's own card turn still says so", async () => {
    const body = await reattachBody("claude-code", { dispatched: true });
    expect(body.dispatched).toBe(true);
  });
});
