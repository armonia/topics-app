/**
 * @covers LOOPBACK-01
 */
import { describe, expect, test } from "bun:test";
import net from "node:net";
import { isPortListening, loopbackPortOf } from "./loopback-probe";

describe("loopbackPortOf", () => {
  test("prende la porta esplicita nelle varie forme di loopback", () => {
    expect(loopbackPortOf("http://localhost:3210/login")).toBe(3210);
    expect(loopbackPortOf("http://127.0.0.1:8791/report.html")).toBe(8791);
    expect(loopbackPortOf("https://localhost:3333/x")).toBe(3333);
    expect(loopbackPortOf("http://app.localhost:5199/")).toBe(5199);
  });

  test("la porta implicita conta: una scheda su http://localhost è la 80", () => {
    expect(loopbackPortOf("http://localhost/")).toBe(80);
    expect(loopbackPortOf("https://localhost/")).toBe(443);
  });

  test("null su tutto ciò che non è loopback — la rotta non è un port scanner", () => {
    expect(loopbackPortOf("https://example.com:3210/")).toBeNull();
    expect(loopbackPortOf("https://localhost.example.com/")).toBeNull();
    expect(loopbackPortOf("http://192.168.1.10:3000/")).toBeNull();
    expect(loopbackPortOf("file:///etc/passwd")).toBeNull();
    expect(loopbackPortOf("non una url")).toBeNull();
  });
});

describe("isPortListening", () => {
  test("vero mentre un server è su, falso appena si spegne", async () => {
    const srv = net.createServer();
    const port: number = await new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });

    expect(await isPortListening(port)).toBe(true);

    await new Promise<void>((resolve) => srv.close(() => resolve()));
    // È il caso vero della scheda parcheggiata: stessa porta, server morto.
    expect(await isPortListening(port)).toBe(false);
  });

  test("un server in ascolto SOLO su ::1 non va dato per morto", async () => {
    // `server.listen(port)` senza host finisce spesso sul solo IPv6: sondare
    // solo 127.0.0.1 parcheggerebbe una scheda viva.
    const srv = net.createServer();
    const port: number = await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "::1", () => resolve((srv.address() as net.AddressInfo).port));
    });

    expect(await isPortListening(port)).toBe(true);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  test("una porta libera non fa aspettare il timeout intero", async () => {
    const t0 = Date.now();
    expect(await isPortListening(1, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(300);
  });
});
