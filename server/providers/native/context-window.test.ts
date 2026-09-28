/**
 * The two image-aware pieces of `context-window.ts`, without a network:
 * `recoverFromImageFailure` (a request the API refused because of an image)
 * and `calibrateFrom` (the chars-per-token ratio learnt from a round that
 * went well, with the images' own cost taken out first).
 *
 * @covers CHAT-COMPACT-04
 */
import { describe, expect, test } from "bun:test";
import { calibrateFrom, recoverFromImageFailure } from "./context-window";
import { charsPerTokenFrom, DEFAULT_CHARS_PER_TOKEN } from "./compaction";
import { ApiHttpError } from "./retry";
import type { AgentMessage, Block } from "./agent-loop";

/** A valid PNG header: the size is all the token estimate reads. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

function historyWithImage(width = 280, height = 280): AgentMessage[] {
  return [
    { role: "user", content: "guarda" },
    { role: "assistant", content: [{ type: "tool_use", id: "img", name: "read_file", input: { path: "a.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "img", content: [
      { type: "text", text: "a.png (280x280, image attached)" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: pngHeader(width, height).toString("base64") } },
    ] as never }] },
  ];
}

function resultContent(history: AgentMessage[]): Block["content"] {
  return (history[2]!.content as Block[])[0]!.content;
}

function recoverCtx(history: AgentMessage[], state: { attempts: number; imagesStripped?: boolean } = { attempts: 0 }) {
  const retries: string[] = [];
  return {
    retries,
    ctx: { history, state, aborted: false, handler: { onRetry: (i: { reason: string }) => { retries.push(i.reason); } } },
  };
}

describe("recoverFromImageFailure", () => {
  test("a 413 strips every image in place, marks the turn, and says why", () => {
    const history = historyWithImage();
    const { ctx, retries } = recoverCtx(history);
    recoverFromImageFailure(new ApiHttpError("API 413: request_too_large", 413), ctx);
    expect(resultContent(history)).toBe("[immagine rimossa per fare spazio: a.png]");
    expect(ctx.state.imagesStripped).toBe(true);
    expect(retries).toEqual(["immagine rifiutata dall'API: tolgo le immagini e riprovo"]);
  });

  test("a 400 that names an image is recovered the same way", () => {
    const history = historyWithImage();
    const { ctx } = recoverCtx(history);
    recoverFromImageFailure(
      new ApiHttpError("API 400: Image does not match the provided media type image/png", 400),
      ctx,
    );
    expect(typeof resultContent(history)).toBe("string");
  });

  test("only once per turn: a second image failure reaches the caller", () => {
    const history = historyWithImage();
    const { ctx } = recoverCtx(history, { attempts: 0, imagesStripped: true });
    const err = new ApiHttpError("API 413: request_too_large", 413);
    expect(() => recoverFromImageFailure(err, ctx)).toThrow(err);
  });

  test("anything else is rethrown untouched, and the history stays as it was", () => {
    for (const err of [
      new ApiHttpError("API 400: messages: roles must alternate", 400),
      new ApiHttpError("API 529: overloaded", 529),
      new Error("API 413 as plain text"),
    ]) {
      const history = historyWithImage();
      const { ctx } = recoverCtx(history);
      expect(() => recoverFromImageFailure(err, ctx)).toThrow(err);
      expect(Array.isArray(resultContent(history))).toBe(true);
      expect(ctx.state.imagesStripped).toBeUndefined();
    }
  });

  test("an aborted turn is not recovered", () => {
    const history = historyWithImage();
    const { ctx } = recoverCtx(history);
    const err = new ApiHttpError("API 413: request_too_large", 413);
    expect(() => recoverFromImageFailure(err, { ...ctx, aborted: true })).toThrow(err);
    expect(Array.isArray(resultContent(history))).toBe(true);
  });
});

describe("calibrateFrom", () => {
  test("with no image the ratio is the characters sent over the tokens counted", () => {
    const calibration = { charsPerToken: DEFAULT_CHARS_PER_TOKEN };
    calibrateFrom(calibration, 9_000, { input: 3_000, cacheRead: 1_000, cacheWrite: 500 }, [{ role: "user", content: "x" }]);
    expect(calibration.charsPerToken).toBe(charsPerTokenFrom(9_000, 4_500));
  });

  test("the images' own tokens come out of the count before the ratio is taken", () => {
    // 280x280 is 10x10 tiles of 28 px: 100 tokens by the API's formula. The
    // characters sent never included the base64, so the tokens must not either.
    const calibration = { charsPerToken: DEFAULT_CHARS_PER_TOKEN };
    calibrateFrom(calibration, 9_000, { input: 4_600, cacheRead: 0, cacheWrite: 0 }, historyWithImage(280, 280));
    expect(calibration.charsPerToken).toBe(charsPerTokenFrom(9_000, 4_500));
  });

  test("no text tokens left after the images: the calibration keeps what it had", () => {
    const calibration = { charsPerToken: 3.1 };
    calibrateFrom(calibration, 9_000, { input: 100, cacheRead: 0, cacheWrite: 0 }, historyWithImage(280, 280));
    expect(calibration.charsPerToken).toBe(3.1);
  });
});
