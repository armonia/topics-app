import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import type { PaneState, Pane } from "../types";
import { blankPaneState as blank } from "../testSupport";

/**
 * UNDO_CLOSE non deve mai lasciare una GHOST PANE: un'entità in `panes` che
 * nessun gruppo contiene.
 *
 * Il guasto misurato (E2E `pane-undo.spec.ts`, sonda sul pane-store subito dopo
 * l'undo): chiudi la tab di mezzo di tre, premi ⌘Z, e
 *
 *     store  group:default = [t1, t3]     ← t2 NON è nel gruppo
 *     UI     [t1, t3, t2]                 ← ma la tab c'è, in fondo
 *
 * La causa è la guardia anti-duplicato del reducer: «se l'entità esiste già,
 * esci». Il suo scopo è giusto — evitare due tab con lo stesso id quando la
 * pane è stata riaperta via OPEN_PANE dopo la chiusura — ma la domanda è
 * sbagliata. Ciò che duplicherebbe la tab non è l'esistenza dell'ENTITÀ: è la
 * presenza dell'id nei `paneIds` di un gruppo. Se l'entità c'è ma nessun gruppo
 * la contiene, uscire lascia il record consumato (è già stato `pop`-ato) e la
 * pane senza posto: invisibile allo store, visibile alla UI attraverso
 * `openPanels`, e appesa in fondo invece che al suo indice.
 *
 * @covers CMD-03
 */

const chat = (id: string): Pane => ({ id, type: "chat", title: id, topicId: id });

/** Tre tab aperte in `group:default`, poi si chiude quella di mezzo. */
function threeTabsWithMiddleClosed(): PaneState {
  const s = blank();
  for (const id of ["chat:t1", "chat:t2", "chat:t3"]) {
    paneReducer(s, { type: "OPEN_PANE", payload: { ...chat(id), groupId: "group:default" } });
  }
  paneReducer(s, {
    type: "CLOSE_PANE",
    payload: { id: "chat:t2", groupId: "group:default", groupIndex: 1 },
  });
  return s;
}

describe("UNDO_CLOSE — nessuna ghost pane", () => {
  test("caso base: la tab torna al suo INDICE, non in fondo", () => {
    const s = threeTabsWithMiddleClosed();
    expect(s.groups["group:default"].paneIds).toEqual(["chat:t1", "chat:t3"]);

    paneReducer(s, { type: "UNDO_CLOSE" });

    expect(s.groups["group:default"].paneIds).toEqual(["chat:t1", "chat:t2", "chat:t3"]);
    expect(s.panes["chat:t2"]).toBeDefined();
  });

  test("l'entità è già stata resuscitata da un'altra strada: la pane va RIMESSA nel gruppo", () => {
    // È lo scenario vero. L'undo di App fa partire un unarchive PRIMA del
    // dispatch (usePanelLifecycle), e una ri-idratazione può rimettere
    // l'entità in `panes` mentre il gruppo non la contiene ancora. Con la
    // guardia sull'entità il reducer usciva qui, consumando il record: la pane
    // restava fuori da ogni gruppo — la ghost pane.
    const s = threeTabsWithMiddleClosed();
    s.panes["chat:t2"] = chat("chat:t2"); // resuscitata, ma in nessun gruppo
    expect(s.groups["group:default"].paneIds).not.toContain("chat:t2");

    paneReducer(s, { type: "UNDO_CLOSE" });

    expect(
      s.groups["group:default"].paneIds,
      "la pane resuscitata dev'essere reinserita al suo indice, non lasciata orfana",
    ).toEqual(["chat:t1", "chat:t2", "chat:t3"]);
  });

  test("ma se è GIÀ in un gruppo non si duplica (il motivo per cui la guardia esiste)", () => {
    // La guardia non va tolta: va posta sulla domanda giusta. Qui la pane è
    // stata riaperta davvero, con il suo posto nel gruppo — reinserirla
    // metterebbe lo stesso id due volte in `paneIds`, cioè due tab che
    // condividono un'entità e collidono sulla key di React.
    const s = threeTabsWithMiddleClosed();
    paneReducer(s, { type: "OPEN_PANE", payload: { ...chat("chat:t2"), groupId: "group:default" } });
    const before = [...s.groups["group:default"].paneIds];

    paneReducer(s, { type: "UNDO_CLOSE" });

    expect(s.groups["group:default"].paneIds).toEqual(before);
    expect(
      s.groups["group:default"].paneIds.filter((id) => id === "chat:t2"),
      "nessun id duplicato nel gruppo",
    ).toHaveLength(1);
  });

  test("in ogni caso il record viene consumato: l'undo non si ripete all'infinito", () => {
    const s = threeTabsWithMiddleClosed();
    s.panes["chat:t2"] = chat("chat:t2");
    const depth = s.closedStack.length;
    paneReducer(s, { type: "UNDO_CLOSE" });
    expect(s.closedStack.length).toBe(depth - 1);
  });

  test("invariante generale: nessuna entità senza un gruppo che la contenga", () => {
    const s = threeTabsWithMiddleClosed();
    s.panes["chat:t2"] = chat("chat:t2");
    paneReducer(s, { type: "UNDO_CLOSE" });

    const slotted = new Set(Object.values(s.groups).flatMap((g) => g.paneIds));
    const ghosts = Object.keys(s.panes).filter((id) => !slotted.has(id));
    expect(ghosts, `pane senza posto in nessun gruppo: ${ghosts.join(", ")}`).toEqual([]);
  });
});
