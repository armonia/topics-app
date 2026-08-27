import { test, expect, describe } from "bun:test";
import { decideOnRestart, type RestartCandidate } from "./terminal-restart-policy";

/**
 * La regressione che questi test bloccano.
 *
 * `reconcileSessions` rilanciava con `--resume` ogni riga claude rimasta nel
 * database, a ogni avvio del server. Il 2026-08-03 quello significava 11 CLI
 * vive per 2,4 GB, tutte di conversazioni che l'utente aveva chiuso fra il
 * 03/07 e il 29/07: processi che nessuna schermata mostrava, perché le loro tab
 * non esistevano più.
 *
 * La riga che non deve mai più tornare verde è «claude + transcript → recreate».
 *
 * @covers TERM-05
 */

const claude = (over: Partial<RestartCandidate> = {}): RestartCandidate => ({
  type: "claude-code",
  claudeSessionId: "7b1e2a1f-2cf2-453c-a77b-5dc95d66e890",
  hasTranscript: true,
  ...over,
});

describe("sessioni claude", () => {
  test("con transcript si PARCHEGGIA — mai si rilancia", () => {
    for (const type of ["claude-code", "claude-code-team"]) {
      expect(decideOnRestart(claude({ type }))).toEqual({ action: "park" });
    }
  });

  test("senza transcript si cancella: `--resume` fallirebbe per sempre", () => {
    expect(decideOnRestart(claude({ hasTranscript: false }))).toEqual({ action: "drop" });
  });

  test("senza id di ripresa non c'è niente da riprendere né da cancellare: parcheggio", () => {
    // Il transcript qui non è nemmeno stato guardato dal chiamante (hasTranscript
    // resta false), e proprio per questo NON deve tradursi in una cancellazione.
    for (const id of [undefined, null, ""]) {
      expect(decideOnRestart(claude({ claudeSessionId: id, hasTranscript: false })))
        .toEqual({ action: "park" });
    }
  });

  test("nessun input claude produce mai un rilancio", () => {
    for (const type of ["claude-code", "claude-code-team"]) {
      for (const hasTranscript of [true, false]) {
        for (const claudeSessionId of ["abc", undefined, null, ""]) {
          expect(decideOnRestart({ type, claudeSessionId, hasTranscript }).action)
            .not.toBe("recreate");
        }
      }
    }
  });
});

describe("gli altri tipi", () => {
  test("codex si rilancia: il suo pane standalone non ha una rianimazione", () => {
    expect(decideOnRestart({ type: "codex", claudeSessionId: "roll-1", hasTranscript: false }))
      .toEqual({ action: "recreate" });
    expect(decideOnRestart({ type: "codex", hasTranscript: false }))
      .toEqual({ action: "recreate" });
  });

  test("shell e sconosciuti si parcheggiano, non si cancellano", () => {
    for (const type of ["shell", "opencode", "kimi-code", "qualcosa-di-nuovo", ""]) {
      expect(decideOnRestart({ type, hasTranscript: false })).toEqual({ action: "park" });
    }
  });

  test("un transcript mancante non cancella mai una riga non-claude", () => {
    // La cancellazione è motivata SOLO da «--resume fallirebbe»: fuori dai tipi
    // claude quel ragionamento non si applica, e cancellare perderebbe la riga.
    for (const type of ["shell", "codex", "opencode", "kimi-code"]) {
      expect(decideOnRestart({ type, claudeSessionId: "x", hasTranscript: false }).action)
        .not.toBe("drop");
    }
  });
});
