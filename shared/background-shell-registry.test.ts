/**
 * La chiave con cui una shell in background sta nel registro, e l'intestazione
 * che il registro le mette in testa al log.
 *
 * Sono due dettagli minuscoli che però tengono insieme due lati: il server
 * scrive, la card della chat rilegge. Se la ripulitura della chiave diverge, la
 * card non trova più la sua shell e torna muta — senza errori, senza rossi.
 * @covers BGSHELL-02
 */

import { describe, expect, it } from "bun:test";
import {
  backgroundShellBanner,
  shellProcessKey,
  stripBackgroundShellBanner,
} from "./background-shell-registry";

describe("chiave di registro della shell", () => {
  it("tiene i due pezzi e non li confonde", () => {
    expect(shellProcessKey("sess-1", "bash_1")).toBe("shell:sess-1:bash_1");
  });

  it("ripulisce i caratteri che in un id di processo non stanno", () => {
    // I due punti restano nella sessione (le sessionKey ne hanno) ma non nell'id.
    expect(shellProcessKey("topic:abc/def", "bash 1")).toBe("shell:topic:abc-def:bash-1");
  });

  it("due sessioni con lo stesso shellId danno chiavi diverse", () => {
    // È l'intera ragione per cui la card cerca per chiave e non per solo id:
    // la prima shell di ogni chat si chiama `bash_1`.
    expect(shellProcessKey("a", "bash_1")).not.toBe(shellProcessKey("b", "bash_1"));
  });
});

describe("intestazione del log", () => {
  it("la toglie quando il log parte proprio da lì", () => {
    const log = `${backgroundShellBanner("bash_1")}\nprima riga vera`;
    expect(stripBackgroundShellBanner(log, "bash_1")).toBe("prima riga vera");
  });

  it("un log fatto della sola intestazione resta vuoto", () => {
    expect(stripBackgroundShellBanner(backgroundShellBanner("bash_1"), "bash_1")).toBe("");
  });

  it("non tocca un log che non comincia con l'intestazione", () => {
    expect(stripBackgroundShellBanner("in ascolto su :3000", "bash_1")).toBe("in ascolto su :3000");
  });

  it("non toglie l'intestazione di UN'ALTRA shell", () => {
    const log = `${backgroundShellBanner("bash_9")}\nroba`;
    expect(stripBackgroundShellBanner(log, "bash_1")).toBe(log);
  });
});
