/**
 * @covers TRAY-01
 */
import { describe, expect, test } from "bun:test";
import {
  trayAgentStates,
  type TrayGroup,
  trayBoardGroups,
  trayLitGroups,
  trayLitReason,
  trayTitle,
} from "./tray-board";

const t = (id: string, status: string, text = `task ${id}`, projectId = "p") =>
  ({ id, status, text, projectId }) as never;

describe("trayBoardGroups", () => {
  test("l'ordine è quello dell'URGENZA, non quello delle colonne né l'alfabetico", () => {
    const g = trayBoardGroups([t("a", "todo"), t("b", "review"), t("c", "in_progress")]);
    expect(g.map((x) => x.status)).toEqual(["review", "in_progress", "todo"]);
  });

  test("review counts only what waits on a person: the CI column is not in the menu", () => {
    const g = trayBoardGroups([
      { id: "ci", status: "review", stage: "ci", text: "ci", projectId: "p" },
      { id: "hr", status: "review", text: "hr", projectId: "p" },
      { id: "rv", status: "review", text: "plain", projectId: "p" },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.count).toBe(2);
    expect(g[0]!.rows.map((r) => r.id)).toEqual(["hr", "rv"]);
  });

  test("un gruppo vuoto NON esce: «Review (0)» si legge come un difetto", () => {
    const g = trayBoardGroups([t("a", "todo")]);
    expect(g.map((x) => x.status)).toEqual(["todo"]);
  });

  test("il conteggio è di TUTTI, le righe sono solo le prime", () => {
    const molti = Array.from({ length: 9 }, (_, i) => t(`r${i}`, "review"));
    const [g] = trayBoardGroups(molti, { rowsPerGroup: 3 });
    expect(g!.count).toBe(9);      // il numero dice la verità…
    expect(g!.rows).toHaveLength(3); // …anche se il menu non le mostra tutte
  });

  test("ogni riga porta il progetto: due card omonime su board diverse capitano", () => {
    const g = trayBoardGroups([t("a", "review", "Deploy", "alpha"), t("b", "review", "Deploy", "beta")]);
    expect(g[0]!.rows.map((r) => r.projectId)).toEqual(["alpha", "beta"]);
  });

});

describe("lit cards: the menu lists what the number counts", () => {
  const lit = (id: string, reason: "review" | "parked" | "question", projectId = "p") => ({ id, title: `card ${id}`, projectId, reason });

  test("grouped by why, in a fixed order, empty groups left out", () => {
    const g = trayLitGroups([lit("q", "question"), lit("r", "review")]);
    expect(g.map((x) => x.status)).toEqual(["review", "question"]);
  });

  test("a permission or a plan is a question; review and parked stay themselves", () => {
    expect(["review", "parked", "permission", "plan", "question", null].map(trayLitReason))
      .toEqual(["review", "parked", "question", "question", "question", "question"]);
  });
});

describe("trayTitle", () => {
  test("un titolo corto resta intero", () => {
    expect(trayTitle("Riparare il chip")).toBe("Riparare il chip");
  });

  test("un titolo lungo si taglia su uno SPAZIO, non a metà parola", () => {
    const intero = "Riparare il chip dell'effort che mostra il numero sbagliato da tre giorni";
    const s = trayTitle(intero, 30);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(30);
    // La proprietà vera: ciò che resta è un prefisso dell'originale e finisce
    // dove finisce una parola. «finisce con una lettera» non dice niente — una
    // parola intera finisce con una lettera anche lei.
    const tenuto = s.slice(0, -1);
    expect(intero.startsWith(tenuto)).toBe(true);
    expect(intero[tenuto.length]).toBe(" ");
  });

  test("una parola sola lunghissima si spezza: meglio tagliata che sparita", () => {
    const s = trayTitle("Supercalifragilistichespiralidoso", 12);
    expect(s).toBe("Supercalifr…");
  });

  test("gli a capo e gli spazi doppi diventano uno spazio: una riga di menu è una riga", () => {
    expect(trayTitle("prima\n\nseconda   terza")).toBe("prima seconda terza");
  });
});

describe("trayAgentStates", () => {
  test("counts each state from its own source", () => {
    const groups: TrayGroup[] = [
      { status: "review", count: 3, rows: [] },
      { status: "question", count: 2, rows: [] },
      { status: "parked", count: 1, rows: [] },
    ];
    expect(trayAgentStates(groups, { working: 5, needsYou: 4, error: 2 })).toEqual({
      working: 5,
      review: 3,
      waiting: 6,
      stopped: 3,
    });
  });
});
