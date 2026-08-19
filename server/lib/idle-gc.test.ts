/**
 * Il cancello del gc di riposo: prova la DECISIONE, non la memoria.
 *
 * La memoria vera non è governabile in un test — non si può ordinare a macOS di
 * swappare, né garantire che il collettore renda N megabyte. Ciò che invece
 * DEVE valere sempre è la regola: mai fermare l'event loop mentre qualcuno
 * lavora, e mai pagarne il costo quando non c'è niente da rendere.
 *
 * La prova che `Bun.gc(true)` restituisce davvero le pagine swappate sta nel
 * commento di `idle-gc.ts`, con i numeri e le condizioni: è una misura di
 * sistema, e appartiene lì, non a un test che la ripeterebbe male.
 */
import { describe, it, expect } from "bun:test";
import { giroIdleGc, IDLE_GC_SOGLIA_MB, type IdleGcDeps } from "./idle-gc";

const fermo = { cards: 0, streamKeys: [], brokerOpenKeys: [] };

function deps(over: Partial<IdleGcDeps> & { raccolte?: { n: number } } = {}): IdleGcDeps {
  const conteggio = over.raccolte ?? { n: 0 };
  return {
    sorgenti: over.sorgenti ?? (() => fermo),
    footprintMB: over.footprintMB ?? (() => 900),
    raccogli: over.raccogli ?? (() => { conteggio.n++; }),
    log: over.log,
  };
}

describe("gc di riposo", () => {
  it("raccoglie quando il server è fermo e il footprint è alto", async () => {
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte }));
    expect(esito.azione).toBe("raccolto");
    expect(raccolte.n).toBe(1);
  });

  it("NON ferma l'event loop mentre una card della board lavora", async () => {
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, sorgenti: () => ({ ...fermo, cards: 1 }) }));
    expect(esito.azione).toBe("saltato");
    // Questa è l'asserzione che conta: il collettore non è stato chiamato.
    // Una pausa sincrona qui è una pausa per ogni richiesta in coda, e su
    // HTTP/1.1 anche per le letture che disegnano lo schermo.
    expect(raccolte.n).toBe(0);
  });

  it("raccoglie ANCHE mentre una chat streamma — la pausa misurata è 1-15 ms", async () => {
    // La versione prudente di questo cancello bloccava anche qui, e sulla
    // macchina dell'utente `activeStreams` non è quasi mai vuoto: il gc non
    // sarebbe partito una sola volta in dieci minuti. Un rimedio che non parte
    // mai equivale a non averlo scritto.
    //
    // Il prezzo è misurato, non temuto: 1-15 ms per giro, caso peggiore 8 ms su
    // una heap di 18.845 oggetti vivi. Meno di un frame, contro centinaia di
    // megabyte che non tornerebbero in nessun altro modo.
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, sorgenti: () => ({ ...fermo, streamKeys: ["topic:abc"] }) }));
    expect(esito.azione).toBe("raccolto");
    expect(raccolte.n).toBe(1);
  });

  it("NON raccoglie per un turno che vive solo nel broker", async () => {
    // È la fonte che vede un turno ADOTTATO dopo un riavvio: in-processo non ha
    // nessun'altra rappresentazione, ed è esattamente il caso che aveva
    // ingannato il cancello del riavvio (vedi quiescence.ts). Resta bloccante
    // insieme alle card: là c'è un agente che scrive file e nessuno che guardi
    // lo schermo al posto suo.
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, sorgenti: () => ({ ...fermo, brokerOpenKeys: ["topic:xyz"] }) }));
    expect(esito.azione).toBe("saltato");
    expect(raccolte.n).toBe(0);
  });

  it("non paga la pausa quando non c'è niente da rendere", async () => {
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, footprintMB: () => IDLE_GC_SOGLIA_MB - 1 }));
    expect(esito.azione).toBe("saltato");
    expect(raccolte.n).toBe(0);
  });

  it("raccoglie esattamente alla soglia (il confine è incluso)", async () => {
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, footprintMB: () => IDLE_GC_SOGLIA_MB }));
    expect(esito.azione).toBe("raccolto");
    expect(raccolte.n).toBe(1);
  });

  it("un footprint illeggibile fa saltare il giro invece di raccogliere alla cieca", async () => {
    const raccolte = { n: 0 };
    const esito = await giroIdleGc(deps({ raccolte, footprintMB: () => null }));
    expect(esito.azione).toBe("saltato");
    expect(raccolte.n).toBe(0);
  });

  it("logga solo un recupero visibile, non una riga ogni cinque minuti", async () => {
    const righe: string[] = [];
    let n = 0;
    // 900 → 899: un solo MB. Vero, e non vale una riga di log.
    await giroIdleGc(deps({ footprintMB: () => (n++ === 0 ? 900 : 899), log: (m) => righe.push(m) }));
    expect(righe).toHaveLength(0);

    let m = 0;
    await giroIdleGc(deps({ footprintMB: () => (m++ === 0 ? 900 : 120), log: (x) => righe.push(x) }));
    expect(righe).toHaveLength(1);
    expect(righe[0]).toContain("780 MB");
  });
});
