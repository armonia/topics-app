/**
 * THE CONFIGURATION IS READ AGAIN AT EVERY SERVER LAUNCH.
 *
 * On 2026-09-16 the owner wrote the mail and Google variables into
 * `~/.topics-server-env` and said "the server picks them up at the next
 * restart". It was not true all the way down: `start-prod.sh` sourced that file
 * ONCE, above the supervisor loop, so the watcher's reload (SIGTERM to the
 * server, same script) came back with the environment of hours earlier. Seeing
 * the new variables needed a launchd restart, which nobody expects after
 * editing a configuration file. `ps eww` on the live server confirmed it: not
 * one `TOPICS_MAIL_*` in its environment.
 *
 * This file does not run `start-prod.sh`: that script takes a lock, mounts the
 * watchers and, with an empty `public/`, starts a client build - exactly what
 * must not happen on this machine. As for the backoff
 * (`start-prod-backoff.test.ts`), the proof is on the SHAPE of the script: the
 * `source` must sit INSIDE the loop, before the server spawn.
 * @covers BOOT-ENV-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = readFileSync(join(REPO_ROOT, "scripts", "start-prod.sh"), "utf8").split("\n");

const lineOf = (needle: string, from = 0): number => {
  const i = SCRIPT.findIndex((l, n) => n >= from && l.includes(needle));
  if (i < 0) throw new Error(`riga non trovata in start-prod.sh: ${needle}`);
  return i;
};

describe("start-prod.sh rilegge ~/.topics-server-env a ogni avvio del server", () => {
  it("il source sta dentro il loop di supervisione, prima dello spawn", () => {
    const loop = lineOf('while [ "$SHUTTING_DOWN" != 1 ]');
    const spawn = lineOf('"$BUN" run "$APP_DIR/server.ts"', loop);
    const sourced = SCRIPT.findIndex((l, n) => n > loop && n < spawn && l.includes('source "$HOME/.topics-server-env"'));
    expect(sourced, "il file di configurazione non viene riletto prima di far ripartire il server").toBeGreaterThan(loop);
    expect(sourced).toBeLessThan(spawn);
  });

  it("un file illeggibile non ferma il riavvio: si tiene l'ambiente di prima", () => {
    const loop = lineOf('while [ "$SHUTTING_DOWN" != 1 ]');
    const spawn = lineOf('"$BUN" run "$APP_DIR/server.ts"', loop);
    const sourced = SCRIPT.findIndex((l, n) => n > loop && n < spawn && l.includes('source "$HOME/.topics-server-env"'));
    expect(SCRIPT[sourced]).toContain("||");
  });
});
