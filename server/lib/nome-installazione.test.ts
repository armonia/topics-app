/**
 * The installation name is a LABEL, and a label has two jobs: to exist, and to
 * be safe to paint.
 *
 * Why it deserves a test at all: it is the only thing that will tell a person
 * WHICH Topics they are authorising from their phone. Today there is one
 * installation and the question looks academic; the day there are two, a
 * pairing screen that cannot name its subject is a screen that asks you to
 * trust something unnamed.
 *
 * @covers PAIRING-01
 */
import { describe, test, expect } from "bun:test";
import { hostname } from "node:os";

import {
  nomeInstallazione, __scordaNomeInstallazione, pulisciNome, daHostname,
} from "./nome-installazione";

describe("nome dell'installazione", () => {
  test("su questa macchina un nome c'e', e non e' vuoto", () => {
    __scordaNomeInstallazione();
    const n = nomeInstallazione();
    // `null` is allowed by the contract, but not on a Mac that has a hostname:
    // a `null` here would mean both roads are broken.
    expect(n).toBeString();
    expect((n ?? "").length).toBeGreaterThan(0);
  });

  test("non porta a schermo caratteri di controllo, né righe intere", () => {
    // It ends up inside a JSON response a browser paints. A newline or a
    // control byte in the middle of an interface is the defect discovered
    // late and badly.
    const n = nomeInstallazione() ?? "";
    expect(n).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(n).toBe(n.trim());
  });

  test("sta in una riga: non piu' di 64 caratteri", () => {
    // The limit is not cosmetic: without it a pathological hostname becomes
    // the heading of a screen.
    expect((nomeInstallazione() ?? "").length).toBeLessThanOrEqual(64);
  });

  test("il suffisso `.local` non arriva a chi legge", () => {
    // The PUBLIC name never shows it, and on this machine it does not even go
    // through there: `scutil` answers first. So it is proven where the
    // decision actually lives, and it is stated that today's machine does not
    // exercise that branch.
    expect((nomeInstallazione() ?? "").toLowerCase().endsWith(".local")).toBe(false);
    expect(daHostname("MacBook-Pro-di-Anna.local")).toBe("MacBook-Pro-di-Anna");
    expect(daHostname("qualcosa.LOCAL")).toBe("qualcosa");
    // ...and a name without the suffix does not shorten itself.
    expect(daHostname("fisso-in-studio")).toBe("fisso-in-studio");

    // WHETHER THIS MACHINE HAS THE SUFFIX IS A FACT ABOUT THE MACHINE, NOT A
    // REQUIREMENT. The line here used to assert `.local: true`, which is true on
    // a Mac and false on a Linux CI runner: the test went red on 2026-08-26 with
    // nothing broken, on a run that had only touched Windows shell code. A check
    // that fails depending on who runs it does not defend anything — it just
    // teaches people to ignore a red.
    //
    // The intent it carried was right and is kept: the `.local` branch of
    // `daHostname` must be EXERCISED, not assumed. That is what the two lines
    // above do, on explicit inputs, on every machine. The live hostname is
    // reported instead of asserted, so a Mac that stopped answering `.local`
    // stays readable in the log without turning into a false failure.
    const suffisso = hostname().toLowerCase().endsWith(".local");
    console.log(`[nome-installazione] hostname di questa macchina finisce per .local: ${suffisso}`);
  });

  test("la pulizia toglie i caratteri di controllo e taglia a 64", () => {
    // Proven HERE and not through the public function, because on a Mac the
    // name comes from `scutil` and these lines would never run: a test that
    // passes identically with the trimming removed is not a test.
    expect(pulisciNome("a\u0000b\u001fc\u007fd")).toBe("a b c d");
    expect(pulisciNome("  spazi   larghi  ")).toBe("spazi larghi");
    expect(pulisciNome("riga\nspezzata")).toBe("riga spezzata");
    expect(pulisciNome("x".repeat(200))).toHaveLength(64);
    // A normal name is left alone: without this direction, a `return ""`
    // would pass everything else.
    expect(pulisciNome("MacBook Pro di Anna")).toBe("MacBook Pro di Anna");
  });

  test("la seconda chiamata non ripaga il sottoprocesso", () => {
    // `scutil` is a process: this question arrives on every session check, so
    // on every tab that opens. A computer name changes about once never.
    __scordaNomeInstallazione();
    const primo = nomeInstallazione();
    const dopo = performance.now();
    for (let i = 0; i < 200; i++) nomeInstallazione();
    const durata = performance.now() - dopo;
    expect(nomeInstallazione()).toBe(primo);
    // 200 subprocesses do not fit in a few milliseconds: if they do, the cache
    // is there.
    expect(durata).toBeLessThan(50);
  });
});
