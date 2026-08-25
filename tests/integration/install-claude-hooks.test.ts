/**
 * `scripts/install-claude-hooks.ts` scrive nella `~/.claude/settings.json`
 * dell'utente, e lo fa al momento dell'import (chiamata a `install()` a livello
 * di modulo). Importarlo qui vorrebbe dire riscrivere i settings VERI di chi fa
 * girare i test: si esegue quindi come sottoprocesso con `HOME` puntato a una
 * cartella temporanea — che è anche una prova più forte, perché passa dallo
 * stesso percorso che usa una persona.
 *
 * Quello che si pinna:
 *  1. il path del wrapper è QUOTATO (una home con uno spazio spezzava l'hook, in
 *     silenzio: niente segnale di fine turno, fase appesa a `starting`);
 *  2. reinstallare RIPARA una entry nostra scritta da una versione precedente,
 *     invece di riconoscerla e lasciarla difettosa per sempre;
 *  3. le entry di altri non si toccano, né in install né in uninstall.
 *
 * @covers CCS-06
 *
 * Hook installer idempotency. Strong proof: it runs the real script as a
 * subprocess with a temporary HOME, i.e. the same path a person takes. Partial
 * on the uninstall branch.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "../../scripts/install-claude-hooks.ts");

let home = "";
const settingsPath = () => join(home, ".claude", "settings.json");

function run(cmd: "install" | "uninstall") {
  const r = Bun.spawnSync(["bun", SCRIPT, cmd], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd} exit ${r.exitCode}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath(), "utf-8"));
}

function ourEntries(s: any, event: string): any[] {
  const matchers = s.hooks?.[event] ?? [];
  return matchers.flatMap((m: any) => m.hooks.filter((h: any) => h.topics_app === true));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "topics-hooks-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe("install-claude-hooks", () => {
  test("installa da zero e QUOTA il path del wrapper", () => {
    run("install");
    const entries = ourEntries(readSettings(), "SessionStart");
    expect(entries.length).toBe(1);
    // Il cuore del fix: senza apici, `/bin/sh -c` spezza una home con lo spazio.
    expect(entries[0].command).toBe(`"${home}/.claude/topics-hooks/post-hook.sh" SessionStart`);
    expect(entries[0].topics_app).toBe(true);
  });

  test("è idempotente: reinstallare non duplica e non cambia niente", () => {
    run("install");
    const primo = readFileSync(settingsPath(), "utf-8");
    run("install");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(primo);
    expect(ourEntries(readSettings(), "Stop").length).toBe(1);
  });

  test("RIPARA una entry nostra rimasta col path non quotato", () => {
    // Esattamente ciò che ha scritto la versione precedente dello script.
    const vecchio = `${home}/.claude/topics-hooks/post-hook.sh SessionStart`;
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: vecchio, timeout: 5, topics_app: true }] },
          ],
        },
      }),
    );

    run("install");

    const entries = ourEntries(readSettings(), "SessionStart");
    expect(entries.length).toBe(1); // riscritta, non affiancata da un duplicato
    expect(entries[0].command).toBe(`"${home}/.claude/topics-hooks/post-hook.sh" SessionStart`);
  });

  test("le entry di altri sopravvivono a install e a uninstall", () => {
    const altrui = { type: "command", command: "/usr/local/bin/mio-hook.sh", timeout: 3 };
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [altrui] }] } }),
    );

    run("install");
    let s = readSettings();
    expect(s.hooks.SessionStart[0].hooks).toContainEqual(altrui);
    expect(ourEntries(s, "SessionStart").length).toBe(1);

    run("uninstall");
    s = readSettings();
    expect(s.hooks.SessionStart[0].hooks).toEqual([altrui]); // resta solo la sua
    expect(ourEntries(s, "SessionStart").length).toBe(0);
    expect(existsSync(join(home, ".claude", "topics-hooks"))).toBe(false);
  });
});
