/**
 * La macchina che serve un ospite arrivato dal relay.
 *
 * Il caso che conta: **un link è una capacità su UNA cosa**, non un accesso. Se
 * servisse più di quella, il fatto che i link girino nelle chat smetterebbe di
 * essere accettabile.
 *
 * @covers GUEST-08
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

/**
 * ── ATTACHED IS NOT "THE THREAD IS OPEN" ────────────────────────────────────
 *
 * On 2026-08-21 remote access stayed down for minutes while the log announced
 * a healthy relay connection on every line. The thread to Cloudflare was alive
 * (`readyState === 1`), but the Durable Object on the far side had been
 * recreated and that thread belonged to nobody: every request from the phone
 * got `host-offline`, and this side could not notice, because `onclose` never
 * arrives for a thread nobody closes.
 *
 * The confirmation was already in the protocol, the `ready` the relay sends
 * right after attaching, and nobody was looking at it.
 */
class FakeSocketRelay {
  static aperte: FakeSocketRelay[] = [];
  readyState = 1;
  inviati: string[] = [];
  chiusa = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocketRelay.aperte.push(this); }
  send(d: string): void { this.inviati.push(d); }
  close(): void { this.chiusa = true; this.readyState = 3; this.onclose?.(); }
  /** The meeting point takes us in. */
  confermaReady(): void { this.onmessage?.({ data: JSON.stringify({ t: "ready", v: 1 }) }); }
}

function connectedClient() {
  FakeSocketRelay.aperte = [];
  const righe: string[] = [];
  const c = creaRelayClient({
    baseUrl: "https://relay.esempio.test", relayId: "i1", segreto: SEGRETO_FINTO,
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 200, body: {} }),
    segnaApertura: () => {},
    now: () => ORA,
    log: (m: string) => { righe.push(m); },
    apriSocket: (() => new FakeSocketRelay()) as never,
  });
  return { c, righe };
}

describe("relay client · «collegato» vuol dire che il relay ci ha PRESI IN CARICO", () => {
  it("un filo aperto ma non confermato NON conta come collegato", () => {
    const { c, righe } = connectedClient();
    c.avvia();
    const s = FakeSocketRelay.aperte[0]!;
    s.onopen?.();
    // The thread is open, and that is not enough: it is exactly the state in
    // which the log lied while the phone was getting `host-offline`.
    expect(c.collegato()).toBe(false);
    expect(righe.some((r) => r.includes("collegato"))).toBe(false);
    c.ferma();
  });

  it("…e con la conferma sì, e solo allora lo si annuncia", () => {
    const { c, righe } = connectedClient();
    c.avvia();
    const s = FakeSocketRelay.aperte[0]!;
    s.onopen?.();
    s.confermaReady();
    expect(c.collegato()).toBe(true);
    expect(righe.filter((r) => r.includes("collegato"))).toHaveLength(1);
    c.ferma();
  });

  it("senza conferma il filo si CHIUDE, invece di restare a sembrare sano", async () => {
    // THE case: the thread stays open towards a meeting point that no longer
    // knows us. If nobody closes it, `onclose` never arrives and the
    // reconnection never starts, so remote access stays down until someone
    // restarts the server by hand.
    //
    // The real timer is ten seconds, and this test does not sleep on it: time
    // is moved instead of awaited.
    const realSetTimeout = globalThis.setTimeout;
    const armati: Array<() => void> = [];
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      // Only the CONFIRMATION wait is captured: everything else (the retry,
      // and anyone else's timers) must keep behaving as usual.
      if (ms === 10_000) { armati.push(fn); return { unref() {} }; }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;

    try {
      const { c } = connectedClient();
      c.avvia();
      const s = FakeSocketRelay.aperte[0]!;
      s.onopen?.();
      expect(s.chiusa).toBe(false);
      expect(armati).toHaveLength(1);

      // Ten seconds later, with no `ready` having arrived.
      armati[0]!();
      expect(s.chiusa).toBe(true);
      expect(c.collegato()).toBe(false);
      c.ferma();
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  });

  it("…e un filo CONFERMATO non viene chiuso da quell'attesa", async () => {
    // The other direction, and without it "always close after ten seconds"
    // would pass the test above and take the relay down every ten seconds.
    const realSetTimeout = globalThis.setTimeout;
    const armati: Array<() => void> = [];
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 10_000) { armati.push(fn); return { unref() {} }; }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;

    try {
      const { c } = connectedClient();
      c.avvia();
      const s = FakeSocketRelay.aperte[0]!;
      s.onopen?.();
      s.confermaReady();
      armati[0]!();
      expect(s.chiusa).toBe(false);
      expect(c.collegato()).toBe(true);
      c.ferma();
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  });

  it("la chiusura tardiva di un filo sostituito non spegne quello corrente", () => {
    const { c } = connectedClient();
    c.avvia();
    const oldSocket = FakeSocketRelay.aperte[0]!;
    oldSocket.onopen?.();
    oldSocket.confermaReady();

    c.avvia();
    const currentSocket = FakeSocketRelay.aperte[1]!;
    currentSocket.onopen?.();
    oldSocket.confermaReady();
    expect(c.collegato()).toBe(false);
    currentSocket.confermaReady();
    expect(c.collegato()).toBe(true);

    oldSocket.onopen?.();
    expect(c.collegato()).toBe(true);

    // The event still belongs to the first socket, even if it arrives after
    // the second socket completed its handshake.
    oldSocket.onclose?.();
    expect(c.collegato()).toBe(true);
    expect(currentSocket.chiusa).toBe(false);
    c.ferma();
  });
});

/**
 * ── THE THREAD THAT STAYS OPEN TOWARDS NOBODY ───────────────────────────────
 *
 * Measured on 2026-09-13: the relay is deployed at 13:52 and ten probes out of
 * ten come back "this installation is not connected", while on the machine the
 * client keeps saying `connected: true`. The Durable Object had been replaced,
 * and the socket that used to reach it never got a close: `onclose` cannot
 * start a reconnection nobody triggers.
 *
 * A mute socket is the shape of that failure, and it is the only shape a test
 * of this has: nothing closes, nothing errors, nothing answers.
 */
class MuteSocketRelay extends FakeSocketRelay {
  /** From here on the far side stops answering, without closing anything. */
  muto = false;
  rispondiAlPing(): void {
    if (this.muto) return;
    const ping = this.inviati.filter((r) => r.includes('"ping"')).length;
    if (ping > this.eco) { this.eco += 1; this.onmessage?.({ data: JSON.stringify({ t: "pong" }) }); }
  }
  private eco = 0;
}

/** Fires the captured one-second timers in order: time is moved, not awaited. */
function beat(coda: Array<() => void>, quanti: number): void {
  for (let i = 0; i < quanti; i += 1) {
    const fn = coda.shift();
    if (!fn) throw new Error("nessun timer armato");
    fn();
  }
}

describe("relay client · un filo che non risponde piu' non e' un filo", () => {
  function withFakeTimers(corpo: (coda: Array<() => void>) => void): void {
    const realSetTimeout = globalThis.setTimeout;
    const coda: Array<() => void> = [];
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      // The beat and the first retry both measure one second: both are moved
      // by hand here, in the order they were armed.
      if (ms === 1_000) { coda.push(fn); return { unref() {} }; }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    try { corpo(coda); } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  }

  it("dopo la scadenza chiude, si ricollega, e «collegato» torna vero solo con la conferma", () => {
    withFakeTimers((coda) => {
      FakeSocketRelay.aperte = [];
      const c = creaRelayClient({
        baseUrl: "https://relay.esempio.test", relayId: "i1", segreto: SEGRETO_FINTO,
        trovaLink: () => null,
        serviRisorsa: async () => ({ status: 200, body: {} }),
        segnaApertura: () => {},
        now: () => ORA,
        log: () => {},
        apriSocket: (() => new MuteSocketRelay()) as never,
      });
      c.avvia();
      const s = FakeSocketRelay.aperte[0] as MuteSocketRelay;
      s.onopen?.();
      s.confermaReady();

      // First round trip: the far side proves it knows how to answer.
      beat(coda, 20);
      s.rispondiAlPing();
      expect(s.inviati.filter((r) => r.includes('"ping"'))).toHaveLength(1);
      expect(s.chiusa).toBe(false);

      // Now the meeting point is replaced and stops answering, without ever
      // closing the socket. The question goes out and nothing comes back.
      s.muto = true;
      beat(coda, 20);
      expect(s.inviati.filter((r) => r.includes('"ping"'))).toHaveLength(2);

      // Nine beats of silence are still silence, not a verdict.
      beat(coda, 9);
      expect(s.chiusa).toBe(false);
      beat(coda, 1);
      expect(s.chiusa).toBe(true);
      expect(c.collegato()).toBe(false);

      // The close restarts the loop with the backoff already in use.
      beat(coda, 1);
      const replacement = FakeSocketRelay.aperte[1] as MuteSocketRelay;
      expect(replacement).toBeDefined();
      replacement.onopen?.();
      // Open is not attached: only the confirmation says so.
      expect(c.collegato()).toBe(false);
      replacement.confermaReady();
      expect(c.collegato()).toBe(true);
      c.ferma();
    });
  });

  it("un punto d'incontro che non ha MAI risposto non viene buttato giu'", () => {
    // The relay is deployed separately from the machine: a version that does
    // not know the heartbeat must not be torn down every thirty seconds by a
    // client that does.
    withFakeTimers((coda) => {
      FakeSocketRelay.aperte = [];
      const c = creaRelayClient({
        baseUrl: "https://relay.esempio.test", relayId: "i1", segreto: SEGRETO_FINTO,
        trovaLink: () => null,
        serviRisorsa: async () => ({ status: 200, body: {} }),
        segnaApertura: () => {},
        now: () => ORA,
        log: () => {},
        apriSocket: (() => new MuteSocketRelay()) as never,
      });
      c.avvia();
      const s = FakeSocketRelay.aperte[0] as MuteSocketRelay;
      s.onopen?.();
      s.confermaReady();
      s.muto = true;
      beat(coda, 30);
      expect(s.chiusa).toBe(false);
      expect(c.collegato()).toBe(true);
      expect(coda).toHaveLength(0); // the beat gave up instead of insisting
      c.ferma();
    });
  });
});
