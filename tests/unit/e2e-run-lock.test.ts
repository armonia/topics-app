/**
 * Il difetto che questo lock chiude non si vede in nessun test rosso: si vede
 * in una run che muore per un motivo che non ha nulla a che fare col codice
 * sotto test (SIGTERM mai emesso + `SQLITE_IOERR_VNODE` su ogni query). Qui si
 * inchioda la sola cosa che conta: quando ci si ferma e quando si prosegue.
  * @covers E2E-GATE-05
 */
import { describe, it, expect } from "bun:test";
import {
  LOCK_MAX_AGE_MS,
  acquireRunLock,
  decideLock,
  lockPathForPort,
  refusalMessage,
  releaseRunLock,
  type LockFs,
  type LockRecord,
} from "../e2e/helpers/run-lock";

function memFs(seed: Record<string, string> = {}): LockFs & { raw: Map<string, string> } {
  const raw = new Map<string, string>(Object.entries(seed));
  return {
    raw,
    read: (p) => raw.get(p) ?? null,
    write: (p, c) => void raw.set(p, c),
    remove: (p) => void raw.delete(p),
  };
}

const NOW = 1_800_000_000_000;
const rec = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: 4242,
  startedAt: new Date(NOW - 60_000).toISOString(),
  cwd: "/Users/x/Projects/topics-app",
  port: 13334,
  ...over,
});
const self = rec({ pid: process.pid, startedAt: new Date(NOW).toISOString() });
const alive = () => true;
const dead = () => false;

describe("decisione sul lock", () => {
  it("nessun lock ⇒ si prende", () => {
    expect(decideLock(null, self, alive, NOW)).toEqual({ action: "acquire", reason: "free" });
  });

  it("un lock VIVO e recente ⇒ ci si ferma", () => {
    // È il caso reale: una seconda run partita mentre la prima gira.
    const d = decideLock(JSON.stringify(rec()), self, alive, NOW);
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.holder.pid).toBe(4242);
  });

  it("un lock il cui PID è morto ⇒ residuo, si prende", () => {
    const d = decideLock(JSON.stringify(rec()), self, dead, NOW);
    expect(d).toMatchObject({ action: "acquire", reason: "dead" });
  });

  it("PID vivo ma lock vecchio di ore ⇒ PID riciclato, si prende", () => {
    // Nessuna suite dura sei ore; su macOS i PID si riciclano. Senza questa
    // via d'uscita un crash duro renderebbe la porta inutilizzabile finché
    // qualcuno non cancella il file a mano.
    const vecchio = rec({ startedAt: new Date(NOW - LOCK_MAX_AGE_MS - 1).toISOString() });
    expect(decideLock(JSON.stringify(vecchio), self, alive, NOW)).toMatchObject({
      action: "acquire",
      reason: "expired",
    });
  });

  it("un lock corrotto non rende la suite inavviabile per sempre", () => {
    expect(decideLock("{non json", self, alive, NOW)).toEqual({ action: "acquire", reason: "unreadable" });
  });

  it("il proprio PID non blocca se stesso", () => {
    expect(decideLock(JSON.stringify(self), self, alive, NOW)).toMatchObject({ action: "acquire", reason: "self" });
  });
});

describe("acquisizione e rilascio", () => {
  it("acquisire scrive un record leggibile con PID, cwd e porta", () => {
    const fs = memFs();
    const r = acquireRunLock(13334, { fs, isAlive: dead, now: NOW, log: () => {} });
    expect(r.pid).toBe(process.pid);
    expect(JSON.parse(fs.raw.get(lockPathForPort(13334))!)).toMatchObject({ pid: process.pid, port: 13334 });
  });

  it("acquisire LANCIA se un'altra run è viva — prima che parta un solo test", () => {
    const fs = memFs({ [lockPathForPort(13334)]: JSON.stringify(rec()) });
    expect(() => acquireRunLock(13334, { fs, isAlive: alive, now: NOW, log: () => {} })).toThrow(/PID 4242/);
    // E il lock dell'altra run resta intatto: non si sfila mai niente a chi c'era prima.
    expect(JSON.parse(fs.raw.get(lockPathForPort(13334))!).pid).toBe(4242);
  });

  it("il messaggio dice porta, chi la tiene e come girare in parallelo", () => {
    const m = refusalMessage(rec(), 13334);
    expect(m).toContain("13334");
    expect(m).toContain("PID 4242");
    expect(m).toContain("E2E_PORT=");
  });

  it("porte diverse non si bloccano a vicenda (E2E_PORT è la via d'uscita)", () => {
    const fs = memFs({ [lockPathForPort(13334)]: JSON.stringify(rec()) });
    expect(() => acquireRunLock(13344, { fs, isAlive: alive, now: NOW, log: () => {} })).not.toThrow();
  });

  it("rilasciare toglie il lock nostro", () => {
    const fs = memFs();
    acquireRunLock(13334, { fs, isAlive: dead, now: NOW, log: () => {} });
    releaseRunLock(13334, { fs });
    expect(fs.raw.has(lockPathForPort(13334))).toBe(false);
  });

  it("rilasciare NON tocca il lock di un altro", () => {
    // Se il nostro era scaduto e l'ha rilevato una terza run, cancellarlo
    // riaprirebbe esattamente il buco che questo file chiude.
    const fs = memFs({ [lockPathForPort(13334)]: JSON.stringify(rec({ pid: 9999 })) });
    releaseRunLock(13334, { fs });
    expect(fs.raw.has(lockPathForPort(13334))).toBe(true);
  });
});
