import { describe, expect, test } from "bun:test";
import { attribuisciMedia } from "./media-ownership";

/**
 * Il caso vero, del 7 agosto: un turno di analisi lungo 11 minuti si è portato
 * in fondo alla risposta due screenshot prodotti da una spec E2E che girava in
 * un'ALTRA sessione. La cartella `~/.topics/media/` è condivisa per contratto,
 * e lo sweep guardava solo l'ora di modifica.
 *
 * @covers RES-ATTR-08
 */

const M = "/Users/x/.topics/media";
const ALTRUI = [`${M}/empty-state-light.png`, `${M}/empty-state-dark.png`];

describe("attribuisciMedia — di chi è questo file", () => {
  test("il caso del 7 agosto: il turno non li ha mai nominati, non sono suoi", () => {
    const tools = [
      { name: "Bash", args: { command: "discord read 1244320198731890699 --limit 100" }, result: "…report…" },
      { name: "Bash", args: { command: "gh api repos/armonia/moonstone-circle/commits" }, result: "…commit…" },
    ];
    const r = attribuisciMedia(ALTRUI, tools);
    expect(r.propri).toEqual([]);
    expect(r.altrui).toEqual(ALTRUI);
  });

  test("il percorso assoluto negli argomenti è la prova", () => {
    const mio = `${M}/anteprima.png`;
    const r = attribuisciMedia([mio, ...ALTRUI], [
      { name: "update_task", args: { task_id: "t1", previewImage: mio } },
    ]);
    expect(r.propri).toEqual([mio]);
    expect(r.altrui).toEqual(ALTRUI);
  });

  test("basta il nome del file, se è distintivo: una riga di comando non porta il path intero", () => {
    const mio = `${M}/drag-and-drop-tessere.webm`;
    const r = attribuisciMedia([mio], [
      { name: "Bash", args: { command: "cp /tmp/rec/out.webm ~/.topics/media/drag-and-drop-tessere.webm" } },
    ]);
    expect(r.propri).toEqual([mio]);
  });

  test("il percorso può stare nel RISULTATO, non solo negli argomenti", () => {
    // Lo screenshot del browser torna il path che ha scritto (mai il base64).
    const mio = `${M}/browser/schermata-1754.png`;
    const r = attribuisciMedia([mio], [
      { name: "browser_screenshot", args: { paneId: "p1" }, result: `salvato in ${mio}` },
    ]);
    expect(r.propri).toEqual([mio]);
  });

  test("un nome corto NON prova niente: serve il percorso assoluto", () => {
    // Altrimenti si torna ad attribuire per coincidenza, con un passaggio in più.
    const corto = `${M}/x.png`;
    expect(attribuisciMedia([corto], [{ name: "Bash", args: { command: "echo x.png" } }]).propri).toEqual([]);
    expect(attribuisciMedia([corto], [{ name: "Bash", args: { command: `ls ${corto}` } }]).propri).toEqual([corto]);
  });

  test("un turno SENZA chiamate non può aver prodotto niente", () => {
    const r = attribuisciMedia(ALTRUI, []);
    expect(r.propri).toEqual([]);
    expect(r.altrui).toEqual(ALTRUI);
  });

  test("nessun candidato: nessun lavoro", () => {
    expect(attribuisciMedia([], [{ name: "Bash", args: { command: "ls" } }])).toEqual({ propri: [], altrui: [] });
  });

  test("argomenti non serializzabili non fanno saltare l'attribuzione", () => {
    const ciclico: Record<string, unknown> = {};
    ciclico.self = ciclico;
    const mio = `${M}/anteprima-lunga.png`;
    const r = attribuisciMedia([mio], [
      { name: "Rotto", args: ciclico },
      { name: "Bash", args: { command: `open ${mio}` } },
    ]);
    expect(r.propri).toEqual([mio]);
  });
});
