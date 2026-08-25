/**
 * Il proxy della macchina: una richiesta arrivata dal relay, rigiocata contro
 * l'ascoltatore del tunnel.
 *
 * ── PERCHÉ QUI C'È UN SERVER VERO ───────────────────────────────────────────
 * Perché la cosa da provare è proprio il RIGIOCARE: metodo, percorso,
 * intestazioni, corpo, e poi lo stato e il corpo che tornano indietro a pezzi.
 * Una `fetch` finta proverebbe che il proxy chiama una funzione — cioè
 * nient'altro che se stesso. Il server sta su `127.0.0.1` con porta effimera,
 * quindi non tocca né la :3333 di produzione né le porte dei test E2E.
 *
 * ── E PERCHÉ L'OSPITE È QUELLO DI `shared/relay-fake.ts` ────────────────────
 * Perché sia una SECONDA implementazione a leggere ciò che questa scrive. Se il
 * proxy cominciasse a dipendere da un campo che il formato non promette,
 * l'ospite finto smetterebbe di capirlo — che è l'unico modo perché il formato
 * abbia una definizione fuori da chi lo usa.
 * @covers RELAY-E2E-04, RELAY-E2E-05, RELAY-E2E-07
 */
import { afterEach, describe, expect, it } from "bun:test";
import { creaRelayClient } from "./relay-client";
import { creaOspiteHttp, SEGRETO_FINTO } from "../../shared/relay-fake";
import { involucro, leggiMessaggio, type FrameTubo } from "../../shared/relay-protocol";
import { GENERE_RISPOSTA } from "../../shared/relay-http";
import { nuovaChiave, sigilla, apri } from "../../shared/relay-crypto";

// ── Un WebSocket che non è una rete ────────────────────────────────────────
class SocketFinta {
  readyState = 1;
  inviati: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Cosa fare di ciò che la macchina manda. */
  consegna: ((d: string) => void) | null = null;
  send(d: string) { this.inviati.push(d); this.consegna?.(d); }
  close() { this.readyState = 3; }
}

const SID = "s1";

interface Chiusura { chiudi(): void }
const daChiudere: Chiusura[] = [];
afterEach(() => {
  while (daChiudere.length > 0) daChiudere.pop()?.chiudi();
});

function serverLocale(gestore: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: gestore });
  daChiudere.push({ chiudi: () => { try { s.stop(true); } catch { /* già ferma */ } } });
  return s;
}

function scena(opts: { porta: number | null | undefined; maxFrame?: number; fetchLocale?: typeof fetch }) {
  const sock = new SocketFinta();
  const link = { ref: "r1", key: nuovaChiave(), resourceType: "task" as const, resourceId: "t1", expiresAt: Date.now() + 60_000, revokedAt: null };
  const c = creaRelayClient({
    baseUrl: "http://relay.test",
    relayId: "i1",
    segreto: SEGRETO_FINTO,
    trovaLink: (ref) => (ref === link.ref ? link : null),
    serviRisorsa: async () => ({ status: 200, body: { id: "t1" } }),
    segnaApertura: () => {},
    apriSocket: () => sock as unknown as WebSocket,
    portaTunnel: opts.porta ?? null,
    ...(opts.maxFrame !== undefined ? { maxFrame: opts.maxFrame } : {}),
    ...(opts.fetchLocale !== undefined ? { fetchLocale: opts.fetchLocale } : {}),
  });
  daChiudere.push({ chiudi: () => c.ferma() });
  c.avvia();
  sock.onopen?.();
  // The relay CONFIRMS it took us in: without this the client keeps a thread
  // that nobody owns, and after ten seconds it closes it on purpose. The real
  // meeting point sends `ready` the instant it attaches, so simulating the
  // open without it was half a handshake.
  sock.onmessage?.({ data: JSON.stringify({ t: "ready", v: 1 }) });

  const ospite = creaOspiteHttp({
    invia: (p) => sock.onmessage?.({ data: JSON.stringify({ t: "to-guest", to: SID, payload: p }) }),
  });
  sock.consegna = (d) => {
    const m = leggiMessaggio(JSON.parse(d));
    if (m && m.t === "to-guest") ospite.ricevi(m.payload);
  };

  return { c, sock, ospite, link };
}

/** I frame del tubo che la macchina ha mandato all'ospite. */
function frameUsciti(sock: SocketFinta): FrameTubo[] {
  const out: FrameTubo[] = [];
  for (const d of sock.inviati) {
    const m = leggiMessaggio(JSON.parse(d));
    if (!m || m.t !== "to-guest") continue;
    try { out.push(JSON.parse(m.payload) as FrameTubo); } catch { /* non è un frame */ }
  }
  return out;
}

async function finoA(cond: () => boolean, ms = 2000): Promise<boolean> {
  const fine = Date.now() + ms;
  while (Date.now() < fine) {
    if (cond()) return true;
    await Bun.sleep(5);
  }
  return cond();
}

const testo = (r: { corpo: Uint8Array }) => new TextDecoder().decode(r.corpo);

describe("proxy · una richiesta va davvero a finire sulla porta del tunnel", () => {
  it("metodo, percorso, query e intestazioni arrivano come sono partiti", async () => {
    interface Visto { m: string; p: string; xy: string | null }
    let visto: Visto | null = null;
    const srv = serverLocale((req) => {
      const u = new URL(req.url);
      visto = { m: req.method, p: `${u.pathname}${u.search}`, xy: req.headers.get("x-prova") };
      return Response.json({ ok: true });
    });

    const s = scena({ porta: srv.port });
    const r = await s.ospite.chiedi("GET", "/api/topics?limit=2", { h: [["x-prova", "ciao"]] }).risposta;

    expect(visto as Visto | null).toEqual({ m: "GET", p: "/api/topics?limit=2", xy: "ciao" });
    expect(r?.stato).toBe(200);
    expect(JSON.parse(testo(r!))).toEqual({ ok: true });
  });

  it("il CORPO di una POST arriva identico, e la risposta torna", async () => {
    let ricevuto = "";
    const srv = serverLocale(async (req) => {
      ricevuto = await req.text();
      return new Response("preso", { status: 201 });
    });

    const s = scena({ porta: srv.port });
    const corpo = JSON.stringify({ nome: "una topic", note: "àèìòù 🙂" });
    const r = await s.ospite.chiedi("POST", "/api/topics", {
      corpo, h: [["content-type", "application/json"]],
    }).risposta;

    expect(ricevuto).toBe(corpo);
    expect(r?.stato).toBe(201);
    expect(testo(r!)).toBe("preso");
  });

  it("uno stato che non è 200 è una RISPOSTA, non un guasto", async () => {
    const srv = serverLocale(() => new Response("no", { status: 404 }));
    const s = scena({ porta: srv.port });
    const r = await s.ospite.chiedi("GET", "/api/niente").risposta;
    expect(r?.stato).toBe(404);
    expect(testo(r!)).toBe("no");
  });

  it("un `set-cookie` per volta, e non uno solo con le virgole in mezzo", async () => {
    // È il biscotto dell'appaiamento: due `set-cookie` uniti da virgola non si
    // sanno più separare a valle, perché la data di scadenza ne contiene una.
    const srv = serverLocale(() => {
      const h = new Headers();
      h.append("set-cookie", "a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
      h.append("set-cookie", "b=2; Path=/");
      return new Response("ok", { headers: h });
    });

    const s = scena({ porta: srv.port });
    const r = await s.ospite.chiedi("GET", "/x").risposta;
    const cookie = (r?.intestazioni ?? []).filter(([n]) => n === "set-cookie").map(([, v]) => v);
    expect(cookie.length).toBe(2);
    expect(cookie[0]).toContain("a=1");
    expect(cookie[1]).toContain("b=2");
  });

  it("`content-length` non torna indietro: la misura di qua non è quella di là", async () => {
    const srv = serverLocale(() => new Response("dodici byte"));
    const s = scena({ porta: srv.port });
    const r = await s.ospite.chiedi("GET", "/x").risposta;
    // Controllo positivo: qualche intestazione torna davvero, quindi l'assenza
    // qui sotto non è «non torna niente».
    expect((r?.intestazioni ?? []).some(([n]) => n === "content-type")).toBe(true);
    expect((r?.intestazioni ?? []).some(([n]) => n === "content-length")).toBe(false);
  });
});

describe("proxy · il corpo torna A PEZZI, non tutto alla fine", () => {
  it("una risposta più grossa di un frame arriva spezzata e identica", async () => {
    const grosso = "x".repeat(5000);
    const srv = serverLocale(() => new Response(grosso));
    const s = scena({ porta: srv.port, maxFrame: 64 });

    const r = await s.ospite.chiedi("GET", "/grosso").risposta;
    expect(testo(r!)).toBe(grosso);
    // Controllo positivo: è passato davvero spezzato, o sopra si starebbe
    // provando il caso facile del pezzo unico.
    const dati = frameUsciti(s.sock).filter((f) => f.f === "data");
    expect(dati.length).toBeGreaterThan(20);
  });

  it("il primo pezzo parte MENTRE il corpo di sopra è ancora aperto", async () => {
    // È la differenza fra vedere una chat scrivere e riceverla tutta alla fine.
    let spingi: ((s: string) => void) | null = null;
    let chiudi: (() => void) | null = null;
    const srv = serverLocale(() => new Response(new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        spingi = (t: string) => ctrl.enqueue(enc.encode(t));
        chiudi = () => ctrl.close();
      },
    })));

    const s = scena({ porta: srv.port, maxFrame: 16 });
    const chiesto = s.ospite.chiedi("GET", "/stream");

    expect(await finoA(() => spingi !== null)).toBe(true);
    spingi!("primo pezzo di risposta");
    spingi!("secondo pezzo di risposta");

    // Il frame di apertura della risposta esce PRIMA che il corpo finisca.
    const apertoPrima = await finoA(() =>
      frameUsciti(s.sock).some((f) => f.f === "open" && f.k === GENERE_RISPOSTA));
    expect(apertoPrima).toBe(true);
    // …e nessuno di quei frame porta `fin`: la risposta non è finita.
    expect(frameUsciti(s.sock).some((f) => "fin" in f && f.fin === true)).toBe(false);

    spingi!("terzo");
    chiudi!();
    const r = await chiesto.risposta;
    expect(testo(r!)).toBe("primo pezzo di rispostasecondo pezzo di rispostaterzo");
  });

  it("una risposta SENZA corpo è uno stream che finisce, non uno che non arriva", async () => {
    const srv = serverLocale(() => new Response(null, { status: 204 }));
    const s = scena({ porta: srv.port });
    const r = await s.ospite.chiedi("GET", "/vuoto").risposta;
    expect(r?.stato).toBe(204);
    expect(r?.corpo.length).toBe(0);
  });
});

describe("proxy · senza la porta dedicata si RIFIUTA, non si indovina", () => {
  it("`TOPICS_TUNNEL_PORT` non impostata → 503 dichiarato, e nessuna fetch", async () => {
    // Cadere sulla porta principale farebbe entrare Internet come proprietario:
    // lì ogni richiesta è locale, cioè padrona senza credenziali.
    let chiamate = 0;
    const finta = (async () => { chiamate++; return new Response("mai"); }) as unknown as typeof fetch;
    const s = scena({ porta: null, fetchLocale: finta });

    const r = await s.ospite.chiedi("GET", "/api/topics").risposta;
    expect(r?.stato).toBe(503);
    expect(JSON.parse(testo(r!))).toEqual({ error: "remote-access-not-configured" });
    expect(chiamate).toBe(0);
  });
});

describe("proxy · il percorso non sceglie la destinazione", () => {
  // Un `//host` il parser lo legge come «stesso schema, altro host»; una barra
  // rovesciata la si normalizza in barra; uno spazio spezza la riga a valle; un
  // URL assoluto sceglie tutto.
  const storti = ["//altro.example/x", "/\\altro.example/x", "/api /x", "http://altro.example/x"];

  for (const p of storti) {
    it(`«${p}» \u2192 400, e nessuna fetch`, async () => {
      let chiamate = 0;
      const finta = (async () => { chiamate++; return new Response("mai"); }) as unknown as typeof fetch;
      const s = scena({ porta: 65000, fetchLocale: finta });
      const r = await s.ospite.chiedi("GET", p).risposta;
      expect(r?.stato).toBe(400);
      expect(JSON.parse(testo(r!))).toEqual({ error: "bad-path" });
      expect(chiamate).toBe(0);
    });
  }

  it("un percorso BUONO passa: il cancello di sopra non nega tutto", async () => {
    // Senza questo, i quattro casi qui sopra passerebbero anche con un proxy
    // che rifiuta sempre.
    let chiamate = 0;
    const finta = (async () => { chiamate++; return new Response("ok"); }) as unknown as typeof fetch;
    const s = scena({ porta: 65000, fetchLocale: finta });
    const r = await s.ospite.chiedi("GET", "/api/topics?x=1").risposta;
    expect(r?.stato).toBe(200);
    expect(chiamate).toBe(1);
  });

  it("un metodo fuori lista chiude QUELLA corsia e non serve niente", async () => {
    let chiamate = 0;
    const finta = (async () => { chiamate++; return new Response("mai"); }) as unknown as typeof fetch;
    const s = scena({ porta: 65000, fetchLocale: finta });
    const r = await s.ospite.chiedi("CONNECT", "/altro.example:443").risposta;
    expect(r).toBeNull();
    expect(chiamate).toBe(0);
    expect(frameUsciti(s.sock).some((f) => f.f === "reset" && f.motivo === "bad-frame")).toBe(true);
  });
});

describe("proxy · l'ospite non può dichiarare chi è", () => {
  it("`cf-connecting-ip` e `x-forwarded-for` non arrivano alla macchina", async () => {
    // Da quel numero dipende il tetto di tre tentativi sull'appaiamento: se lo
    // scegliesse l'ospite, un indirizzo nuovo a ogni tentativo e il tetto non
    // esiste più.
    const visto: Record<string, string | null> = {};
    const srv = serverLocale((req) => {
      visto.cf = req.headers.get("cf-connecting-ip");
      visto.xff = req.headers.get("x-forwarded-for");
      visto.cookie = req.headers.get("cookie");
      return new Response("ok");
    });

    const s = scena({ porta: srv.port });
    await s.ospite.chiedi("GET", "/api/auth/session", {
      h: [["cf-connecting-ip", "9.9.9.9"], ["x-forwarded-for", "8.8.8.8"], ["cookie", "topics_session=abc"]],
    }).risposta;

    expect(visto.cf).toBeNull();
    expect(visto.xff).toBeNull();
    // Controllo positivo: le intestazioni passano davvero — è il biscotto che
    // fa entrare un dispositivo appaiato, e senza di lui questo test sarebbe
    // verde anche con un proxy che le butta via tutte.
    expect(visto.cookie).toBe("topics_session=abc");
  });
});

describe("proxy · una corsia che muore non porta giù le altre", () => {
  it("un genere sconosciuto chiude il suo stream, e il successivo funziona", async () => {
    const srv = serverLocale(() => new Response("ok"));
    const s = scena({ porta: srv.port });

    // Un genere che il proxy non conosce, aperto dal contatore dell'ospite —
    // un numero scelto a mano brucerebbe quelli più bassi, e la richiesta dopo
    // verrebbe rifiutata per un motivo che non c'entra niente.
    const sconosciuto = s.ospite.apriGenere("trapano", "dati");
    expect(frameUsciti(s.sock).some((f) => f.f === "reset" && f.s === sconosciuto)).toBe(true);

    const r = await s.ospite.chiedi("GET", "/dopo").risposta;
    expect(r?.stato).toBe(200);
  });

  it("due richieste insieme non si mescolano", async () => {
    const srv = serverLocale(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/lenta") await Bun.sleep(60);
      return new Response(u.pathname);
    });

    const s = scena({ porta: srv.port });
    const a = s.ospite.chiedi("GET", "/lenta").risposta;
    const b = s.ospite.chiedi("GET", "/svelta").risposta;
    const [ra, rb] = await Promise.all([a, b]);
    expect(testo(ra!)).toBe("/lenta");
    expect(testo(rb!)).toBe("/svelta");
  });

  it("chi rinuncia ferma DAVVERO la richiesta di sopra", async () => {
    let interrotta = false;
    let arrivata = false;
    const srv = serverLocale((req) => new Promise<Response>((risolvi) => {
      arrivata = true;
      req.signal.addEventListener("abort", () => { interrotta = true; risolvi(new Response("tardi")); });
    }));

    const s = scena({ porta: srv.port });
    const chiesto = s.ospite.chiedi("GET", "/che-non-finisce");
    // Si aspetta che la richiesta sia DAVVERO arrivata di sopra: rinunciare
    // prima proverebbe soltanto che una `fetch` mai partita non si interrompe.
    expect(await finoA(() => arrivata)).toBe(true);

    s.ospite.annulla(chiesto.s);
    expect(await finoA(() => interrotta)).toBe(true);
    expect(await chiesto.risposta).toBeNull();
  });

  it("l'ospite che se ne va porta via la sessione e ciò che aspettava", async () => {
    let interrotta = false;
    let arrivata = false;
    const srv = serverLocale((req) => new Promise<Response>((risolvi) => {
      arrivata = true;
      req.signal.addEventListener("abort", () => { interrotta = true; risolvi(new Response("tardi")); });
    }));

    const s = scena({ porta: srv.port });
    s.ospite.chiedi("GET", "/che-non-finisce");
    expect(await finoA(() => arrivata)).toBe(true);
    expect(s.c.__sessioni()).toBe(1);

    s.sock.onmessage?.({ data: JSON.stringify({ t: "guest-left", sessionId: SID }) });
    expect(s.c.__sessioni()).toBe(0);
    expect(await finoA(() => interrotta)).toBe(true);
  });

  it("l'ascoltatore giù è un 502 dichiarato, non un silenzio", async () => {
    const srv = serverLocale(() => new Response("ok"));
    const porta = srv.port;
    srv.stop(true);

    const s = scena({ porta });
    const r = await s.ospite.chiedi("GET", "/api/topics").risposta;
    expect(r?.stato).toBe(502);
    expect(JSON.parse(testo(r!))).toEqual({ error: "upstream-unreachable" });
  });
});

describe("proxy · chi instrada non legge", () => {
  it("il contenuto non compare in nessun campo dell'involucro", async () => {
    const segreto = "SEGRETISSIMO-DA-NON-INSTRADARE";
    const srv = serverLocale(() => new Response(segreto));
    const s = scena({ porta: srv.port });
    await s.ospite.chiedi("GET", `/x?q=${segreto}`).risposta;

    const buste = s.sock.inviati.map((d) => leggiMessaggio(JSON.parse(d))).filter((m) => m !== null);
    expect(buste.length).toBeGreaterThan(0); // controllo positivo: c'è passata roba
    for (const m of buste) {
      expect(JSON.stringify(involucro(m))).not.toContain(segreto);
      // …e l'involucro non porta nemmeno il payload.
      expect(Object.keys(involucro(m))).not.toContain("payload");
    }
  });
});

describe("proxy · il link di condivisione continua a rispondere", () => {
  it("la vecchia busta `{ref, b}` passa ancora dalla stessa porta", async () => {
    // La pagina dell'ospite servita dal Worker parla ancora questo verbo:
    // toglierlo qui non la aggiornerebbe, la lascerebbe a parlare con un capo
    // che non risponde più.
    const s = scena({ porta: null });
    const busta = await sigilla(s.link.key, JSON.stringify({ t: "fetch" }));
    s.sock.onmessage?.({ data: JSON.stringify({
      t: "to-guest", to: SID, payload: JSON.stringify({ ref: "r1", b: busta }),
    }) });

    expect(await finoA(() => s.sock.inviati.length > 1)).toBe(true);
    const ultima = leggiMessaggio(JSON.parse(s.sock.inviati[s.sock.inviati.length - 1]!));
    expect(ultima?.t).toBe("to-guest");
    const chiaro = await apri(s.link.key, (ultima as { payload: string }).payload);
    expect(JSON.parse(chiaro!)).toEqual({ status: 200, body: { id: "t1" } });
  });
});
