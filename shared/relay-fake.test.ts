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
import { creaRelayFinto } from "./relay-fake";
import type { MessaggioRelay } from "./relay-protocol";

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
