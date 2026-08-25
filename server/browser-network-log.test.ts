/**
 * Il difetto che questo modulo può avere non è «non registra»: è **restituire
 * la cosa sbagliata a chi sta indagando**. Due modi di sbagliare, e i test
 * insistono su quelli: nascondere una chiamata fallita, e seppellirla sotto
 * trecento immagini.
  * @covers NETLOG-01
 */
import { describe, test, expect } from "bun:test";
import {
  pushNetworkEntry,
  completeNetworkEntry,
  filterNetwork,
  summarizeNetwork,
  isFailure,
  type NetworkEntry,
} from "./browser-network-log";

const e = (o: Partial<NetworkEntry> & { url: string }): NetworkEntry => ({
  startedAt: 1000, method: "GET", resourceType: "xhr", ...o,
});

describe("pushNetworkEntry", () => {
  test("oltre il tetto butta le PIÙ VECCHIE, non le nuove", () => {
    // Il verso opposto renderebbe il registro inutile proprio dopo l'azione che
    // si sta indagando.
    const buf: NetworkEntry[] = [];
    for (let i = 0; i < 5; i++) pushNetworkEntry(buf, e({ url: `/a/${i}` }), 3);
    expect(buf.map((x) => x.url)).toEqual(["/a/2", "/a/3", "/a/4"]);
  });
});

describe("completeNetworkEntry", () => {
  test("chiude la richiesta con stato e durata", () => {
    const buf = [e({ url: "/api/x", startedAt: 1000 })];
    completeNetworkEntry(buf, "/api/x", { status: 200, at: 1350 });
    expect(buf[0]).toMatchObject({ status: 200, durationMs: 350 });
  });

  test("con la stessa URL due volte chiude quella ANCORA APERTA", () => {
    // Cercare dall'inizio riscriverebbe una richiesta già conclusa e lascerebbe
    // quella in volo senza esito — cioè invisibile a `onlyFailures`.
    const buf = [e({ url: "/api/x", status: 200 }), e({ url: "/api/x", startedAt: 2000 })];
    completeNetworkEntry(buf, "/api/x", { status: 500, at: 2100 });
    expect(buf[0]!.status).toBe(200);
    expect(buf[1]!.status).toBe(500);
  });

  test("una richiesta fallita porta il MOTIVO, non solo l'assenza di stato", () => {
    const buf = [e({ url: "/api/x" })];
    completeNetworkEntry(buf, "/api/x", { failure: "net::ERR_CONNECTION_REFUSED", at: 1200 });
    expect(buf[0]!.failure).toContain("ERR_CONNECTION_REFUSED");
    expect(isFailure(buf[0]!)).toBe(true);
  });

  test("un esito per una URL che non c'è non rompe niente", () => {
    const buf: NetworkEntry[] = [];
    completeNetworkEntry(buf, "/mai/vista", { status: 200, at: 1 });
    expect(buf).toEqual([]);
  });
});

describe("filterNetwork", () => {
  const dati = [
    e({ url: "/api/login", resourceType: "xhr", status: 401 }),
    e({ url: "/api/me", resourceType: "fetch", status: 200 }),
    e({ url: "/logo.png", resourceType: "image", status: 200 }),
    e({ url: "/font.woff2", resourceType: "font", status: 200 }),
  ];

  test("di default tiene SOLO ciò che porta dati", () => {
    // È il muro di token: una pagina qualsiasi fa centinaia di richieste di
    // immagini e font, e restituirle spegne l'utilità della risposta.
    expect(filterNetwork(dati).map((x) => x.url)).toEqual(["/api/login", "/api/me"]);
  });

  test("i tipi si possono chiedere esplicitamente", () => {
    expect(filterNetwork(dati, { types: ["image"] }).map((x) => x.url)).toEqual(["/logo.png"]);
  });

  test("onlyFailures prende il 4xx E la richiesta mai risposta", () => {
    const conFallita = [...dati, e({ url: "/api/boom", failure: "ERR" })];
    expect(filterNetwork(conFallita, { onlyFailures: true }).map((x) => x.url))
      .toEqual(["/api/login", "/api/boom"]);
  });

  test("il filtro sull'URL non distingue maiuscole", () => {
    expect(filterNetwork(dati, { urlContains: "LOGIN" }).map((x) => x.url)).toEqual(["/api/login"]);
  });

  test("il limite tiene le PIÙ RECENTI", () => {
    // Chi chiede della rete sta guardando ciò che ha appena fatto.
    const molte = Array.from({ length: 10 }, (_, i) => e({ url: `/api/${i}` }));
    expect(filterNetwork(molte, { limit: 2 }).map((x) => x.url)).toEqual(["/api/8", "/api/9"]);
  });

  test("nessuna corrispondenza: elenco vuoto, non tutto", () => {
    expect(filterNetwork(dati, { urlContains: "inesistente" })).toEqual([]);
  });
});

describe("summarizeNetwork", () => {
  test("dice quante ne sono state registrate in tutto: una risposta corta resta onesta", () => {
    const all = [e({ url: "/a", status: 500 }), e({ url: "/b", status: 200 }), e({ url: "/c", resourceType: "image" })];
    const shown = filterNetwork(all, { limit: 1 });
    const s = summarizeNetwork(all, shown);
    expect(s.recorded).toBe(3);
    expect(s.shown).toBe(1);
    expect(s.failures).toBe(1);
  });
});
