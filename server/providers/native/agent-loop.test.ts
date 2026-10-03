/**
 * `toolResultContent`: how a `ToolResult` becomes `tool_result.content`.
 *
 * Before this, every result was plain text, so an image (`ToolResult.images`)
 * had nowhere to go: `read_file` on a PNG or an inline screenshot ended up in
 * the text field as base64, which the API does not decode as an image. This
 * checks that a result WITHOUT images stays a plain string exactly as before,
 * and one WITH images becomes the `[text, ...images]` array the API expects,
 * with clipping applied only to the text part.
 *
 * WHY REAL PNG BYTES, not the old fake `"QUFB"` (="AAA") base64. Every image
 * now passes through `normalizeImage` (`image-normalize.ts`) at this exact
 * seam, and undecodable bytes correctly become a TEXT fallback rather than a
 * broken image block — which is the whole point of the fix (RT-11 finding
 * #2/#3), but it means a fake fixture no longer produces an image block here.
 * The genuinely-decodable-image tests are darwin-only because the resize/
 * recompress step (`sips`) only runs there; on any other platform an image
 * always becomes a text note naming why, which is covered separately below
 * and runs everywhere, CI included.
 *
 * @covers RT-11
 */
import { describe, test, expect, afterEach } from "bun:test";
import { deflateSync, crc32 } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, toolResultContent } from "./agent-loop";
import type { ToolResult } from "./tools";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Number(crc32(typeAndData)) >>> 0, 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** A REAL, `sips`-decodable PNG: flat colour, valid IDAT, valid CRCs. */
function realPng(width: number, height: number, rgb: [number, number, number] = [90, 140, 200]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(height).fill(row));
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const isDarwin = process.platform === "darwin";

describe("toolResultContent", () => {
  test("nessuna immagine: il contenuto resta una semplice stringa, come sempre", async () => {
    const out: ToolResult = { content: "ok, scritto" };
    expect(await toolResultContent(out)).toBe("ok, scritto");
  });

  test("un array `images` vuoto si comporta come nessuna immagine", async () => {
    const out: ToolResult = { content: "niente da vedere", images: [] };
    expect(await toolResultContent(out)).toBe("niente da vedere");
  });

  test("byte che non decodificano a nessuna immagine: il testo resta stringa, con la ragione allegata", async () => {
    const out: ToolResult = {
      content: "a.png (10x10, image attached)",
      images: [{ mediaType: "image/png", data: Buffer.from("non un'immagine vera").toString("base64"), label: "a.png" }],
    };
    const content = await toolResultContent(out);
    expect(typeof content).toBe("string");
    expect(content as string).toContain("a.png (10x10, image attached)");
    expect((content as string).toLowerCase()).toContain("non riconosciuto");
  });

  test("an image that cannot be sent is named by its path in the note, not by a generic word", async () => {
    const path = "RAW/Schermata 2026-09-26 alle 10.11.12.png";
    const out: ToolResult = {
      content: `${path} (2880x1800, image attached)`,
      images: [{ mediaType: "image/png", data: Buffer.from("not an image at all").toString("base64"), label: path }],
    };
    const content = await toolResultContent(out);
    expect(typeof content).toBe("string");
    expect(content as string).toContain(`\n\n${path}: `);
  });

  test.if(isDarwin)("un'immagine reale: il contenuto diventa [testo, immagine]", async () => {
    const bytes = realPng(10, 10);
    const out: ToolResult = {
      content: "a.png (10x10, image attached)",
      images: [{ mediaType: "image/png", data: bytes.toString("base64"), label: "a.png" }],
    };
    const content = await toolResultContent(out);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "a.png (10x10, image attached)" });
    expect(blocks[1].type).toBe("image");
    // Recompressed to JPEG regardless of the input format: this is the byte
    // ceiling, not just a pixel one (finding #1).
    expect(blocks[1].source.media_type).toBe("image/jpeg");
  });

  test.if(isDarwin)("più immagini nello stesso risultato producono più blocchi immagine", async () => {
    const out: ToolResult = {
      content: "due schermate",
      images: [
        { mediaType: "image/png", data: realPng(10, 10, [10, 20, 30]).toString("base64"), label: "uno.png" },
        { mediaType: "image/jpeg", data: realPng(12, 8, [200, 30, 10]).toString("base64"), label: "due.png" },
      ],
    };
    const blocks = await toolResultContent(out) as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1].source.media_type).toBe("image/jpeg");
    expect(blocks[2].source.media_type).toBe("image/jpeg");
  });

  test.if(isDarwin)("il testo di un'immagine viene comunque tagliato se troppo lungo, l'immagine no", async () => {
    const out: ToolResult = {
      content: "x".repeat(50_000),
      images: [{ mediaType: "image/png", data: realPng(10, 10).toString("base64"), label: "a.png" }],
    };
    const blocks = await toolResultContent(out) as any[];
    expect(blocks[0].text.length).toBeLessThan(50_000);
    expect(blocks[1].type).toBe("image");
  });
});

/**
 * MSEL-11: the engine sends its turns where a Claude Code session launched by
 * Topics would, process env first, then `env` of `~/.claude/settings.json`,
 * then api.anthropic.com. A temporary HOME with a fake settings file and a
 * fake `fetch` that only records the URL: nothing leaves the machine.
 *
 * @covers MSEL-11
 */
describe("MSEL-11: the engine follows ANTHROPIC_BASE_URL like the CLI", () => {
  const realFetch = globalThis.fetch;
  const realHome = process.env.HOME;
  const realBase = process.env.ANTHROPIC_BASE_URL;
  const okStream = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

  async function urlOfOneTurn(settings: unknown | null, envBase?: string): Promise<string[]> {
    const home = mkdtempSync(join(tmpdir(), "msel11-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }));
    if (settings !== null) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
    process.env.HOME = home;
    if (envBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = envBase;
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(okStream, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await runAgentTurn(
        { model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "ping" }], tools: () => [], toolContext: { workspace: home } },
        { onTextDelta() {}, onToolStart() {}, onToolResult() {}, onDone() {}, onError() {} },
      );
    } finally {
      globalThis.fetch = realFetch;
      rmSync(home, { recursive: true, force: true });
    }
    return urls;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = realBase;
  });

  test("the address in settings.json env is where the turn goes", async () => {
    const urls = await urlOfOneTurn({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3336" } });
    expect(urls).toEqual(["http://127.0.0.1:3336/v1/messages"]);
  });

  test("the process variable beats settings.json, as for the CLI", async () => {
    const urls = await urlOfOneTurn({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3336" } }, "http://127.0.0.1:4444/");
    expect(urls).toEqual(["http://127.0.0.1:4444/v1/messages"]);
  });

  test("without either, the engine stays on api.anthropic.com", async () => {
    expect(await urlOfOneTurn(null)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(await urlOfOneTurn({ env: {} })).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  test("an unreachable address is named in the error, never retried direct", async () => {
    const home = mkdtempSync(join(tmpdir(), "msel11-down-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3336" } }));
    process.env.HOME = home;
    delete process.env.ANTHROPIC_BASE_URL;
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    let message = "";
    try {
      await runAgentTurn(
        {
          model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "ping" }], tools: () => [],
          toolContext: { workspace: home }, retryPolicy: { maxAttempts: 2, baseMs: 1, capMs: 1, jitter: () => 1 },
        },
        { onTextDelta() {}, onToolStart() {}, onToolResult() {}, onDone() {}, onError(e: unknown) { message ||= String((e as Error)?.message ?? e); } },
      );
    } catch (e) {
      message ||= (e as Error).message;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(["http://127.0.0.1:3336/v1/messages"]));
    expect(message).toContain("http://127.0.0.1:3336/v1/messages");
  });
});
