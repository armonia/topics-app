import { describe, expect, test } from "bun:test";
import { comprimiJson, vaCompressa, SOGLIA_BYTE } from "./compress-json";

const base = {
  metodo: "GET",
  acceptEncoding: "gzip, deflate, br",
  contentType: "application/json",
  contentEncoding: null,
  remoto: true,
  byte: 100_000,
};

describe("vaCompressa", () => {
  test("sì per una risposta JSON grande verso un peer remoto che sa scompattare", () => {
    expect(vaCompressa(base)).toBe(true);
  });

  test("NO verso loopback: 60 ms di CPU per un trasferimento che è già gratis", () => {
    expect(vaCompressa({ ...base, remoto: false })).toBe(false);
  });

  test("NO per lo streaming della chat", () => {
    expect(vaCompressa({ ...base, contentType: "text/event-stream" })).toBe(false);
  });

  test("NO se il client non ha chiesto gzip", () => {
    expect(vaCompressa({ ...base, acceptEncoding: null })).toBe(false);
    expect(vaCompressa({ ...base, acceptEncoding: "br" })).toBe(false);
    expect(vaCompressa({ ...base, acceptEncoding: "deflate" })).toBe(false);
  });

  test("`gzip` è un token, non una sottostringa", () => {
    expect(vaCompressa({ ...base, acceptEncoding: "gzipx" })).toBe(false);
    expect(vaCompressa({ ...base, acceptEncoding: "x-gzip" })).toBe(false);
    expect(vaCompressa({ ...base, acceptEncoding: "gzip" })).toBe(true);
    expect(vaCompressa({ ...base, acceptEncoding: "br, gzip;q=0.9" })).toBe(true);
    expect(vaCompressa({ ...base, acceptEncoding: "gzip;q=1.0, deflate" })).toBe(true);
  });

  test("NO su HEAD: il corpo lo svuota Bun, la lunghezza sarebbe una bugia", () => {
    expect(vaCompressa({ ...base, metodo: "HEAD" })).toBe(false);
  });

  test("NO se qualcuno l ha già codificata", () => {
    expect(vaCompressa({ ...base, contentEncoding: "gzip" })).toBe(false);
  });

  test("NO sotto un MTU: non si risparmia nemmeno un viaggio", () => {
    expect(vaCompressa({ ...base, byte: SOGLIA_BYTE - 1 })).toBe(false);
    expect(vaCompressa({ ...base, byte: SOGLIA_BYTE })).toBe(true);
  });

  test("byte ancora ignoti: si decide sul resto e si ricontrolla dopo", () => {
    expect(vaCompressa({ ...base, byte: null })).toBe(true);
  });

  test("content-type con charset resta JSON", () => {
    expect(vaCompressa({ ...base, contentType: "application/json; charset=utf-8" })).toBe(true);
  });
});

function reqJson(headers: Record<string, string> = { "accept-encoding": "gzip" }, metodo = "GET"): Request {
  return new Request("http://h/api/x", { method: metodo, headers });
}
function resJson(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** Un corpo che comprime bene, come il JSON vero di questa app. */
const grosso = { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: "assistant", content: "una riga di testo che si ripete" })) };

describe("comprimiJson", () => {
  test("comprime e il client rilegge ESATTAMENTE lo stesso JSON", async () => {
    const originale = JSON.stringify(grosso);
    const out = await comprimiJson(reqJson(), resJson(grosso), true);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(Number(out.headers.get("Content-Length"))).toBeLessThan(originale.length);
    const rigonfiato = Bun.gunzipSync(new Uint8Array(await out.arrayBuffer()));
    expect(new TextDecoder().decode(rigonfiato)).toBe(originale);
  });

  test("dichiara Vary, o una cache servirebbe i byte compressi a chi non li sa leggere", async () => {
    const out = await comprimiJson(reqJson(), resJson(grosso), true);
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    const conVary = await comprimiJson(reqJson(), resJson(grosso, { Vary: "Origin" }), true);
    expect(conVary.headers.get("Vary")).toBe("Origin, Accept-Encoding");
  });

  test("tiene le altre intestazioni e lo stato", async () => {
    const res = new Response(JSON.stringify(grosso), {
      status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Mio": "1" },
    });
    const out = await comprimiJson(reqJson(), res, true);
    expect(out.status).toBe(201);
    expect(out.headers.get("Cache-Control")).toBe("no-store");
    expect(out.headers.get("X-Mio")).toBe("1");
  });

  test("verso loopback torna la risposta INTATTA, stesso oggetto", async () => {
    const res = resJson(grosso);
    expect(await comprimiJson(reqJson(), res, false)).toBe(res);
  });

  test("una risposta piccola torna leggibile anche se il corpo è stato consumato per misurarla", async () => {
    const piccola = { ok: true };
    const out = await comprimiJson(reqJson(), resJson(piccola), true);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.json()).toEqual(piccola);
  });

  test("lo streaming passa senza essere toccato", async () => {
    const sse = new Response("data: ciao\n\n", { headers: { "Content-Type": "text/event-stream" } });
    expect(await comprimiJson(reqJson(), sse, true)).toBe(sse);
  });

  test("un 500 con corpo JSON grande si comprime come gli altri", async () => {
    const res = new Response(JSON.stringify(grosso), { status: 500, headers: { "Content-Type": "application/json" } });
    const out = await comprimiJson(reqJson(), res, true);
    expect(out.status).toBe(500);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });
});
