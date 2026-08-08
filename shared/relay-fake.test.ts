/**
 * Il giro completo attraverso un relay, senza rete e senza Cloudflare.
 *
 * Quello che si prova qui non è il finto: è il PROTOCOLLO. Se un giorno il
 * Worker vero cominciasse a guardare dentro le buste, o a dipendere da un
 * ordine che il protocollo non garantisce, questi casi resterebbero verdi e
 * quello si romperebbe — ed è esattamente il segnale che serve per sapere che
 * il trasporto è ancora sostituibile.
 */
import { describe, expect, it } from "bun:test";
import { creaCapoTubo, creaRelayFinto } from "./relay-fake";
import { involucro, type EsitoTubo, type MessaggioRelay } from "./relay-protocol";

/** Un capo che tiene traccia di cosa gli è arrivato. */
function capo() {
  const ricevuti: MessaggioRelay[] = [];
  return { ricevuti, invia: (m: MessaggioRelay) => { ricevuti.push(m); } };
}

function scenaCollegata() {
  const relay = creaRelayFinto();
  const mac = capo();
  const host = relay.collegaMacchina(mac.invia);
  host.ricevi({ t: "hello", v: 1, installationId: "i1", token: "tok" });

  const tel = capo();
  const guest = relay.collegaOspite(tel.invia);
  guest.ricevi({ t: "guest-open", v: 1, installationId: "i1", shareRef: "r1" });

  return { relay, mac, host, tel, guest };
}

describe("relay finto · il giro completo", () => {
  it("la macchina si registra e l'ospite si collega", () => {
    const { mac, tel } = scenaCollegata();
    expect(mac.ricevuti[0]).toEqual({ t: "ready", v: 1 });
    expect(tel.ricevuti[0]).toMatchObject({ t: "ready", v: 1 });
    // La macchina viene avvisata: deve sapere che c'è qualcuno, o manderebbe
    // buste a nessuno.
    expect(mac.ricevuti[1]).toMatchObject({ t: "guest-joined" });
  });

  it("una busta arriva dall'ospite alla macchina, e ritorno", () => {
    const { mac, tel, guest, host } = scenaCollegata();
    const sid = (tel.ricevuti[0] as { sessionId: string }).sessionId;

    guest.ricevi({ t: "to-host", payload: "CIFRATO-A" });
    expect(mac.ricevuti.at(-1)).toEqual({ t: "to-guest", to: sid, payload: "CIFRATO-A" });

    host.ricevi({ t: "to-guest", to: sid, payload: "CIFRATO-B" });
    expect(tel.ricevuti.at(-1)).toEqual({ t: "to-guest", to: sid, payload: "CIFRATO-B" });
  });

  it("il relay NON ha visto i contenuti", () => {
    // La prova che regge la promessa commerciale. Il relay registra cosa è
    // passato, e in quel registro i payload non ci sono.
    const { relay, guest, host, tel } = scenaCollegata();
    const sid = (tel.ricevuti[0] as { sessionId: string }).sessionId;
    guest.ricevi({ t: "to-host", payload: "SEGRETO-DELL-OSPITE" });
    host.ricevi({ t: "to-guest", to: sid, payload: "SEGRETO-DELLA-MACCHINA" });

    const registro = JSON.stringify(relay.visto);
    expect(registro).not.toContain("SEGRETO-DELL-OSPITE");
    expect(registro).not.toContain("SEGRETO-DELLA-MACCHINA");
    expect(relay.visto.length).toBeGreaterThan(0);
  });
});

describe("relay finto · la macchina spenta", () => {
  it("chi arriva quando non c'è nessuno riceve `host-offline`", () => {
    const relay = creaRelayFinto();
    const tel = capo();
    relay.collegaOspite(tel.invia).ricevi({ t: "guest-open", v: 1, installationId: "i1", shareRef: "r1" });
    // Un motivo suo, non un errore generico: all'ospite va detto che la
    // macchina è spenta, non lasciato davanti a una pagina vuota che si legge
    // come «non ti hanno condiviso niente».
    expect(tel.ricevuti[0]).toEqual({ t: "denied", motivo: "host-offline" });
  });

  it("se la macchina se ne va, gli ospiti collegati lo sanno", () => {
    const { host, tel } = scenaCollegata();
    host.scollega();
    expect(tel.ricevuti.at(-1)).toEqual({ t: "denied", motivo: "host-offline" });
  });

  it("e se se ne va l'ospite, lo sa la macchina", () => {
    const { mac, guest } = scenaCollegata();
    guest.scollega();
    expect(mac.ricevuti.at(-1)).toMatchObject({ t: "guest-left" });
  });
});

describe("relay finto · non ci si spaccia per altri", () => {
  it("un ospite non può scegliersi la sessione da cui dice di venire", () => {
    // È il relay ad attaccare `to` alla busta. Se lo facesse l'ospite,
    // potrebbe attribuirsi la sessione di un altro.
    const { mac, guest, tel } = scenaCollegata();
    const sid = (tel.ricevuti[0] as { sessionId: string }).sessionId;
    guest.ricevi({ t: "to-host", payload: "x" });
    expect((mac.ricevuti.at(-1) as { to: string }).to).toBe(sid);
  });

  it("una macchina non può mandare a un ospite di un'ALTRA installazione", () => {
    const relay = creaRelayFinto();
    const macA = capo(); const hostA = relay.collegaMacchina(macA.invia);
    hostA.ricevi({ t: "hello", v: 1, installationId: "A", token: "t" });
    const macB = capo(); const hostB = relay.collegaMacchina(macB.invia);
    hostB.ricevi({ t: "hello", v: 1, installationId: "B", token: "t" });

    const telA = capo(); const guestA = relay.collegaOspite(telA.invia);
    guestA.ricevi({ t: "guest-open", v: 1, installationId: "A", shareRef: "r" });
    const sidA = (telA.ricevuti[0] as { sessionId: string }).sessionId;

    const prima = telA.ricevuti.length;
    hostB.ricevi({ t: "to-guest", to: sidA, payload: "NON-TUO" });
    expect(telA.ricevuti.length).toBe(prima);
  });

  it("un token sbagliato non registra l'installazione", () => {
    const relay = creaRelayFinto({ tokenValidi: { i1: "giusto" } });
    const mac = capo();
    relay.collegaMacchina(mac.invia).ricevi({ t: "hello", v: 1, installationId: "i1", token: "sbagliato" });
    expect(mac.ricevuti[0]).toEqual({ t: "denied", motivo: "bad-token" });
    expect(relay.macchineCollegate()).toBe(0);
  });

  it("un riferimento scaduto non apre niente", () => {
    // Il link È la credenziale: se scade, smette di aprire.
    const relay = creaRelayFinto({ shareRefValidi: new Set(["buono"]) });
    const mac = capo();
    relay.collegaMacchina(mac.invia).ricevi({ t: "hello", v: 1, installationId: "i1", token: "t" });
    const tel = capo();
    relay.collegaOspite(tel.invia).ricevi({ t: "guest-open", v: 1, installationId: "i1", shareRef: "scaduto" });
    expect(tel.ricevuti[0]).toEqual({ t: "denied", motivo: "expired" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// IL TUBO SOPRA IL RELAY
// ───────────────────────────────────────────────────────────────────────────

/**
 * Una macchina e un ospite collegati, che parlano il TUBO attraverso il relay.
 *
 * Il relay resta quello di sempre e non impara niente: le buste interne
 * viaggiano dentro `payload`, che per lui è una stringa sola.
 */
function scenaTubo(max?: number) {
  const relay = creaRelayFinto();
  /** Ogni busta ESTERNA consegnata da un capo all'altro. Serve a dimostrare
   *  cosa ha potuto vedere chi instrada. */
  const esterne: MessaggioRelay[] = [];
  const allaMacchina: EsitoTubo[] = [];
  const allOspite: EsitoTubo[] = [];

  const host = relay.collegaMacchina((m) => {
    esterne.push(m);
    if (m.t === "to-guest") allaMacchina.push(tuboHost.ricevi(m.payload));
  });
  host.ricevi({ t: "hello", v: 1, installationId: "i1", token: "tok" });

  let sid = "";
  const guest = relay.collegaOspite((m) => {
    esterne.push(m);
    if (m.t === "ready" && m.sessionId) sid = m.sessionId;
    if (m.t === "to-guest") allOspite.push(tuboGuest.ricevi(m.payload));
  });
  guest.ricevi({ t: "guest-open", v: 1, installationId: "i1", shareRef: "r1" });

  const tuboHost = creaCapoTubo({
    lato: "host",
    ...(max !== undefined ? { max } : {}),
    invia: (p) => host.ricevi({ t: "to-guest", to: sid, payload: p }),
  });
  const tuboGuest = creaCapoTubo({
    lato: "guest",
    ...(max !== undefined ? { max } : {}),
    invia: (p) => guest.ricevi({ t: "to-host", payload: p }),
  });

  return { relay, esterne, allaMacchina, allOspite, tuboHost, tuboGuest, guest, sid: () => sid };
}

const finiti = (e: EsitoTubo[]) => e.filter((x) => x.esito === "completo");

describe("tubo sul relay · il giro completo", () => {
  it("una richiesta va e la risposta torna, sulla stessa sessione", () => {
    const s = scenaTubo();
    const chiesto = s.tuboGuest.manda("req", '{"path":"/api/topics"}', "GET");
    expect(finiti(s.allaMacchina)).toMatchObject([{ k: "req", h: "GET", dati: '{"path":"/api/topics"}' }]);

    s.tuboHost.manda("res", '[{"id":1}]', String(chiesto));
    expect(finiti(s.allOspite)).toMatchObject([{ k: "res", h: String(chiesto), dati: '[{"id":1}]' }]);
  });

  it("CINQUE stream vivono insieme su una sessione sola, e non si mescolano", () => {
    // È il difetto che questo strato ripara: prima una sessione era uno stream,
    // quindi la richiesta lunga metteva in coda tutte le altre.
    const s = scenaTubo();
    const numeri = [1, 2, 3, 4, 5].map((i) => s.tuboGuest.manda("req", `corpo-${i}`, `h-${i}`));
    expect(new Set(numeri).size).toBe(5);

    const arrivati = finiti(s.allaMacchina);
    expect(arrivati.length).toBe(5);
    expect(arrivati.map((e) => (e.esito === "completo" ? `${e.h}=${e.dati}` : ""))).toEqual([
      "h-1=corpo-1", "h-2=corpo-2", "h-3=corpo-3", "h-4=corpo-4", "h-5=corpo-5",
    ]);
  });

  it("due stream INTRECCIATI sul filo si rimettono insieme lo stesso", () => {
    // Non è teoria: due risposte lunghe che scorrono insieme è il caso normale.
    const s = scenaTubo();
    const coda: string[] = [];
    const rinviato = creaCapoTubo({ lato: "guest", max: 8, invia: (p) => coda.push(p) });
    const a = rinviato.manda("req", "AAAAAAAAAAAAAAAAAAAAAAAA", "A");
    const meta = coda.length;
    const b = rinviato.manda("req", "BBBBBBBBBBBBBBBBBBBBBBBB", "B");
    expect(a).not.toBe(b);
    expect(meta).toBeGreaterThan(1); // davvero spezzati, o l'intreccio non esiste

    // Uno di qua e uno di là, alternati.
    const primi = coda.slice(0, meta);
    const secondi = coda.slice(meta);
    for (let i = 0; i < Math.max(primi.length, secondi.length); i++) {
      if (primi[i]) s.guest.ricevi({ t: "to-host", payload: primi[i]! });
      if (secondi[i]) s.guest.ricevi({ t: "to-host", payload: secondi[i]! });
    }

    const arrivati = finiti(s.allaMacchina);
    expect(arrivati.map((e) => (e.esito === "completo" ? `${e.h}=${e.dati}` : ""))).toEqual([
      "A=AAAAAAAAAAAAAAAAAAAAAAAA", "B=BBBBBBBBBBBBBBBBBBBBBBBB",
    ]);
    expect(s.allaMacchina.some((e) => e.esito === "errore")).toBe(false);
  });

  it("un blob più grosso di un frame passa spezzato e arriva identico", () => {
    // I binari il Durable Object li scarta, quindi i byte vanno in base64 dentro
    // JSON — e nessun frame deve avvicinarsi al tetto di 32 MiB.
    const s = scenaTubo(64);
    const b = new Uint8Array(1500);
    for (let i = 0; i < b.length; i++) b[i] = (i * 13) & 0xff;
    s.tuboGuest.manda("blob", b);

    const buste = s.esterne.filter((m) => m.t === "to-guest");
    expect(buste.length).toBeGreaterThan(20); // davvero spezzato
    expect(Math.max(...buste.map((m) => (m.t === "to-guest" ? m.payload.length : 0)))).toBeLessThan(512);

    const fine = finiti(s.allaMacchina);
    expect(fine.length).toBe(1);
    const dati = fine[0]!.esito === "completo" && fine[0]!.e === "b" ? fine[0]!.dati : new Uint8Array();
    expect(Array.from(dati)).toEqual(Array.from(b));
  });
});

describe("tubo sul relay · il relay continua a non capire", () => {
  it("nel registro del relay non c'è traccia di stream né di contenuti", () => {
    const s = scenaTubo(32);
    s.tuboGuest.manda("req", "CONTENUTO-RISERVATO", "intestazione-riservata");
    s.tuboHost.manda("res", "RISPOSTA-RISERVATA");

    // Controllo POSITIVO, per primo: il canale di osservazione funziona, cioè
    // il relay HA visto passare le buste e i dati SONO arrivati. Senza questo,
    // le negazioni qui sotto passerebbero anche se non fosse successo niente.
    expect(s.relay.visto.some((v) => v.t === "to-host")).toBe(true);
    expect(s.relay.visto.some((v) => v.t === "to-guest")).toBe(true);
    expect(finiti(s.allaMacchina).length).toBe(1);
    expect(finiti(s.allOspite).length).toBe(1);

    const registro = JSON.stringify(s.relay.visto);
    // Le sigle del TUBO, non le parole dell'involucro: `guest-open` contiene
    // «open» ed è roba del relay, quindi si cerca `"f":"open"` — il frame.
    for (const parola of [
      "CONTENUTO-RISERVATO", "RISPOSTA-RISERVATA", "intestazione-riservata",
      '"f":"open"', '"f":"data"', '"s":', '"payload"',
    ]) {
      expect(`${parola}→${registro.includes(parola)}`).toBe(`${parola}→false`);
    }
  });

  it("l'involucro delle buste passate non nomina nessuno stream", () => {
    // `involucro()` è la dichiarazione di cosa il relay può leggere. Se un
    // domani lo `streamId` salisse lì «tanto serve per il log», questo cade.
    const s = scenaTubo(32);
    s.tuboGuest.manda("req", "x".repeat(200), "h-riservata");
    const buste = s.esterne.filter((m) => m.t === "to-guest" || m.t === "to-host");
    expect(buste.length).toBeGreaterThan(5);

    for (const m of buste) {
      const visibile = JSON.stringify(involucro(m));
      expect(`${m.t}/payload→${visibile.includes("payload")}`).toBe(`${m.t}/payload→false`);
      expect(`${m.t}/h-riservata→${visibile.includes("h-riservata")}`).toBe(`${m.t}/h-riservata→false`);
      expect(`${m.t}/open→${visibile.includes("open")}`).toBe(`${m.t}/open→false`);
    }
    // Controllo positivo: l'involucro contiene comunque ciò che serve a
    // consegnare, altrimenti sopra si starebbe misurando una stringa vuota.
    expect(involucro(buste[0]!)).toEqual({ t: "to-guest", to: s.sid() });
  });
});

describe("tubo sul relay · un capo storto non porta giù gli altri", () => {
  it("un payload che non è un frame è un errore di UNO stream", () => {
    const s = scenaTubo();
    s.guest.ricevi({ t: "to-host", payload: "{non-un-frame" });
    expect(s.allaMacchina.at(-1)).toMatchObject({ esito: "errore", motivo: "bad-frame" });
    // E dopo, il tubo funziona ancora: uno storto non avvelena il canale.
    s.tuboGuest.manda("req", "dopo");
    expect(finiti(s.allaMacchina)).toMatchObject([{ dati: "dopo" }]);
  });

  it("chi rinuncia lo dice, e l'altro capo lo sa", () => {
    const s = scenaTubo(16);
    const n = s.tuboGuest.manda("req", "x".repeat(100));
    expect(finiti(s.allaMacchina).length).toBe(1);
    s.tuboGuest.annulla(n);
    expect(s.allaMacchina.at(-1)).toEqual({ esito: "chiuso", s: n, motivo: "aborted" });
  });
});

describe("relay finto · un messaggio malformato non fa danni", () => {
  it("si nega e si resta in piedi", () => {
    const relay = creaRelayFinto();
    const mac = capo();
    const host = relay.collegaMacchina(mac.invia);
    host.ricevi({ t: "esegui", payload: "rm -rf /" });
    expect(mac.ricevuti[0]).toEqual({ t: "denied", motivo: "bad-version" });
    // E dopo il rifiuto la registrazione funziona ancora: un messaggio storto
    // non deve avvelenare il canale.
    host.ricevi({ t: "hello", v: 1, installationId: "i1", token: "t" });
    expect(relay.macchineCollegate()).toBe(1);
  });
});
