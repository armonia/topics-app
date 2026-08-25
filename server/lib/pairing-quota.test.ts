/**
 * Il caso che questo file esiste per fissare è uno solo, e va detto per intero:
 * **chi inonda la coda non deve poter impedire a te di far entrare qualcuno.**
 *
 * Col tetto complessivo applicato come rifiuto, sette indirizzi con tre
 * richieste a testa saturavano tutto e il proprietario col telefono in mano
 * restava fuori. Non fa entrare nessuno — impedisce a te di far entrare — ed è
 * il modo peggiore in cui un limite può rompersi, perché somiglia a un guasto.
 *
 * @covers PAIRING-02
 */
import { describe, expect, it } from "bun:test";
import {
  valutaQuota, sceltoPerSfratto, MAX_PENDING_PER_IP, MAX_PENDING_TOTAL,
  type PendingLike,
} from "./pairing-quota";

const coda = (righe: Array<[string, string | null, number]>): PendingLike[] =>
  righe.map(([id, ip, createdAt]) => ({ id, ip, createdAt }));

/** N richieste dallo stesso indirizzo, con tempi crescenti. */
function inonda(ip: string, n: number, da = 0): PendingLike[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${ip}#${i}`, ip, createdAt: da + i }));
}

describe("quota · il limite su CHI chiede", () => {
  it("al tetto la quarta ENTRA, e a uscire è la mia più vecchia", () => {
    // This used to be a refusal, and that is the defect that broke the
    // product: behind the relay "this address" is the household uplink, not a
    // device. Three requests for the whole home, and the OWNER's fourth
    // attempt got a 429, with the phone reading "I can't reach Topics" in
    // front of a computer that was on.
    const c = inonda("10.0.0.9", MAX_PENDING_PER_IP);
    expect(valutaQuota(c, "10.0.0.9")).toEqual({ ok: true, sfratta: "10.0.0.9#0" });
  });

  it("il tetto però continua a valere: la coda di un indirizzo non cresce", () => {
    // Evicting is not raising the limit. At most MAX_PENDING_PER_IP requests
    // stay live per address: every new one removes one of its own.
    let c = inonda("10.0.0.9", MAX_PENDING_PER_IP);
    for (let i = 0; i < 5; i++) {
      const esito = valutaQuota(c, "10.0.0.9");
      expect(esito.ok).toBe(true);
      const vittima = esito.ok ? esito.sfratta : null;
      expect(vittima).not.toBeNull();
      c = c.filter((p) => p.id !== vittima);
      c.push({ id: `nuova#${i}`, ip: "10.0.0.9", createdAt: 1000 + i });
      expect(c.filter((p) => p.ip === "10.0.0.9").length).toBe(MAX_PENDING_PER_IP);
    }
  });

  it("chi arriva al tetto non tocca le richieste di un ALTRO indirizzo", () => {
    // The per-address eviction only looks at its own, otherwise the cap would
    // become a way to make someone else's request disappear.
    const c = [...inonda("10.0.0.9", MAX_PENDING_PER_IP), ...coda([["tua", "10.0.0.10", 0]])];
    const esito = valutaQuota(c, "10.0.0.9");
    expect(esito.ok && esito.sfratta).toBe("10.0.0.9#0");
  });

  it("un altro indirizzo non è toccato dal limite del primo", () => {
    const c = inonda("10.0.0.9", MAX_PENDING_PER_IP);
    expect(valutaQuota(c, "10.0.0.10")).toEqual({ ok: true, sfratta: null });
  });

  it("chi non ha indirizzo noto non consuma la quota di un altro ignoto", () => {
    // Sommarli darebbe a uno sconosciuto il potere di chiudere fuori un altro
    // sconosciuto — cioè di chiudere fuori chiunque non sappiamo identificare.
    const c = coda([["a", null, 1], ["b", null, 2], ["c", null, 3], ["d", null, 4]]);
    expect(valutaQuota(c, null)).toEqual({ ok: true, sfratta: null });
  });
});

describe("quota · a coda piena si SFRATTA, non si rifiuta", () => {
  it("chi bussa una volta sola entra anche se la coda è piena", () => {
    // IL caso. Prima: rifiutato. Ora: entra, e a uscire è chi ne ha di più.
    const inondatore = inonda("6.6.6.6", MAX_PENDING_TOTAL, 1000);
    const esito = valutaQuota(inondatore, "192.168.1.7");
    expect(esito.ok).toBe(true);
    expect(esito.ok && esito.sfratta).toBe("6.6.6.6#0");
  });

  it("a uscire è la più VECCHIA di chi ne ha di più", () => {
    const c = [
      ...inonda("6.6.6.6", 5, 100),      // il più ingombrante
      ...coda([["mia", "192.168.1.7", 1]]), // la più vecchia in assoluto, ma sola
    ];
    // Non basta essere vecchia: conta stare nella riga più lunga. Altrimenti
    // l'inondatore riuscirebbe comunque a far sfrattare la richiesta legittima.
    expect(sceltoPerSfratto(c)).toBe("6.6.6.6#0");
  });

  it("a parità di numero esce la più vecchia in assoluto", () => {
    const c = [...inonda("a", 2, 500), ...inonda("b", 2, 100)];
    expect(sceltoPerSfratto(c)).toBe("b#0");
  });

  it("una richiesta legittima non viene sfrattata finché esiste un gruppo più lungo", () => {
    const c = [...inonda("6.6.6.6", 3, 900), ...coda([["mia", "192.168.1.7", 1]])];
    // Due sfratti: finché l'inondatore ne ha più di me, paga lui.
    for (let i = 0; i < 2; i++) {
      const vittima = sceltoPerSfratto(c);
      expect(vittima).not.toBe("mia");
      c.splice(c.findIndex((p) => p.id === vittima), 1);
    }
    // E qui il confine, dichiarato invece che scoperto dopo: quando siamo pari
    // — uno a testa — non esiste più un segnale che distingua l'inondatore da
    // chiunque altro, e a parità esce la più vecchia, che è la mia.
    //
    // È IL LIMITE ACCETTATO di questo disegno: tanti indirizzi con UNA richiesta
    // ciascuno non sono distinguibili da tanti utenti veri. Contro quello serve
    // un altro strumento (il bordo che filtra), non una politica di coda — e
    // intanto chi inonda da pochi indirizzi, che è il caso reale, non passa.
    expect(sceltoPerSfratto(c)).toBe("mia");
  });

  it("su una coda vuota non c'è niente da sfrattare", () => {
    expect(sceltoPerSfratto([])).toBeNull();
  });
});

describe("quota · il tetto complessivo non è più un modo per dire no", () => {
  it("sotto il tetto non si sfratta niente", () => {
    expect(valutaQuota(inonda("x", 10), "y")).toEqual({ ok: true, sfratta: null });
  });

  it("il tetto è alto abbastanza da non scattare per uso normale", () => {
    // Prima era 20, cioè sette indirizzi. Ora è un limite di memoria, non una
    // politica: serve solo perché la coda non cresca senza fine.
    expect(MAX_PENDING_TOTAL).toBeGreaterThanOrEqual(200);
  });

  it("il limite per indirizzo invece resta basso: è un limite su di TE", () => {
    expect(MAX_PENDING_PER_IP).toBeLessThanOrEqual(3);
  });
});
