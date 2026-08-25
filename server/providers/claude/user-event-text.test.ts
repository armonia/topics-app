/**
 * Il corpo di una skill iniettato dalla CLI, nelle DUE forme che manda davvero.
 *
 * Entrambi i payload sono registrati dal wire
 * (`claude --print --output-format stream-json`): uno con una skill a cartella,
 * uno con un comando — che è la forma di `/recap`, cioè il caso da cui è partito
 * tutto, e l'unica che NON porta il prefisso «Base directory».
  * @covers CCLI-09
 */

import { describe, expect, test } from "bun:test";
import { skillBodyFromInjectedText } from "./user-event-text";

describe("skillBodyFromInjectedText", () => {
  test("skill a cartella: stacca l'intestazione tecnica e tiene il corpo", () => {
    const out = skillBodyFromInjectedText(
      "Base directory for this skill: /tmp/x/.claude/skills/zzprobe\n\nMARKER_BODY_XYZ_777. Rispondi solo con la parola PONG.\n",
    );
    expect(out).not.toBeNull();
    expect(out!.baseDir).toBe("/tmp/x/.claude/skills/zzprobe");
    expect(out!.body).toBe("MARKER_BODY_XYZ_777. Rispondi solo con la parola PONG.");
  });

  test("comando: nessun prefisso, il corpo passa intero", () => {
    // Il payload esatto di /recap, che è un ~/.claude/commands/recap.md.
    const recap = "Fai un riassunto in massimo 2 righe di tutte le modifiche fatte in questa sessione di chat. Sii conciso.\n";
    const out = skillBodyFromInjectedText(recap);
    expect(out).not.toBeNull();
    expect(out!.baseDir).toBeUndefined();
    expect(out!.body).toBe("Fai un riassunto in massimo 2 righe di tutte le modifiche fatte in questa sessione di chat. Sii conciso.");
  });

  test("il corpo su piu' righe resta intero", () => {
    const out = skillBodyFromInjectedText("Base directory for this skill: /a/b\n\nprima riga\n\nseconda riga");
    expect(out!.body).toBe("prima riga\n\nseconda riga");
  });

  test("prefisso senza corpo: niente da mostrare", () => {
    expect(skillBodyFromInjectedText("Base directory for this skill: /a/b\n\n   \n")).toBeNull();
  });

  test("testo vuoto: niente da mostrare", () => {
    expect(skillBodyFromInjectedText("   \n ")).toBeNull();
  });
});
