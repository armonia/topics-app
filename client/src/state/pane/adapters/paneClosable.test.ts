import { describe, test, expect } from "bun:test";
import { isPaneClosable } from "./paneConfig";
import type { Pane } from "../types";

/**
 * «Se è pinnata manco posso chiuderla finché non la dis-pinno» (Attilio,
 * 2026-08-03).
 *
 * Discende dal modello a UNO stato: chiudere una tab È il ritiro di ciò che
 * contiene — la chat viene archiviata, la sessione ritirata. Se chiudere è
 * definitivo, fissare deve poter dire «questa no». Prima il fissaggio non
 * proteggeva nulla: la tab si chiudeva e si archiviava come le altre, e restava
 * in lista solo per un'eccezione nella barra laterale.
 */

const pane = (over: Partial<Pane> & Pick<Pane, "id" | "type">): Pane =>
  ({ title: "", preview: false, ...over }) as Pane;

const pinned = (...keys: string[]) => (k: string) => keys.includes(k);
const nessunPin = () => false;

describe("isPaneClosable", () => {
  test("chat fissata: non si chiude — la chiave è il topicId", () => {
    const p = pane({ id: "chat:t1", type: "chat", topicId: "t1" });
    expect(isPaneClosable(p, pinned("t1"))).toBe(false);
    expect(isPaneClosable(p, nessunPin)).toBe(true);
  });

  test("terminale, browser e progetto: stessa regola, chiave = id della pane", () => {
    const casi: Array<[Pane["type"], string]> = [
      ["terminal", "terminal:s1"],
      ["browser", "browser:ctx1"],
      ["project", "project:%2Ftmp%2Fp"],
    ];
    for (const [type, id] of casi) {
      const p = pane({ id, type });
      expect(isPaneClosable(p, pinned(id))).toBe(false);
      expect(isPaneClosable(p, nessunPin)).toBe(true);
    }
  });

  test("il pin di un'ALTRA tab non blocca questa", () => {
    const p = pane({ id: "chat:t1", type: "chat", topicId: "t1" });
    expect(isPaneClosable(p, pinned("t2", "terminal:s9"))).toBe(true);
  });

  test("una pane non fissabile resta sempre chiudibile", () => {
    // Nessuna chiave di pin → niente da proteggere. Non deve diventare
    // accidentalmente non chiudibile solo perché il fissaggio non la conosce.
    const p = pane({ id: "session-viewer:abc", type: "session-viewer" });
    expect(isPaneClosable(p, () => true)).toBe(true);
  });

  test("chat senza topicId: nessuna chiave, quindi chiudibile", () => {
    const p = pane({ id: "chat:orfana", type: "chat" });
    expect(isPaneClosable(p, () => true)).toBe(true);
  });

  test("dis-pinnare riapre la chiusura, senza altri passaggi", () => {
    const p = pane({ id: "terminal:s1", type: "terminal" });
    let fissati = ["terminal:s1"];
    const isPinned = (k: string) => fissati.includes(k);
    expect(isPaneClosable(p, isPinned)).toBe(false);
    fissati = [];
    expect(isPaneClosable(p, isPinned)).toBe(true);
  });
});
