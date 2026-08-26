/**
 * The hot-reload watcher in start-prod.sh asks the running server to restart
 * itself, and only SIGTERMs it when that request goes unanswered. The request
 * travels over HTTP, so a server still inside its init has not opened the port
 * yet and cannot answer — it is ALIVE, not mute.
 *
 * Reading that silence as refusal is self-sustaining: the replacement needs
 * 15-20s to be born, so the next event finds it in the same window and kills it
 * again. Measured 26/08/2026: 992 exits in the log, ~17 minutes with the app
 * unreachable, every cycle closed by "SIGTERM received during init — nothing
 * owned yet"; the Kanban pane answered ECONNREFUSED.
 *
 * Like scripts/start-prod-backoff.test.ts, this does NOT run start-prod.sh —
 * that file drives real processes, launchd and locks. It mirrors the decision
 * in a pure function, and separately asserts that start-prod.sh actually
 * contains the gate. The mirror alone would pass over a script that lost the
 * code; the file assertions are what make the pair bite.
 *
 * @covers BIRTH-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const START_PROD = join(REPO_ROOT, "scripts", "start-prod.sh");
const src = readFileSync(START_PROD, "utf8");

/** Seconds below which a server counts as still being born. Mirrors start-prod.sh. */
const BIRTH_GRACE_S = 25;

type Action = "rinvia" | "procedi" | "sparito";

/**
 * What the watcher does when a reload event lands.
 * Direct mirror of the `while :;` gate in start-prod.sh.
 */
function decideOnReload(etaS: number, vivo: boolean, grazia = BIRTH_GRACE_S): Action {
  if (etaS >= grazia) return "procedi";
  if (!vivo) return "sparito";
  return "rinvia";
}

describe("cancello di nascita del ricaricamento a caldo", () => {
  it("un server appena spawnato fa RINVIARE, non uccidere", () => {
    expect(decideOnReload(0, true)).toBe("rinvia");
  });

  it("un secondo prima della soglia si rinvia ancora", () => {
    expect(decideOnReload(BIRTH_GRACE_S - 1, true)).toBe("rinvia");
  });

  it("alla soglia esatta si procede", () => {
    expect(decideOnReload(BIRTH_GRACE_S, true)).toBe("procedi");
  });

  it("un server maturo che tace si procede a trattarlo come muto", () => {
    expect(decideOnReload(120, true)).toBe("procedi");
  });

  it("un server uscito da solo durante il rinvio interrompe l'attesa", () => {
    expect(decideOnReload(3, false)).toBe("sparito");
  });

  it("la finestra 15-20s dell'incidente del 26/08 cade dentro il rinvio", () => {
    // Every cycle of the incident died between 15 and 21 seconds of life.
    for (const eta of [15, 16, 17, 18, 20]) {
      expect(decideOnReload(eta, true), `eta ${eta}s`).toBe("rinvia");
    }
  });
});

describe("start-prod.sh contiene davvero il cancello", () => {
  it("dichiara BIRTH_GRACE_S, e il valore coincide con questo banco", () => {
    const m = src.match(/^BIRTH_GRACE_S=(\d+)/m);
    expect(m, "BIRTH_GRACE_S non dichiarata in start-prod.sh").not.toBeNull();
    expect(parseInt(m![1], 10)).toBe(BIRTH_GRACE_S);
  });

  it("misura l'eta dal mtime del pidfile", () => {
    expect(src).toContain('stat -f %m "$SERVER_PIDFILE"');
  });

  it("il cancello sta PRIMA del SIGTERM dell'attesa di nascita", () => {
    const gateAt = src.indexOf("BIRTH_GRACE_S}s)");
    // NOT the phrase on its own: the gate's comment quotes it, and indexOf
    // would find that one. Anchor to the echo line that sends the SIGTERM.
    const killAt = src.indexOf("server source changed \u2192 graceful hot-reload");
    expect(gateAt, "messaggio del rinvio assente").toBeGreaterThan(-1);
    expect(killAt, "ramo del SIGTERM assente").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(killAt);
  });

  it("stampa l'eta misurata, non solo che sta rinviando", () => {
    expect(src).toMatch(/RINVIATO.*\$\{_age\}s/);
  });

  it("interrompe l'attesa se il processo sorvegliato sparisce", () => {
    const gate = src.slice(src.indexOf("BIRTH_GRACE_S}s)") - 800, src.indexOf("BIRTH_GRACE_S}s)"));
    expect(gate).toContain('kill -0 "$SP"');
  });
});
