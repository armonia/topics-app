/**
 * A node whose wakes keep failing is not picked as a sleeping target.
 * 2026-11-10: the PC stuck at the login screen got 17 cards in half an hour.
 *
 * And an open window survives a restart of the server: production restarts at
 * every land that touches `server/`, and each restart used to hand the broken
 * node a fresh try (21/11: 27 cards moved onto one broken PC in a day). A
 * restart is simulated here by creating the breaker again on the same file.
 *
 * @covers KANBAN-76
 */
import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";
import { createWakeBreaker, NODE_BREAKERS_FILE, WAKE_OPEN_BASE_MS } from "./wake-breaker";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const pc: OverflowMachine = { id: "pc", name: "PC", kind: "node", online: false, wakeable: true };
const opts = { cloudCredit: false, githubOrigin: false, model: null, load: () => 0 };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A breaker file in a fresh temp dir, never the server's real one. */
function breakerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wake-breaker-"));
  dirs.push(dir);
  return join(dir, "state", "node-breakers.json");
}
/** The server starting again: a new breaker on the same file. */
function restart(name: string, file: string, clock: { t: number }) {
  const b = createWakeBreaker(name, () => clock.t);
  b.persistTo(file);
  return b;
}

test("two failed wakes in a row: the sleeping PC is no longer a target, until the window ends", () => {
  const clock = { t: 0 };
  const b = createWakeBreaker("wake", () => clock.t);
  const pick = () => pickOverflowMachine([pc], { ...opts, wakeBlocked: (id) => b.isOpen(id) });
  expect(pick()?.id).toBe("pc");
  b.failure("pc");
  expect(pick()?.id).toBe("pc");
  b.failure("pc");
  expect(pick()).toBeNull();
  clock.t += WAKE_OPEN_BASE_MS + 1;
  expect(pick()?.id).toBe("pc");
  b.failure("pc"); // third failure: the window doubles
  clock.t += WAKE_OPEN_BASE_MS + 1;
  expect(pick()).toBeNull();
  b.success("pc");
  expect(pick()?.id).toBe("pc");
});

test("riavvio a finestra aperta: il freno ricreato dallo stesso file resta aperto fino alla scadenza, e il conto continua", () => {
  const clock = { t: 1_000_000 };
  const file = breakerFile();
  const before = restart("wake", file, clock);
  before.failure("pc");
  before.failure("pc");
  const until = before.openUntil("pc");

  clock.t += 60_000;
  const after = restart("wake", file, clock);
  expect(after.isOpen("pc")).toBe(true);
  expect(after.openUntil("pc")).toBe(until);

  clock.t = until! + 1;
  expect(after.isOpen("pc")).toBe(false);
  // The failure count came through the restart: the next failure doubles the window.
  after.failure("pc");
  expect(after.openUntil("pc")).toBe(clock.t + 2 * WAKE_OPEN_BASE_MS);
  // A run that starts closes it, and the restart after that sees it closed.
  after.success("pc");
  expect(restart("wake", file, clock).isOpen("pc")).toBe(false);
});

test("una finestra già scaduta al riavvio si scarta: il nodo riparte da zero", () => {
  const clock = { t: 1_000_000 };
  const file = breakerFile();
  const before = restart("wake", file, clock);
  before.failure("pc");
  before.failure("pc");

  clock.t = before.openUntil("pc")! + 1;
  const after = restart("wake", file, clock);
  expect(after.isOpen("pc")).toBe(false);
  // Dropped, not carried: one failure is below the threshold again.
  after.failure("pc");
  expect(after.isOpen("pc")).toBe(false);
});

test("file assente o corrotto: stato vuoto, mai un'eccezione, e la prossima scrittura lo rifà valido", () => {
  const clock = { t: 1_000_000 };
  for (const content of [null, "{ non è json"]) {
    const file = breakerFile();
    if (content !== null) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
    const b = restart("wake", file, clock);
    expect(b.isOpen("pc")).toBe(false);
    b.failure("pc");
    b.failure("pc");
    expect(restart("wake", file, clock).isOpen("pc")).toBe(true);
  }
});

test("i due freni condividono il file senza cancellarsi a vicenda", () => {
  const clock = { t: 1_000_000 };
  const file = breakerFile();
  const wake = restart("wake", file, clock);
  const hang = restart("hang", file, clock);
  wake.failure("pc");
  wake.failure("pc");
  hang.failure("node-2");
  hang.failure("node-2");

  expect(restart("wake", file, clock).isOpen("pc")).toBe(true);
  expect(restart("hang", file, clock).isOpen("node-2")).toBe(true);
  // Each breaker reads its own section: the PC is not hung, node-2 does wake.
  expect(restart("hang", file, clock).isOpen("pc")).toBe(false);
  expect(restart("wake", file, clock).isOpen("node-2")).toBe(false);
});

test("il file dei freni sta nella radice del checkout in produzione: git lo ignora", () => {
  // An untracked file in the production checkout root holds every land shut (17/09, mem-samples.json).
  const r = Bun.spawnSync(["git", "check-ignore", "-q", NODE_BREAKERS_FILE], { cwd: join(import.meta.dir, "..", ".."), env: gitEnv() });
  expect(r.exitCode).toBe(0);
});
