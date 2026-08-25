/**
 * @covers KANBAN-14
 */
import { test, expect, describe } from "bun:test";
import {
  ATTEMPT_STATES,
  attemptHasWork,
  formatAttemptStat,
  formatFanoutComment,
  type AttemptState,
  type TaskAttempt,
} from "./task-attempt";

function attempt(over: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    id: "a1",
    taskId: "t1",
    idx: 1,
    topicId: "topic-1",
    worktreeId: "wt-1",
    branch: "task/x-1",
    model: null,
    state: "delivered",
    commit: "abc1234",
    filesChanged: 3,
    insertions: 120,
    deletions: 8,
    summary: null,
    error: null,
    agentMs: 1000,
    agentTokens: 5000,
    createdAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:05:00.000Z",
    selectedAt: null,
    ...over,
  };
}

describe("attemptHasWork", () => {
  test("serve un commit E almeno un file: un commit vuoto non è lavoro", () => {
    expect(attemptHasWork(attempt())).toBe(true);
    expect(attemptHasWork(attempt({ commit: null }))).toBe(false);
    expect(attemptHasWork(attempt({ filesChanged: 0 }))).toBe(false);
    expect(attemptHasWork(attempt({ filesChanged: null }))).toBe(false);
  });
});

describe("formatAttemptStat", () => {
  test("un tentativo vivo non ha numeri da mostrare, ha uno stato", () => {
    expect(formatAttemptStat(attempt({ state: "running", commit: null, filesChanged: null }))).toBe("in corso…");
  });

  test("il diffstat quando c'è lavoro (\"file\" resta invariante al plurale)", () => {
    expect(formatAttemptStat(attempt())).toBe("3 file · +120 −8");
    expect(formatAttemptStat(attempt({ filesChanged: 1, insertions: 2, deletions: 0 }))).toBe("1 file · +2 −0");
  });

  test("niente lavoro: il perché se c'è, altrimenti il fatto nudo", () => {
    expect(formatAttemptStat(attempt({ commit: null, state: "failed", error: "timeout" }))).toBe(
      "nessuna modifica (timeout)",
    );
    expect(formatAttemptStat(attempt({ commit: null, filesChanged: null }))).toBe("nessuna modifica");
  });
});

describe("formatFanoutComment", () => {
  test("intestazione: quanti tentativi, quanti con modifiche, e cosa deve fare l'umano", () => {
    const md = formatFanoutComment([
      attempt({ id: "a1", idx: 1, summary: "Fatto col gate sul server" }),
      attempt({ id: "a2", idx: 2, filesChanged: 1, insertions: 5, deletions: 1, branch: "task/x-2" }),
      attempt({ id: "a3", idx: 3, state: "failed", commit: null, filesChanged: null, error: "crash" }),
    ]);
    expect(md).toContain("Fan-out chiuso: 3 tentativi, 2 con modifiche.");
    expect(md).toContain("Scegli quale tenere");
    expect(md).toContain("**Tentativo 1** · 3 file · +120 −8 · `task/x-1`");
    expect(md).toContain("**Tentativo 2** · 1 file · +5 −1 · `task/x-2`");
    expect(md).toContain("> Fatto col gate sul server");
    expect(md).toContain("> _fallito: crash_");
  });

  test("ordina per idx anche se arrivano in ordine di completamento", () => {
    const md = formatFanoutComment([attempt({ id: "c", idx: 3 }), attempt({ id: "a", idx: 1 }), attempt({ id: "b", idx: 2 })]);
    const order = [...md.matchAll(/\*\*Tentativo (\d)\*\*/g)].map((m) => m[1]);
    expect(order).toEqual(["1", "2", "3"]);
  });

  test("quando nessuno ha prodotto niente lo dice, invece di invitare a scegliere il nulla", () => {
    const md = formatFanoutComment([
      attempt({ idx: 1, commit: null, filesChanged: null, state: "failed", error: "timeout" }),
      attempt({ idx: 2, commit: null, filesChanged: 0, state: "delivered" }),
    ]);
    expect(md).toContain("**nessuno ha prodotto modifiche**");
    expect(md).not.toContain("Scegli quale tenere");
  });

  test("nessun punteggio, nessun \"consigliato\": la scelta di merito resta umana", () => {
    const md = formatFanoutComment([
      attempt({ idx: 1, filesChanged: 40, insertions: 900, deletions: 200 }),
      attempt({ idx: 2, filesChanged: 1, insertions: 3, deletions: 1 }),
    ]);
    expect(md).not.toMatch(/consigliat|migliore|vincitore|punteggio|score/i);
    // Il più piccolo NON viene promosso in cima: l'ordine resta quello di lancio.
    expect(md.indexOf("**Tentativo 1**")).toBeLessThan(md.indexOf("**Tentativo 2**"));
  });

  test("un summary multiriga resta tutto dentro la citazione", () => {
    const md = formatFanoutComment([attempt({ summary: "Prima riga\nSeconda riga" })]);
    expect(md).toContain("> Prima riga\n> Seconda riga");
  });

  test("il summary vince sull'errore: se l'agente ha parlato, si legge lui", () => {
    const md = formatFanoutComment([attempt({ state: "failed", commit: null, error: "exit 1", summary: "Ho provato X" })]);
    expect(md).toContain("> Ho provato X");
    expect(md).not.toContain("_fallito:");
  });
});

test("gli stati sono cinque e il tipo li segue", () => {
  const all: AttemptState[] = [...ATTEMPT_STATES];
  expect(all).toEqual(["running", "delivered", "failed", "selected", "discarded"]);
});
