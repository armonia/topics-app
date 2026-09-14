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

      // First round trip: the question gets its answer and the thread stays.
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

  it("un relay che al battito risponde `denied bad-version` non viene buttato giu', e resta sorvegliato", () => {
    // Every relay deployed before the heartbeat answers a `ping` it does not
    // know with `denied bad-version` and keeps the thread open. That is the
    // relay in production on the day this client lands: it must neither be
    // torn down every thirty seconds nor be left unwatched.
    withVirtualClock((clock) => {
      const { c, sockets } = clientOn(() => "denied", clock);
      c.avvia();
      clock.advance(300_000);

      expect(sockets()).toHaveLength(1);
      const s = sockets()[0]!;
      expect(s.chiusa).toBe(false);
      expect(c.collegato()).toBe(true);
      // One question every twenty beats, all three hundred of them.
      expect(s.pings()).toBe(15);
      // Still watched: the beat is armed, and it is what closes the thread
      // the moment this relay goes quiet (next test).
      expect(clock.pending()).toBe(1);
      c.ferma();
    });
  });

  it("…e se poi tace senza chiudere, come al deploy del 13/09, il filo si chiude entro la scadenza e si rifa'", () => {
    // The deploy that introduces the heartbeat: the old relay has been
    // answering `denied`, then the Durable Object is replaced and the thread
    // stays open towards nobody. Nothing closes, nothing errors.
    withVirtualClock((clock) => {
      const { c, sockets, lines } = clientOn((n) => (n === 0 ? "denied" : "pong"), clock);
      c.avvia();
      clock.advance(60_000);
      const first = sockets()[0]!;
      expect(first.pings()).toBe(3);

      first.answer = "mute";
      const mutedAt = clock.now();
      clock.advance(29_999);
      expect(first.chiusa).toBe(false);
      clock.advance(1);
      expect(first.chiusa).toBe(true);
      // At most one question interval plus the deadline: 20 + 10 beats.
      expect(first.closedAt! - mutedAt).toBeLessThanOrEqual(30_000);
      expect(lines).toContain("[relay] battito senza risposta: rifaccio il filo");
      expect(c.collegato()).toBe(false);

      // The denied answers were answers: the backoff starts again from one second.
      clock.advance(1_000);
      expect(sockets()).toHaveLength(2);
      expect(sockets()[1]!.openedAt - first.closedAt!).toBe(1_000);
      expect(c.collegato()).toBe(true);
      c.ferma();
    });
  });

  it("il backoff cresce su fili che si aprono, confermano e poi tacciono, e riparte solo da una risposta al battito", () => {
    // A thread that opens and confirms has not proved anything yet: a replaced
    // meeting point does both and then goes silent. Resetting the backoff on
    // `onopen` or on `ready` pins the wait at one second and turns a dead relay
    // into a reconnection loop that throws away every guest session each time.
    withVirtualClock((clock) => {
      const { c, sockets } = clientOn((n) => (n < 5 ? "mute" : "pong"), clock);
      c.avvia();
      // Five silent threads (30 s each) and the waits between them, then a
      // healthy sixth that answers two questions.
      clock.advance(30_000 * 5 + (1_000 + 2_000 + 5_000 + 15_000 + 60_000) + 45_000);

      const all = sockets();
      expect(all).toHaveLength(6);
      const waits = all.slice(1).map((s, i) => s.openedAt - all[i]!.closedAt!);
      expect(waits).toEqual([1_000, 2_000, 5_000, 15_000, 60_000]);

      const healthy = all[5]!;
      expect(healthy.closedAt).toBeNull();
      expect(healthy.pings()).toBe(2);

      // The far side drops a thread that had answered: the next one is tried
      // after the shortest wait again.
      healthy.dropByRelay();
      clock.advance(1_000);
      expect(sockets()).toHaveLength(7);
      expect(sockets()[6]!.openedAt - healthy.closedAt!).toBe(1_000);
      c.ferma();
    });
  });
});

/**
 * A clock that moves only when told to.
 *
 * The heartbeat tests above move one kind of one-second timer by hand. These
 * need the ORDER of several different waits (the beat, the confirmation, the
 * backoff), so every timer armed while the clock is installed goes through
 * here, and `clearTimeout` really clears it.
 */
interface VirtualClock {
  now(): number;
  /** Timers armed and not yet fired or cleared. */
  pending(): number;
  /** Fires, in order, every timer due within `ms`. */
  advance(ms: number): void;
}

function withVirtualClock(body: (clock: VirtualClock) => void): void {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0) => {
    nextId += 1;
    timers.set(nextId, { at: now + ms, fn });
    return { id: nextId, unref() {} };
  };
  (globalThis as { clearTimeout: unknown }).clearTimeout = (handle: unknown) => {
    if (handle && typeof handle === "object" && "id" in handle) timers.delete((handle as { id: number }).id);
  };
  const clock: VirtualClock = {
    now: () => now,
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        // Earliest first; on a tie the one armed first, which is Map order.
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
  try { body(clock); } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
  }
}

/**
 * How a relay really answers the beat.
 *  - `pong`: a relay with the heartbeat.
 *  - `denied`: every relay deployed before it, which answers a message it does
 *    not know with `denied bad-version` and keeps the thread open.
 *  - `mute`: a thread left open towards nobody, the 2026-09-13 deploy.
 */
type BeatAnswer = "pong" | "denied" | "mute";

/** A relay thread that opens and confirms on its own, and answers the beat as
 *  the relay version it plays. */
class ScriptedRelaySocket extends FakeSocketRelay {
  readonly openedAt: number;
  closedAt: number | null = null;
  constructor(public answer: BeatAnswer, private readonly clockNow: () => number) {
    super();
    this.openedAt = clockNow();
    // Deferred: the client assigns the handlers after the socket is built.
    setTimeout(() => { this.onopen?.(); this.confermaReady(); }, 0);
  }
  pings(): number {
    return this.inviati.filter((r) => (JSON.parse(r) as { t?: string }).t === "ping").length;
  }
  override send(d: string): void {
    super.send(d);
    if ((JSON.parse(d) as { t?: string }).t !== "ping" || this.answer === "mute") return;
    const reply = this.answer === "pong" ? { t: "pong" } : { t: "denied", motivo: "bad-version" };
    this.onmessage?.({ data: JSON.stringify(reply) });
  }
  override close(): void {
    this.closedAt ??= this.clockNow();
    super.close();
  }
  /** The far side closes the thread: the client did not ask for it. */
  dropByRelay(): void {
    this.closedAt ??= this.clockNow();
    this.readyState = 3;
    this.onclose?.();
  }
}

/** A client whose `n`-th thread plays `answerFor(n)`. */
function clientOn(answerFor: (n: number) => BeatAnswer, clock: VirtualClock) {
  FakeSocketRelay.aperte = [];
  const lines: string[] = [];
  let opened = 0;
  const c = creaRelayClient({
    baseUrl: "https://relay.esempio.test", relayId: "i1", segreto: SEGRETO_FINTO,
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 200, body: {} }),
    segnaApertura: () => {},
    now: () => ORA,
    log: (m: string) => { lines.push(m); },
    apriSocket: (() => new ScriptedRelaySocket(answerFor(opened++), clock.now)) as never,
  });
  return { c, lines, sockets: () => FakeSocketRelay.aperte as ScriptedRelaySocket[] };
}
