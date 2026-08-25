/**
 * @covers WIRE-02
 */
import { describe, expect, test } from "bun:test";
import { compressJson, shouldCompress, MIN_COMPRESS_BYTES } from "./compress-json";

const base = {
  method: "GET",
  acceptEncoding: "gzip, deflate, br",
  contentType: "application/json",
  contentEncoding: null,
  remote: true,
  bytes: 100_000,
};

describe("shouldCompress", () => {
  test("yes for a large JSON response towards a remote peer that can inflate", () => {
    expect(shouldCompress(base)).toBe(true);
  });

  test("NO towards loopback: 60 ms of CPU for a transfer that is already free", () => {
    expect(shouldCompress({ ...base, remote: false })).toBe(false);
  });

  test("NO for the streaming of the chat", () => {
    expect(shouldCompress({ ...base, contentType: "text/event-stream" })).toBe(false);
  });

  test("NO if the client did not ask for gzip", () => {
    expect(shouldCompress({ ...base, acceptEncoding: null })).toBe(false);
    expect(shouldCompress({ ...base, acceptEncoding: "br" })).toBe(false);
    expect(shouldCompress({ ...base, acceptEncoding: "deflate" })).toBe(false);
  });

  test("`gzip` is a token, not a substring", () => {
    expect(shouldCompress({ ...base, acceptEncoding: "gzipx" })).toBe(false);
    expect(shouldCompress({ ...base, acceptEncoding: "x-gzip" })).toBe(false);
    expect(shouldCompress({ ...base, acceptEncoding: "gzip" })).toBe(true);
    expect(shouldCompress({ ...base, acceptEncoding: "br, gzip;q=0.9" })).toBe(true);
    expect(shouldCompress({ ...base, acceptEncoding: "gzip;q=1.0, deflate" })).toBe(true);
  });

  test("NO on HEAD: Bun empties the body, the length would be a lie", () => {
    expect(shouldCompress({ ...base, method: "HEAD" })).toBe(false);
  });

  test("NO if somebody already encoded it", () => {
    expect(shouldCompress({ ...base, contentEncoding: "gzip" })).toBe(false);
  });

  test("NO on the statuses without a body: they would advertise bytes they do not have", () => {
    for (const status of [101, 204, 205, 304]) {
      expect(shouldCompress({ ...base, status })).toBe(false);
    }
    expect(shouldCompress({ ...base, status: 200 })).toBe(true);
    expect(shouldCompress({ ...base, status: 500 })).toBe(true);
  });

  test("NO under one MTU: not even one round trip is saved", () => {
    expect(shouldCompress({ ...base, bytes: MIN_COMPRESS_BYTES - 1 })).toBe(false);
    expect(shouldCompress({ ...base, bytes: MIN_COMPRESS_BYTES })).toBe(true);
  });

  test("bytes still unknown: decide on the rest and check again afterwards", () => {
    expect(shouldCompress({ ...base, bytes: null })).toBe(true);
  });

  test("a content-type with a charset is still JSON", () => {
    expect(shouldCompress({ ...base, contentType: "application/json; charset=utf-8" })).toBe(true);
  });
});

function reqJson(headers: Record<string, string> = { "accept-encoding": "gzip" }, method = "GET"): Request {
  return new Request("http://h/api/x", { method, headers });
}
function resJson(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** A body that compresses well, like the real JSON of this app. */
const big = { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: "assistant", content: "a line of text that repeats" })) };

describe("compressJson", () => {
  test("compresses, and the client reads back EXACTLY the same JSON", async () => {
    const original = JSON.stringify(big);
    const out = await compressJson(reqJson(), resJson(big), true);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(Number(out.headers.get("Content-Length"))).toBeLessThan(original.length);
    const inflated = Bun.gunzipSync(new Uint8Array(await out.arrayBuffer()));
    expect(new TextDecoder().decode(inflated)).toBe(original);
  });

  test("declares Vary, or a cache would serve the compressed bytes to someone who cannot read them", async () => {
    const out = await compressJson(reqJson(), resJson(big), true);
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    const withVary = await compressJson(reqJson(), resJson(big, { Vary: "Origin" }), true);
    expect(withVary.headers.get("Vary")).toBe("Origin, Accept-Encoding");
  });

  test("keeps the other headers and the status", async () => {
    const res = new Response(JSON.stringify(big), {
      status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Mine": "1" },
    });
    const out = await compressJson(reqJson(), res, true);
    expect(out.status).toBe(201);
    expect(out.headers.get("Cache-Control")).toBe("no-store");
    expect(out.headers.get("X-Mine")).toBe("1");
  });

  test("towards loopback it returns the response INTACT, same object", async () => {
    const res = resJson(big);
    expect(await compressJson(reqJson(), res, false)).toBe(res);
  });

  test("a small response comes back readable even though the body was consumed to measure it", async () => {
    const small = { ok: true };
    const out = await compressJson(reqJson(), resJson(small), true);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.json()).toEqual(small);
  });

  test("a 304 comes out intact: no header talking about a body that is not there", async () => {
    const notModified = new Response(null, { status: 304, headers: { "Content-Type": "application/json" } });
    const out = await compressJson(reqJson(), notModified, true);
    expect(out).toBe(notModified);
    expect(out.status).toBe(304);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(out.headers.get("Content-Length")).toBeNull();
  });

  test("streaming passes through untouched", async () => {
    const sse = new Response("data: hello\n\n", { headers: { "Content-Type": "text/event-stream" } });
    expect(await compressJson(reqJson(), sse, true)).toBe(sse);
  });

  test("a 500 with a large JSON body compresses like the others", async () => {
    const res = new Response(JSON.stringify(big), { status: 500, headers: { "Content-Type": "application/json" } });
    const out = await compressJson(reqJson(), res, true);
    expect(out.status).toBe(500);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });
});
