import { describe, test, expect } from "bun:test";
import { paneReducer } from "./panes";
import { undoReducer } from "./undo";
import type { PaneState, Pane } from "../types";
import { blankPaneState as blank } from "../testSupport";

/**
 * UNDO_CLOSE deve ristampare il seq CAUSALE, non solo l'orologio.
 *
 * Il guasto misurato (E2E `pane-undo.spec.ts` PANE-03, riproducibile 2 volte su
 * 2): chiudi una tab, premi ⌘Z, la tab TORNA — e poi sparisce di nuovo dopo
 * ~200-400 ms. Sonda sul dispatch dello store:
 *
 *     UNDO_CLOSE             closed=0  after=[t1, t2, t3]
 *     HYDRATE_FROM_SNAPSHOT  closed=1  after=[t1, t3]      ← la richiude
 *
 * Uno snapshot che PRECEDE l'undo vince il cancello LWW e riporta il marcatore
 * di chiusura; il PUT locale è debounced a 500 ms e arriva sempre dopo.
 *
 * La difesa contro questo esiste già: nella strip di `HYDRATE_FROM_SNAPSHOT`
 * una pane con un `openedSeq` PIÙ ALTO del `seq` del marcatore lo ritratta
 * invece di farsi cancellare — «l'ho riaperta dopo che tu l'hai chiusa».
 * `undoReducer` però ristampava solo `openedAt`, e `openedAt` ha smesso di
 * decidere: dal confronto causale del 2026-08-06 il campo che decide è
 * `openedSeq` (vedi il commento in `reducers/panes.ts`, «il gemello CAUSALE …
 * quello su cui si decide davvero»). Il commento dentro `undo.ts` continuava a
 * dire «senza quel timbro un marcatore superstite vince», ed era vero: solo che
 * il timbro che serviva non era più quello che stampava.
 *
 * Questi test bloccano il timbro in ENTRAMBE le strade dell'undo — la pane
 * ancora nei `panes` (resuscitata da un hydrate) e quella da reinserire.
 *
 * @covers CMD-03
 */


const chat = (id: string): Pane => ({ id, type: "chat", title: id, topicId: id });

/** Due tab aperte, poi se ne chiude una: lo stack ha il record da annullare. */
function openTwoAndClose(id = "chat:t2"): PaneState {
  const s = blank();
  for (const pid of ["chat:t1", "chat:t2"]) {
    paneReducer(s, { type: "OPEN_PANE", payload: { ...chat(pid), groupId: "group:default" } });
    s.lastSeq += 1;
  }
  paneReducer(s, {
    type: "CLOSE_PANE",
    payload: { id, groupId: "group:default", groupIndex: 1 },
  });
  s.lastSeq += 1;
  return s;
}

describe("UNDO_CLOSE — il timbro causale", () => {
  test("la pane ripristinata batte il marcatore che l'aveva chiusa", () => {
    const s = openTwoAndClose();
    const mark = s.tombstones?.["chat:t2"];
    expect(mark, "la chiusura deve aver lasciato un marcatore").toBeTruthy();

    undoReducer(s, { type: "UNDO_CLOSE" });

    const restored = s.panes["chat:t2"];
    expect(restored, "l'undo deve rimettere la pane").toBeTruthy();
    // È QUESTO il numero su cui la strip dell'hydrate decide.
    expect(typeof restored.openedSeq).toBe("number");
    expect(
      restored.openedSeq!,
      `openedSeq=${restored.openedSeq} deve superare il seq del marcatore (${mark!.seq}), ` +
        `o il prossimo snapshot stantio richiude la tab`,
    ).toBeGreaterThan(mark!.seq);
  });

  test("vale anche quando un hydrate ha già resuscitato l'entità (ghost pane)", () => {
    const s = openTwoAndClose();
    const mark = s.tombstones?.["chat:t2"];
    // Un hydrate in corsa rimette l'ENTITÀ senza il posto nel gruppo: è il caso
    // che `undoReducer` ripara reinserendo l'id nei paneIds. Porta con sé il
    // seq VECCHIO, quello di prima della chiusura — che è il difetto.
    s.panes["chat:t2"] = { ...chat("chat:t2"), openedSeq: 1, openedAt: 1 };

    undoReducer(s, { type: "UNDO_CLOSE" });

    const restored = s.panes["chat:t2"];
    expect(restored.openedSeq!).toBeGreaterThan(mark!.seq);
    expect(s.groups["group:default"].paneIds, "e la pane torna nel gruppo").toContain("chat:t2");
  });

  test("e quando la pane è già slottata: il ramo che esce presto timbra lo stesso", () => {
    const s = openTwoAndClose();
    const mark = s.tombstones?.["chat:t2"];
    // Riaperta da un'altra strada (OPEN_PANE di un hydrate) e già al suo posto:
    // `undoReducer` esce presto. Ma il marcatore superstite arriva lo stesso, e
    // senza timbro la richiuderebbe — l'uscita anticipata non è un'esenzione.
    s.panes["chat:t2"] = { ...chat("chat:t2"), openedSeq: 1, openedAt: 1 };
    s.groups["group:default"].paneIds.splice(1, 0, "chat:t2");

    undoReducer(s, { type: "UNDO_CLOSE" });

    expect(s.panes["chat:t2"].openedSeq!).toBeGreaterThan(mark!.seq);
  });

  test("il marcatore viene ritratto in ogni strada", () => {
    for (const prepara of [
      (s: PaneState) => s,
      (s: PaneState) => { s.panes["chat:t2"] = { ...chat("chat:t2"), openedSeq: 1 }; return s; },
    ]) {
      const s = prepara(openTwoAndClose());
      undoReducer(s, { type: "UNDO_CLOSE" });
      expect(s.tombstones?.["chat:t2"]).toBeUndefined();
      expect(s.closedStack.some((r) => r.id === "chat:t2")).toBe(false);
    }
  });
});
