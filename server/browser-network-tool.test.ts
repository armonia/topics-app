/**
 * Il tool `browser_network` visto da chi lo chiama: il contratto della risposta.
 *
 * I test del filtro (`browser-network-log.test.ts`) provano la selezione. Qui si
 * prova la cosa che il filtro da solo non copre e che rende la risposta ONESTA:
 * `recorded` deve dire quante richieste sono state viste **in tutto**, non
 * quante ne mostro. Senza, una risposta corta si legge come «non è successo
 * niente» invece di «te ne mostro dieci su trecento», e chi indaga si ferma un
 * passo prima del difetto.
  * @covers NETLOG-02
 */
import { describe, test, expect } from "bun:test";
import { handleBrowserNetwork } from "./browser-tools-handler";
import type { NetworkEntry } from "./browser-network-log";
import type { BrowserService } from "./browser-service";

const entries: NetworkEntry[] = [
  { startedAt: 1, method: "GET", url: "https://x/api/me", resourceType: "xhr", status: 200, durationMs: 12 },
  { startedAt: 2, method: "POST", url: "https://x/api/login", resourceType: "fetch", status: 401, durationMs: 30 },
  { startedAt: 3, method: "GET", url: "https://x/logo.png", resourceType: "image", status: 200 },
  { startedAt: 4, method: "GET", url: "https://x/api/boom", resourceType: "xhr", failure: "net::ERR_FAILED" },
];

/** Il minimo di servizio che il handler tocca davvero. */
const fakeService = (list: NetworkEntry[]) =>
  ({ getNetworkEntries: () => list } as unknown as BrowserService);

describe("handleBrowserNetwork", () => {
  test("di default niente immagini, e il conto totale resta visibile", async () => {
    const r = await handleBrowserNetwork(fakeService(entries), "ctx", {});
    expect("entries" in r).toBe(true);
    if (!("entries" in r)) return;
    expect(r.entries.map((e) => e.url)).toEqual([
      "https://x/api/me", "https://x/api/login", "https://x/api/boom",
    ]);
    // Quattro viste, tre mostrate: la differenza è ciò che rende la risposta onesta.
    expect(r.recorded).toBe(4);
    expect(r.shown).toBe(3);
    expect(r.failures).toBe(2);
  });

  test("solo-fallimenti tiene il 401 E quella mai risposta", async () => {
    const r = await handleBrowserNetwork(fakeService(entries), "ctx", { only_failures: true });
    if (!("entries" in r)) throw new Error("attesa una risposta con entries");
    expect(r.entries.map((e) => e.url)).toEqual(["https://x/api/login", "https://x/api/boom"]);
  });

  test("un servizio che esplode diventa un errore leggibile, non un'eccezione", async () => {
    const broken = { getNetworkEntries: () => { throw new Error("pane sparita"); } } as unknown as BrowserService;
    const r = await handleBrowserNetwork(broken, "ctx", {});
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("pane sparita");
  });

  test("nessuna richiesta registrata: elenco vuoto e zero, non un errore", async () => {
    const r = await handleBrowserNetwork(fakeService([]), "ctx", {});
    if (!("entries" in r)) throw new Error("attesa una risposta con entries");
    expect(r.entries).toEqual([]);
    expect(r.recorded).toBe(0);
  });
});
