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
import { subagentProcesses, type SessionForProcesses } from "./subagentProcesses";

const NOW_ISO = "2026-08-25T02:00:00.000Z";
const now = () => NOW_ISO;

const session = (p: Partial<SessionForProcesses>): SessionForProcesses => ({
  sessionKey: "topic:abc:subagent:uno",
  status: "active",
  createdAt: "2026-08-25T01:00:00.000Z",
  ...p,
});

describe("quali sessioni finiscono nel pannello", () => {
  test("solo quelle che sono sotto-agenti", () => {
    const kept = subagentProcesses(
      [
        session({ sessionKey: "topic:abc:subagent:esplora" }),
        session({ sessionKey: "topic:abc" }),
        session({ sessionKey: "terminal:xyz" }),
        session({ sessionKey: "topic:def:subagent:verifica" }),
      ],
      now,
    );
    expect(kept.map((p) => p.sessionKey)).toEqual([
      "topic:abc:subagent:esplora",
      "topic:def:subagent:verifica",
    ]);
  });

  test("una sessione senza chiave non entra e non fa esplodere niente", () => {
    // The branch the route's `?.` already protected, and nobody exercised:
    // a list arriving from a provider can carry a truncated entry.
    expect(subagentProcesses([{ status: "active" }, session({})], now)).toHaveLength(1);
  });

  test("un elenco vuoto e' un pannello vuoto, non un errore", () => {
    expect(subagentProcesses([], now)).toEqual([]);
  });
});

describe("in corso oppure finito", () => {
  test("`active` e' in corso, e non porta un'ora di fine", () => {
    const [p] = subagentProcesses([session({ status: "active" })], now);
    expect(p!.status).toBe("running");
    expect(p!.completedAt, "un processo vivo dichiara anche di essere finito").toBeUndefined();
  });

  test("qualunque altro stato e' finito, e l'ora di fine c'e'", () => {
    for (const status of ["done", "exited", "failed", "unknown", "", null]) {
      const [p] = subagentProcesses(
        [session({ status, updatedAt: "2026-08-25T01:30:00.000Z" })],
        now,
      );
      expect(p!.status, `stato ${JSON.stringify(status)}`).toBe("done");
      expect(p!.completedAt, `stato ${JSON.stringify(status)}`).toBe("2026-08-25T01:30:00.000Z");
    }
  });

  test("uno stato sconosciuto NON lascia la rotella che gira", () => {
    // The same thing as the assertion above, said from the side that counts:
    // the permissive branch is the one that does damage, because it produces
    // no signal at all.
    const [p] = subagentProcesses([session({ status: "qualcosa-di-nuovo" })], now);
    expect(p!.status).toBe("done");
  });
});

describe("come si chiama e quando e' partito", () => {
  test("l'etichetta e' l'ultimo segmento della chiave quando manca", () => {
    const [p] = subagentProcesses([session({ sessionKey: "topic:abc:subagent:esplora", label: null })], now);
    expect(p!.label, "in un pannello stretto la chiave intera non si legge").toBe("esplora");
  });

  test("un'etichetta vera vince sul ripiego", () => {
    const [p] = subagentProcesses([session({ label: "Ricerca sui competitor" })], now);
    expect(p!.label).toBe("Ricerca sui competitor");
  });

  test("senza data di partenza si usa adesso, non una stringa vuota", () => {
    const [p] = subagentProcesses([session({ createdAt: null })], now);
    expect(p!.startedAt).toBe(NOW_ISO);
  });

  test("un processo finito senza data di fine prende adesso", () => {
    const [p] = subagentProcesses([session({ status: "done", updatedAt: null })], now);
    expect(p!.completedAt).toBe(NOW_ISO);
  });
});
