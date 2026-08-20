/**
 * La sonda che si accorge se sulla nostra porta risponde qualcun altro.
 *
 * Il guasto vero, e il motivo per cui questo file esiste, sta nel commento di
 * `port-squatter.ts`. Qui si prova la DECISIONE — «chi risponde è Topics?» — che
 * è l'unica parte governabile in un test: la rete vera, i pid veri e `lsof` non
 * lo sono, e un test che provasse a simularli proverebbe la simulazione.
 */
import { describe, it, expect } from "bun:test";
import {
  sondaPorta,
  rispostaNostra,
  messaggioEsito,
  ROTTA_SONDA,
  type SondaPortaDeps,
} from "./port-squatter";

/** La forma che `computePresenceCounts` restituisce davvero. */
// Copiata dalla risposta VERA di `/api/system/presence`, non ricordata: la
// prima versione di questo test usava `{working: 0}` e passava mentre il
// codice accusava Topics stesso.
const NOSTRA = JSON.stringify({ openSessions: 19, workingSessions: 3, activeTasks: 0, focusProject: "topics-app" });

function deps(over: Partial<SondaPortaDeps> = {}): SondaPortaDeps {
  return {
    chiedi: over.chiedi ?? (async () => ({ ok: true, corpo: NOSTRA })),
    chiOccupa: over.chiOccupa ?? (() => null),
    pidNostro: over.pidNostro ?? 999,
  };
}

describe("chi risponde sulla nostra porta", () => {
  it("riconosce la nostra risposta e tace", async () => {
    const e = await sondaPorta(3333, deps());
    expect(e).toEqual({ stato: "nostro" });
    expect(messaggioEsito(3333, e)).toBeNull();
  });

  it("IL CASO VERO: risponde 200 ma con l'HTML di un altro progetto", async () => {
    // È esattamente ciò che faceva darkroom sulla 3333: `ok: true`, quindi ogni
    // controllo basato sul codice di stato lo avrebbe dichiarato sano. La forma
    // del corpo è l'unica cosa che distingue.
    const e = await sondaPorta(3333, deps({
      chiedi: async () => ({ ok: true, corpo: "<!doctype html><html lang=\"it\">" }),
      chiOccupa: () => ({ pid: 79571, comando: "bun --hot run server/index.ts" }),
    }));
    expect(e).toEqual({ stato: "estraneo", pid: 79571, comando: "bun --hot run server/index.ts" });
    const msg = messaggioEsito(3333, e)!;
    expect(msg).toContain("79571");
    expect(msg).toContain("bun --hot run server/index.ts");
  });

  it("nessuno che risponde NON è un allarme", async () => {
    // In dev con un bind IPv6-only e nessun client IPv4 questa è la normalità.
    // Chiamarla «estraneo» produrrebbe un avviso a ogni avvio, e un avviso che
    // c'è sempre non informa più di uno che non c'è mai.
    const e = await sondaPorta(3333, deps({ chiedi: async () => null }));
    expect(e).toEqual({ stato: "silenzio" });
    expect(messaggioEsito(3333, e)).toBeNull();
  });

  it("non accusa NOI STESSI quando il pid trovato è il nostro", async () => {
    // Se rispondiamo noi con un corpo che non riconosciamo, è un difetto nostro.
    // Dirlo «estraneo» manderebbe a cercare un processo che non esiste.
    const e = await sondaPorta(3333, deps({
      chiedi: async () => ({ ok: true, corpo: "qualcosa di inatteso" }),
      chiOccupa: () => ({ pid: 999, comando: "bun run server.ts" }),
      pidNostro: 999,
    }));
    expect(e.stato).toBe("ignoto");
  });

  it("un estraneo NON identificabile viene comunque denunciato", async () => {
    // `lsof` può mancare o non avere permessi. Sapere che qualcuno c'è, senza
    // sapere chi, resta molto più utile del silenzio.
    const e = await sondaPorta(3333, deps({
      chiedi: async () => ({ ok: true, corpo: "non nostro" }),
      chiOccupa: () => null,
    }));
    expect(e).toEqual({ stato: "estraneo", pid: null, comando: null });
    expect(messaggioEsito(3333, e)).toContain("non sono riuscito a identificare");
  });

  it("una sonda che ESPLODE non diventa un allarme", async () => {
    // Un errore di rete non è un'invasione: confonderli significa insegnare a
    // ignorare l'avviso.
    const e = await sondaPorta(3333, deps({
      chiedi: async () => { throw new Error("ECONNRESET"); },
    }));
    expect(e).toEqual({ stato: "ignoto", perche: "ECONNRESET" });
    expect(messaggioEsito(3333, e)).toContain("ECONNRESET");
  });

  it("interroga la rotta più economica su 127.0.0.1, provando HTTPS per primo", async () => {
    // L'indirizzo NON è un dettaglio: è quello che un bind IPv4 altrui
    // intercetta, ed è quello che il guscio e il client usano davvero.
    // E lo SCHEMA nemmeno: in produzione Topics parla TLS, quindi una sonda
    // solo-HTTP riceve `null` da sé stessa e conclude «silenzio» — cioè tace
    // proprio sulla porta che deve sorvegliare. Verificato contro la 3333 viva.
    const visti: string[] = [];
    await sondaPorta(3333, deps({ chiedi: async (u) => { visti.push(u); return { ok: true, corpo: NOSTRA }; } }));
    expect(visti).toEqual([`https://127.0.0.1:3333${ROTTA_SONDA}`]);
  });

  it("se HTTPS non risponde ripiega su HTTP, invece di dire «silenzio»", async () => {
    // Il server in chiaro (dev, sidecar) esiste, e per lui la prima connessione
    // cade: il ripiego è ciò che rende la sonda utile in entrambe le forme.
    const visti: string[] = [];
    const e = await sondaPorta(3333, deps({
      chiedi: async (u) => {
        visti.push(u);
        return u.startsWith("https") ? null : { ok: true, corpo: NOSTRA };
      },
    }));
    expect(visti.map((u) => u.split(":")[0])).toEqual(["https", "http"]);
    expect(e).toEqual({ stato: "nostro" });
  });

  it("la forma conta, non il codice: JSON di un altro server non passa", () => {
    expect(rispostaNostra(NOSTRA)).toBe(true);
    expect(rispostaNostra('{"status":"ok"}')).toBe(false);
    expect(rispostaNostra('{"openSessions":"tre","workingSessions":1}')).toBe(false); // tipo sbagliato
    // UN campo solo non basta: potrebbe capitare per caso altrove.
    expect(rispostaNostra('{"openSessions":19}')).toBe(false);
    expect(rispostaNostra("")).toBe(false);
  });
});
