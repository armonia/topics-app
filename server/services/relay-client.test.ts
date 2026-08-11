/**
 * La macchina che serve un ospite arrivato dal relay.
 *
 * Il caso che conta: **un link è una capacità su UNA cosa**, non un accesso. Se
 * servisse più di quella, il fatto che i link girino nelle chat smetterebbe di
 * essere accettabile.
 */
import { describe, expect, it } from "bun:test";
import { creaRelayClient, type LinkCondivisione } from "./relay-client";
import { nuovaChiave, sigilla, apri } from "../../shared/relay-crypto";
import { SEGRETO_FINTO } from "../../shared/relay-fake";

const ORA = 1_000_000;

function link(over: Partial<LinkCondivisione> = {}): LinkCondivisione {
  return {
    ref: "r1", key: nuovaChiave(), resourceType: "task", resourceId: "t1",
    expiresAt: ORA + 60_000, revokedAt: null, ...over,
  };
}

function client(l: LinkCondivisione | null, opts: { serve?: unknown } = {}) {
  const aperture: string[] = [];
  const c = creaRelayClient({
    baseUrl: null, relayId: "i1", segreto: SEGRETO_FINTO,
    trovaLink: (ref) => (l && ref === l.ref ? l : null),
    serviRisorsa: async (x) => ({ status: 200, body: opts.serve ?? { id: x.resourceId, testo: "la scheda" } }),
    segnaApertura: (ref) => { aperture.push(ref); },
    now: () => ORA,
  });
  return { c, aperture };
}

const chiedi = (k: string) => sigilla(k, JSON.stringify({ t: "fetch" }));

describe("relay client · un link buono serve la sua cosa", () => {
  it("apre, serve, e segna l'apertura", async () => {
    const l = link();
    const { c, aperture } = client(l);
    const e = await c.__servi("r1", await chiedi(l.key));
    expect(e?.risposta).toEqual({ status: 200, body: { id: "t1", testo: "la scheda" } });
    // Non è statistica: è l'unico modo per accorgersi che un link è finito
    // dove non doveva.
    expect(aperture).toEqual(["r1"]);
  });

  it("la risposta si richiude con la stessa chiave", async () => {
    const l = link();
    const { c } = client(l);
    const e = await c.__servi("r1", await chiedi(l.key));
    const busta = await sigilla(e!.chiave, JSON.stringify(e!.risposta));
    expect(JSON.parse((await apri(l.key, busta))!)).toEqual({ status: 200, body: { id: "t1", testo: "la scheda" } });
  });
});

describe("relay client · ogni modo di fallire dà lo STESSO nulla", () => {
  // Distinguerli racconterebbe a chi prova quale dei quattro gli è capitato, e
  // «questo riferimento esiste ma è scaduto» è un'informazione che non si deve
  // poter comprare tirando a indovinare.

  it("un riferimento che non esiste", async () => {
    const { c } = client(link());
    expect(await c.__servi("inventato", await chiedi(nuovaChiave()))).toBeNull();
  });

  it("un link SCADUTO", async () => {
    const l = link({ expiresAt: ORA - 1 });
    const { c, aperture } = client(l);
    expect(await c.__servi("r1", await chiedi(l.key))).toBeNull();
    // E non si segna un'apertura che non è avvenuta.
    expect(aperture).toEqual([]);
  });

  it("un link REVOCATO, anche se non è scaduto", async () => {
    const l = link({ revokedAt: ORA - 10 });
    const { c } = client(l);
    expect(await c.__servi("r1", await chiedi(l.key))).toBeNull();
  });

  it("una busta cifrata con la chiave sbagliata", async () => {
    const l = link();
    const { c } = client(l);
    expect(await c.__servi("r1", await chiedi(nuovaChiave()))).toBeNull();
  });

  it("una busta manomessa", async () => {
    const l = link();
    const { c } = client(l);
    const b = await chiedi(l.key);
    const parti = b.split(".");
    expect(await c.__servi("r1", `${parti[0]}.${parti[1]}.${parti[2].slice(0, -4)}AAAA`)).toBeNull();
  });

  it("una richiesta che chiede qualcosa che il protocollo non prevede", async () => {
    // Un capo che accetta ciò che quasi capisce è un capo che un giorno
    // accetta ciò che non capisce affatto.
    const l = link();
    const { c } = client(l);
    const b = await sigilla(l.key, JSON.stringify({ t: "esegui", cmd: "rm -rf /" }));
    expect(await c.__servi("r1", b)).toBeNull();
  });

  it("una busta che non è nemmeno JSON dentro", async () => {
    const l = link();
    const { c } = client(l);
    expect(await c.__servi("r1", await sigilla(l.key, "non json"))).toBeNull();
  });
});

describe("relay client · il link vale per UNA cosa", () => {
  it("serve la risorsa del LINK, non quella che chiede l'ospite", async () => {
    // La richiesta non porta un id, ed è deliberato: se lo portasse, chi ha un
    // link potrebbe provare a chiederne un altro. La capacità è la riga, non
    // ciò che si domanda.
    const l = link({ resourceId: "solo-questo" });
    let servita = "";
    const c = creaRelayClient({
      baseUrl: null, relayId: "i1", segreto: SEGRETO_FINTO,
      trovaLink: () => l,
      serviRisorsa: async (x) => { servita = x.resourceId; return { status: 200, body: {} }; },
      segnaApertura: () => {},
      now: () => ORA,
    });
    await c.__servi("r1", await chiedi(l.key));
    expect(servita).toBe("solo-questo");
  });
});

describe("relay client · spento non toglie niente", () => {
  it("senza `baseUrl` non si collega e non esplode", () => {
    const { c } = client(link());
    c.avvia();
    expect(c.collegato()).toBe(false);
    c.ferma();
  });
});
