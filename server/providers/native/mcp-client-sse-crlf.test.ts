/**
 * `readSseResponse` split events on a bare "\n\n" only. An MCP server answering
 * in SSE with CRLF line endings (`\r\n\r\n`, which the spec allows) never
 * produced a split there, so its answer was never read and the server never
 * mounted.
 *
 * @covers MCPSRV-07
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectMcpServer } from "./mcp-client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A ReadableStream that yields the given chunks one at a time, as-is. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

describe("readSseResponse legge gli eventi CRLF", () => {
  test("un evento SSE con \\r\\n\\r\\n, anche spezzato sul \\r a cavallo di due chunk, arriva", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "fake" }, capabilities: {} },
    });
    // The blank-line separator's \r lands in one chunk and its \n in the next,
    // which is why a correct reader must hold back a trailing lone \r until
    // the next chunk confirms what follows it.
    const chunks = [`data: ${payload}\r`, `\n\r\n`];
    globalThis.fetch = (async () => new Response(streamOf(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const conn = await connectMcpServer("fake", { type: "http", url: "http://example.invalid/mcp" });
    expect(conn.serverInfo).toEqual({ name: "fake" });
  });
});
