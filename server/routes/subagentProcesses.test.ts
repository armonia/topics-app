/**
 * Il pannello dei sotto-agenti dice il vero su chi sta girando.
 *
 * Prima di questo file `GET /api/processes` — l'unica vista che Topics ha sui
 * sotto-agenti COME PROCESSI — non era nominata da nessun test, e la sua
 * logica era un'espressione sola dentro la rotta. Nessuno poteva provarla:
 * la rotta risolve il provider dal registro globale, quindi esercitare la
 * mappatura voleva dire montare un provider finto.
 *
 * Le tre cose che qui non possono piu' rompersi in silenzio, ognuna col modo
 * in cui si vedrebbe a schermo se si rompesse:
 *
 *  1. il filtro tiene SOLO i sotto-agenti. Allargarlo riempie il pannello di
 *     ogni sessione che il provider conosce, presentate come «sotto la tua
 *     chat» quando non lo sono.
 *  2. `active` e' l'unico stato che vuol dire in corso. Uno stato sconosciuto
 *     trattato come attivo lascia una rotella che gira per sempre.
 *  3. `completedAt` esiste solo per chi ha finito. Su un processo vivo non e'
 *     una sbavatura: e' il pannello che dice che una cosa e' anche finita.
 */
import { describe, expect, test } from "bun:test";
import { processiSubagente, type SessionePerProcessi } from "./subagentProcesses";

const ADESSO = "2026-08-25T02:00:00.000Z";
const adesso = () => ADESSO;

const sessione = (p: Partial<SessionePerProcessi>): SessionePerProcessi => ({
  sessionKey: "topic:abc:subagent:uno",
  status: "active",
  createdAt: "2026-08-25T01:00:00.000Z",
  ...p,
});

describe("quali sessioni finiscono nel pannello", () => {
  test("solo quelle che sono sotto-agenti", () => {
    const fuori = processiSubagente(
      [
        sessione({ sessionKey: "topic:abc:subagent:esplora" }),
        sessione({ sessionKey: "topic:abc" }),
        sessione({ sessionKey: "terminal:xyz" }),
        sessione({ sessionKey: "topic:def:subagent:verifica" }),
      ],
      adesso,
    );
    expect(fuori.map((p) => p.sessionKey)).toEqual([
      "topic:abc:subagent:esplora",
      "topic:def:subagent:verifica",
    ]);
  });

  test("una sessione senza chiave non entra e non fa esplodere niente", () => {
    // Il ramo che il `?.` della rotta gia' proteggeva, e che nessuno provava:
    // un elenco che arriva da un provider puo' avere una voce monca.
    expect(processiSubagente([{ status: "active" }, sessione({})], adesso)).toHaveLength(1);
  });

  test("un elenco vuoto e' un pannello vuoto, non un errore", () => {
    expect(processiSubagente([], adesso)).toEqual([]);
  });
});

describe("in corso oppure finito", () => {
  test("`active` e' in corso, e non porta un'ora di fine", () => {
    const [p] = processiSubagente([sessione({ status: "active" })], adesso);
    expect(p!.status).toBe("running");
    expect(p!.completedAt, "un processo vivo dichiara anche di essere finito").toBeUndefined();
  });

  test("qualunque altro stato e' finito, e l'ora di fine c'e'", () => {
    for (const stato of ["done", "exited", "failed", "unknown", "", null]) {
      const [p] = processiSubagente(
        [sessione({ status: stato, updatedAt: "2026-08-25T01:30:00.000Z" })],
        adesso,
      );
      expect(p!.status, `stato ${JSON.stringify(stato)}`).toBe("done");
      expect(p!.completedAt, `stato ${JSON.stringify(stato)}`).toBe("2026-08-25T01:30:00.000Z");
    }
  });

  test("uno stato sconosciuto NON lascia la rotella che gira", () => {
    // La stessa cosa dell'asserzione sopra, detta dal verso che conta: e' il
    // ramo permissivo quello che fa danno, perche' non produce nessun segnale.
    const [p] = processiSubagente([sessione({ status: "qualcosa-di-nuovo" })], adesso);
    expect(p!.status).toBe("done");
  });
});

describe("come si chiama e quando e' partito", () => {
  test("l'etichetta e' l'ultimo segmento della chiave quando manca", () => {
    const [p] = processiSubagente([sessione({ sessionKey: "topic:abc:subagent:esplora", label: null })], adesso);
    expect(p!.label, "in un pannello stretto la chiave intera non si legge").toBe("esplora");
  });

  test("un'etichetta vera vince sul ripiego", () => {
    const [p] = processiSubagente([sessione({ label: "Ricerca sui competitor" })], adesso);
    expect(p!.label).toBe("Ricerca sui competitor");
  });

  test("senza data di partenza si usa adesso, non una stringa vuota", () => {
    const [p] = processiSubagente([sessione({ createdAt: null })], adesso);
    expect(p!.startedAt).toBe(ADESSO);
  });

  test("un processo finito senza data di fine prende adesso", () => {
    const [p] = processiSubagente([sessione({ status: "done", updatedAt: null })], adesso);
    expect(p!.completedAt).toBe(ADESSO);
  });
});
