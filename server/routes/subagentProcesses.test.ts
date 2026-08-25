/**
 * The sub-agent panel tells the truth about what is running.
 *
 * Before this file `GET /api/processes` - the only view Topics has of
 * sub-agents AS PROCESSES - was named by no test, and its logic was a single
 * expression inside the route. Nobody could exercise it: the route resolves
 * its provider from the global registry, so exercising the mapping meant
 * standing up a fake provider.
 *
 * The three things that can no longer break quietly here, each with the way it
 * would show up on screen if it did break:
 *
 *  1. the filter keeps ONLY the sub-agents. Widening it fills the panel with
 *     every session the provider knows, presented as "under your chat" when
 *     they are not.
 *  2. `active` is the only status that means running. An unknown status
 *     treated as active leaves a spinner turning forever.
 *  3. `completedAt` exists only for what has finished. On a live process it is
 *     not a smudge: it is the panel saying a thing has also ended.
 * @covers SUBAGENT-03
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
    // The branch the route's `?.` already protected, and nobody exercised:
    // a list arriving from a provider can carry a truncated entry.
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
    // The same thing as the assertion above, said from the side that counts:
    // the permissive branch is the one that does damage, because it produces
    // no signal at all.
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
