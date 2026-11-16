/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from "bun:test";
import { trayBoardGroups } from "./tray-board";

const card = (id: string, status: string) => ({ id, text: `Card ${id}`, status, projectId: "p" });

describe("trayBoardGroups running suffix", () => {
  test("only the cards in progress take the suffix, after the cut title", () => {
    const groups = trayBoardGroups([card("a", "in_progress"), card("b", "todo")], { runningSuffix: (t) => `~5 min (${t.id})` });
    expect(groups.find((g) => g.status === "in_progress")?.rows[0]?.title).toBe("Card a · ~5 min (a)");
    expect(groups.find((g) => g.status === "todo")?.rows[0]?.title).toBe("Card b");
  });
  test("an empty suffix leaves the title as it was", () => {
    const groups = trayBoardGroups([card("a", "in_progress")], { runningSuffix: () => "" });
    expect(groups[0]?.rows[0]?.title).toBe("Card a");
  });
  test("a long title is cut first, so the suffix is never the part that goes", () => {
    const long = { ...card("a", "in_progress"), text: "word ".repeat(30) };
    const title = trayBoardGroups([long], { runningSuffix: () => "~2 min" })[0]!.rows[0]!.title;
    expect(title.endsWith(" · ~2 min")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(44 + " · ~2 min".length);
  });
});
