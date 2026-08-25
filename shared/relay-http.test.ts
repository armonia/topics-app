/**
 * La testa di una richiesta dentro il tubo: cosa si accetta, e cosa no.
 *
 * Chi scrive queste teste è fuori dalla rete di casa, quindi ogni caso qui è
 * un modo per rendersene conto: un percorso che sceglie un'altra destinazione,
 * un'intestazione che dichiara chi sei, un valore che spezza in due la riga a
 * valle.
 *
 * @covers RELAY-E2E-01
 */
import { describe, expect, it } from "bun:test";
import {
  intestazioniRichiesta, intestazioniRisposta,
  ipAccettabile,
  leggiTestaRichiesta, leggiTestaRisposta, risolviUrlLocale, scriviTesta,
} from "./relay-http";

describe("testa · si legge in modo stretto, o non si legge", () => {
  it("una richiesta normale passa e torna com'era", () => {
    const t = { m: "POST", p: "/api/topics?x=1", h: [["content-type", "application/json"]] as [string, string][] };
    expect(leggiTestaRichiesta(scriviTesta(t))).toEqual(t);
  });

  it("un metodo fuori lista non passa", () => {
    // `CONNECT` chiederebbe di aprire un tunnel verso altro; `TRACE` rimanda
    // indietro la richiesta così com'è.
    for (const m of ["CONNECT", "TRACE", "get", "", "POST "]) {
      expect(`${m}→${leggiTestaRichiesta(JSON.stringify({ m, p: "/x" }))}`).toBe(`${m}→null`);
    }
    // Controllo positivo: la lista non è vuota.
    expect(leggiTestaRichiesta(JSON.stringify({ m: "DELETE", p: "/x" }))).not.toBeNull();
  });

  it("una testa che non è JSON, o non è un oggetto, o è vuota", () => {
    for (const raw of ["", "non json", "[]", "null", "42"]) {
      expect(`${raw}→${leggiTestaRichiesta(raw)}`).toBe(`${raw}→null`);
    }
    expect(leggiTestaRichiesta(undefined)).toBeNull();
  });

  it("intestazioni che non sono coppie di stringhe", () => {
    const storte: unknown[] = [{ a: 1 }, [["a"]], [["a", 1]], [[1, "a"]], "no"];
    for (const h of storte) {
      expect(leggiTestaRichiesta(JSON.stringify({ m: "GET", p: "/x", h }))).toBeNull();
    }
  });

  it("una risposta vuole uno stato che sia uno stato", () => {
    expect(leggiTestaRisposta(JSON.stringify({ re: 1, s: 200 }))).toEqual({ re: 1, s: 200 });
    for (const s of [99, 600, 200.5, "200"]) {
      expect(`${s}→${leggiTestaRisposta(JSON.stringify({ re: 1, s }))}`).toBe(`${s}→null`);
    }
    for (const re of [-1, 1.5, "1"]) {
      expect(`${re}→${leggiTestaRisposta(JSON.stringify({ re, s: 200 }))}`).toBe(`${re}→null`);
    }
  });
});

describe("testa · il percorso non sceglie la destinazione", () => {
  const PORTA = 13999;

  it("un percorso normale finisce su loopback e sulla porta data", () => {
    const u = risolviUrlLocale(PORTA, "/api/topics?limit=2");
    expect(u?.href).toBe(`http://127.0.0.1:${PORTA}/api/topics?limit=2`);
  });

  it("tutto ciò che punta ALTROVE è nulla", () => {
    const fuori = [
      "//altro.example/x",          // «stesso schema, altro host»
      "http://altro.example/x",
      "https://altro.example/x",
      "/\\altro.example/x",         // la barra rovesciata la si normalizza
      "/api /x",                    // uno spazio spezza la riga a valle
      "",
      "api/topics",                 // relativo: non si sa da dove
    ];
    for (const p of fuori) {
      expect(`${p}→${risolviUrlLocale(PORTA, p)}`).toBe(`${p}→null`);
    }
  });

  it("una porta che non è una porta", () => {
    for (const porta of [0, -1, 70000, 1.5]) {
      expect(`${porta}→${risolviUrlLocale(porta, "/x")}`).toBe(`${porta}→null`);
    }
  });
});

describe("testa · l'ospite non dichiara chi è, e non descrive un trasporto che non c'è", () => {
  it("via le dichiarazioni di indirizzo, e via quelle di salto", () => {
    const dentro = intestazioniRichiesta([
      ["Cookie", "topics_session=abc"],
      ["CF-Connecting-IP", "9.9.9.9"],
      ["X-Forwarded-For", "8.8.8.8"],
      ["x-real-ip", "7.7.7.7"],
      ["Host", "altro.example"],
      ["Content-Length", "99"],
      ["Connection", "keep-alive"],
      ["Content-Type", "application/json"],
    ]);
    // I nomi si abbassano: a valle si confrontano sempre così.
    expect(dentro).toEqual([["cookie", "topics_session=abc"], ["content-type", "application/json"]]);
  });

  it("un valore con un ritorno a capo dentro non passa", () => {
    // È il modo classico per far leggere DUE richieste dove ce n'era una.
    const dentro = intestazioniRichiesta([
      ["x-buona", "va bene"],
      ["x-cattiva", "a\r\nGET /altro HTTP/1.1"],
    ]);
    expect(dentro).toEqual([["x-buona", "va bene"]]);
  });

  it("un nome che non è un token non passa", () => {
    expect(intestazioniRichiesta([["x y", "v"], ["x:z", "v"], ["", "v"], ["ok", "v"]]))
      .toEqual([["ok", "v"]]);
  });

  it("`content-encoding` non torna indietro: il corpo è già scompattato", () => {
    // Mandarla avanti direbbe all'ospite di scompattare una seconda volta
    // qualcosa che è già testo.
    expect(intestazioniRisposta([
      ["content-encoding", "gzip"],
      ["content-length", "12"],
      ["content-type", "text/html"],
      ["set-cookie", "a=1"],
    ])).toEqual([["content-type", "text/html"], ["set-cookie", "a=1"]]);
  });

  it("più di cento intestazioni si tagliano", () => {
    const tante: [string, string][] = [];
    for (let i = 0; i < 150; i++) tante.push([`x-n${i}`, "v"]);
    expect(intestazioniRichiesta(tante).length).toBe(100);
  });

  it("un valore enorme si lascia fuori invece di portarselo dietro", () => {
    const dentro = intestazioniRichiesta([["x-grosso", "v".repeat(9000)], ["x-piccola", "v"]]);
    expect(dentro).toEqual([["x-piccola", "v"]]);
  });
});

describe("url locale · lo schema segue l'ascoltatore", () => {
  // Il difetto che questo presidia è costato il primo tentativo di
  // raggiungibilità vera: lo schema era cablato a `http`, ma la porta del
  // tunnel eredita `opzioniServer` e su un'installazione con i certificati
  // parla TLS. Misurato in produzione: `http` connessione rifiutata, `https`
  // 401. Il ponte rispondeva `upstream-unreachable` a ogni richiesta, e
  // l'errore non nominava mai lo schema.
  it("senza TLS resta http, con TLS diventa https", () => {
    expect(risolviUrlLocale(3334, "/api/x")?.origin).toBe("http://127.0.0.1:3334");
    expect(risolviUrlLocale(3334, "/api/x", true)?.origin).toBe("https://127.0.0.1:3334");
  });

  it("il percorso e la query sopravvivono al cambio di schema", () => {
    const u = risolviUrlLocale(3334, "/api/topics?a=1&b=2", true);
    expect(u?.pathname).toBe("/api/topics");
    expect(u?.search).toBe("?a=1&b=2");
  });

  it("i rifiuti valgono anche in TLS: non è una porta di servizio", () => {
    // Lo schema nuovo non deve allargare ciò che passa. Se un percorso storto
    // fosse accettato solo perché TLS, avremmo aperto una seconda strada.
    for (const cattivo of ["//altrove", "/a b", "/a\\b", "senza-barra"]) {
      expect(`${cattivo}→${risolviUrlLocale(3334, cattivo, true)}`).toBe(`${cattivo}→null`);
    }
  });
});

describe("indirizzo di chi bussa · il relay lo dice, la macchina lo controlla", () => {
  // Il difetto, visto in produzione: la macchina leggeva `127.0.0.1` per
  // richieste arrivate da Internet, perché l'unico indirizzo che vede è il
  // proprio salto locale e le intestazioni di inoltro le spoglia apposta.
  // Due danni: il tetto per-indirizzo dell'appaiamento diventava UN SOLO
  // secchio per tutta Internet, e il cartello di approvazione dichiarava
  // «viene dalla tua macchina» a chi arrivava da fuori.
  it("un indirizzo buono passa, in v4 e in v6", () => {
    for (const ip of ["203.0.113.7", "2001:db8::1", "::ffff:203.0.113.7"]) {
      expect(`${ip}→${ipAccettabile(ip)}`).toBe(`${ip}→true`);
    }
  });

  it("tutto ciò che non è un indirizzo viene rifiutato", () => {
    // Questo valore finisce in un tetto e su un cartello che un umano legge
    // per decidere: una stringa qualunque lì dentro è un modo di scrivere
    // nell'interfaccia di chi approva.
    for (const no of ["", "999.1.1.1", "1.2.3", "ciao", "1.2.3.4 <b>", "  ", "1.2.3.4\n", 42, null, undefined]) {
      expect(`${String(no)}→${ipAccettabile(no)}`).toBe(`${String(no)}→false`);
    }
    expect(ipAccettabile("1".repeat(46))).toBe(false);
  });

  it("la testa porta l'indirizzo quando è buono", () => {
    const t = leggiTestaRichiesta(JSON.stringify({ m: "GET", p: "/api/x", ip: "203.0.113.7" }));
    expect(t?.ip).toBe("203.0.113.7");
  });

  it("un indirizzo storto si SCARTA, e la richiesta vive lo stesso", () => {
    // Una richiesta valida non deve morire perché il relay ha mandato un campo
    // storto; ma il campo storto non deve entrare.
    const t = leggiTestaRichiesta(JSON.stringify({ m: "GET", p: "/api/x", ip: "<script>" }));
    expect(t, "la richiesta resta valida").not.toBeNull();
    expect(t?.p).toBe("/api/x");
    expect(t?.ip, "l'indirizzo storto non entra").toBeUndefined();
  });

  it("le intestazioni di inoltro restano VIETATE: l'ospite non se le scrive", () => {
    // È il motivo per cui l'indirizzo viaggia nella TESTA e non in
    // un'intestazione: la testa la compone il relay, le intestazioni no.
    const h = intestazioniRichiesta([
      ["x-forwarded-for", "1.2.3.4"], ["cf-connecting-ip", "1.2.3.4"], ["cookie", "a=b"],
    ]);
    const n = new Headers(h);
    expect(n.get("x-forwarded-for")).toBeNull();
    expect(n.get("cf-connecting-ip")).toBeNull();
    // Controllo positivo: qualcosa passa davvero, altrimenti questo test
    // sarebbe verde anche su un filtro che butta via tutto.
    expect(n.get("cookie")).toBe("a=b");
  });
});
