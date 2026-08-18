import { describe, test, expect, afterEach } from "bun:test";
import { fetchLocal, localBase } from "./topics";

/**
 * `cli/topics.ts` aveva `http://` scritto a mano in tre punti mentre il server
 * accende TLS da solo appena trova i certificati (`server.ts`, dal 3 luglio):
 * contro un'installazione reale ogni comando moriva sul primo fetch. Non era
 * degradato, non funzionava.
 *
 * Quel che va difeso non e' «usa https», e' la REGOLA: si ripiega in chiaro
 * solo quando il trasporto non ha risposto. Un 500 e' una risposta — ripeterlo
 * in HTTP manderebbe in chiaro una richiesta che era gia' arrivata a
 * destinazione, e su un token di bearer non e' una sfumatura.
 */
const ORIGINAL_SCHEME = process.env.TOPICS_SCHEME;
afterEach(() => {
  if (ORIGINAL_SCHEME === undefined) delete process.env.TOPICS_SCHEME;
  else process.env.TOPICS_SCHEME = ORIGINAL_SCHEME;
});

describe("lo schema con cui la CLI parla al server locale", () => {
  test("prova HTTPS per primo", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchLocal(3333, "/api/x", {}, fake);
    expect(seen).toEqual(["https://127.0.0.1:3333/api/x"]);
  });

  test("un server in chiaro resta raggiungibile: HTTPS rifiutato → si ripiega", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      if (String(url).startsWith("https:")) throw new Error("ECONNRESET");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchLocal(3333, "/api/x", {}, fake);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://127.0.0.1:3333/api/x", "http://127.0.0.1:3333/api/x"]);
  });

  test("un errore HTTP non e' un motivo per riprovare in chiaro", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const res = await fetchLocal(3333, "/api/x", {}, fake);
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(1);
  });

  test("se nessuno dei due risponde, l'errore arriva a chi ha chiamato", async () => {
    const fake = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(fetchLocal(3333, "/api/x", {}, fake)).rejects.toThrow("ECONNREFUSED");
  });

  test("TOPICS_SCHEME forza la mano e non ripiega", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    process.env.TOPICS_SCHEME = "http";
    await expect(fetchLocal(3333, "/api/x", {}, fake)).rejects.toThrow();
    expect(seen).toEqual(["http://127.0.0.1:3333/api/x"]);
  });

  test("resta sul loopback: mai un host che non sia 127.0.0.1", () => {
    expect(localBase(3333, "https")).toBe("https://127.0.0.1:3333");
    expect(localBase(9, "http")).toBe("http://127.0.0.1:9");
  });
});
