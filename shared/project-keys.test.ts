/**
 * @covers PROJECT-06
 */
import { describe, test, expect } from "bun:test";
import {
  projectHash,
  projectPanesKey,
  projectLayoutKey,
  PROJECT_PANES_PREFIX,
  PROJECT_LAYOUT_PREFIX,
} from "./project-keys";

/**
 * Test di parita' per l'hash djb2 condiviso. Gli attesi qui sotto sono
 * VALORI FISSI (calcolati una volta, fuori da questo file) — non l'algoritmo
 * riapplicato: un test che ricalcola con la stessa formula non prova nulla,
 * si limita a confermare che la funzione e' uguale a se stessa. Se una
 * futura modifica a `projectHash` fa deragliare anche uno solo di questi
 * valori, la chiave che client e server calcolano per lo stesso progetto
 * smette di combaciare — il pane sparisce senza errori (vedi il commento in
 * testa a project-keys.ts).
 */
describe("projectHash — valori attesi hard-coded", () => {
  test("path realistico macOS", () => {
    expect(projectHash("/Users/alice/projects/topics-app")).toBe("t4onvc");
  });

  test("stringa vuota", () => {
    expect(projectHash("")).toBe("0");
  });

  test("path con caratteri non-ASCII (accenti italiani)", () => {
    expect(projectHash("/home/utente/documenti/città-cliché")).toBe("2qbhgz");
  });

  test("path corto", () => {
    expect(projectHash("/tmp/x")).toBe("o2wb75");
  });

  test("e' deterministico e sensibile a ogni carattere (path diversi → hash diversi)", () => {
    expect(projectHash("/tmp/x")).not.toBe(projectHash("/tmp/y"));
  });
});

describe("projectPanesKey / projectLayoutKey — prefisso + hash atteso", () => {
  test("projectPanesKey compone PROJECT_PANES_PREFIX con l'hash", () => {
    expect(projectPanesKey("/Users/alice/projects/topics-app")).toBe(
      "topics-project-panes-t4onvc",
    );
  });

  test("projectLayoutKey compone PROJECT_LAYOUT_PREFIX con l'hash", () => {
    expect(projectLayoutKey("/Users/alice/projects/topics-app")).toBe(
      "topics-project-layout-t4onvc",
    );
  });

  test("stessa chiave per path uguale, chiavi diverse per path diversi", () => {
    expect(projectPanesKey("/tmp/x")).toBe(projectPanesKey("/tmp/x"));
    expect(projectPanesKey("/tmp/x")).not.toBe(projectPanesKey("/tmp/y"));
  });

  // I prefissi sono letterali stabili: cambiarli orfanerebbe ogni chiave
  // localStorage/ui_state esistente (vedi il commento in project-keys.ts).
  test("i prefissi esportati sono quelli storici", () => {
    expect(PROJECT_PANES_PREFIX).toBe("topics-project-panes-");
    expect(PROJECT_LAYOUT_PREFIX).toBe("topics-project-layout-");
  });
});
