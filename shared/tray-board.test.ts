import { describe, expect, test } from "bun:test";
import {
  TRAY_GROUP_ORDER,
  TRAY_HIDDEN_STATUSES,
  trayBoardAttention,
  trayBoardGroups,
  trayTitle,
} from "./tray-board";

const t = (id: string, status: string, text = `task ${id}`, projectId = "p") =>
  ({ id, status, text, projectId }) as never;

describe("trayBoardGroups", () => {
  test("l'ordine è quello dell'URGENZA, non quello delle colonne né l'alfabetico", () => {
    const g = trayBoardGroups([t("a", "todo"), t("b", "review"), t("c", "in_progress")]);
    expect(g.map((x) => x.status)).toEqual(["review", "in_progress", "todo"]);
  });

  test("un gruppo vuoto NON esce: «Review (0)» si legge come un difetto", () => {
    const g = trayBoardGroups([t("a", "todo")]);
    expect(g.map((x) => x.status)).toEqual(["todo"]);
  });

  test("backlog e done non entrano nella tray, ed è dichiarato", () => {
    const g = trayBoardGroups([t("a", "backlog"), t("b", "done")]);
    expect(g).toEqual([]);
    expect([...TRAY_HIDDEN_STATUSES].sort()).toEqual(["backlog", "done"]);
    // La dichiarazione e il filtro non possono divergere: sono lo stesso elenco.
    for (const s of TRAY_HIDDEN_STATUSES) {
      expect((TRAY_GROUP_ORDER as readonly string[]).includes(s)).toBe(false);
    }
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

  test("il glifo conta chi aspetta una DECISIONE, non tutto il lavoro aperto", () => {
    const g = trayBoardGroups([t("a", "review"), t("b", "review"), t("c", "in_progress"), t("d", "todo")]);
    expect(trayBoardAttention(g)).toBe(2);
    expect(trayBoardAttention([])).toBe(0);
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
