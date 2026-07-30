/**
 * La diagnosi serve una volta al mese e deve essere giusta QUELLA volta: il
 * resto del tempo nessuno la guarda, e un messaggio che accusa la run sbagliata
 * costa più del silenzio. Qui si inchiodano le due decisioni che contano —
 * quando TACERE (server vivo: l'errore è vero, va lasciato intatto) e quando
 * puntare il dito su un'altra run.
 */
import { describe, it, expect } from "bun:test";
import {
  describeServerDeath,
  withServerDeathDiagnosis,
  type DeathProbe,
} from "../e2e/helpers/server-death";

const PORT = 13334;

const probe = (over: Partial<DeathProbe> = {}): DeathProbe => ({
  serverPid: 4242,
  serverAlive: false,
  runLockRaw: null,
  ourRunPid: 999,
  portHolders: [],
  ...over,
});

const lockOf = (pid: number, cwd = "/Users/x/altro-checkout") =>
  JSON.stringify({ pid, startedAt: "2026-07-30T23:55:00.000Z", cwd, port: PORT });

describe("describeServerDeath", () => {
  it("tace se il server è vivo — l'errore che ha portato qui è vero", () => {
    expect(describeServerDeath(probe({ serverAlive: true }), PORT)).toBeNull();
  });

  it("tace se non sa nulla del server ma qualcuno risponde sulla porta", () => {
    const p = probe({ serverPid: null, portHolders: [{ pid: 7, cmd: "bun run server.ts" }] });
    expect(describeServerDeath(p, PORT)).toBeNull();
  });

  it("accusa l'altra run quando il lock ha cambiato proprietario", () => {
    const msg = describeServerDeath(probe({ runLockRaw: lockOf(12345) }), PORT);
    expect(msg).toContain("un'ALTRA run E2E");
    expect(msg).toContain("12345");
    expect(msg).toContain("/Users/x/altro-checkout");
    // Il rimedio deve essere nel messaggio: la diagnosi senza la via d'uscita
    // costringe comunque a cercare.
    expect(msg).toContain("E2E_PORT=");
  });

  it("il lock sparito è un indizio, non una certezza — lo dice come tale", () => {
    const msg = describeServerDeath(probe({ runLockRaw: null }), PORT)!;
    expect(msg).toContain("CAUSA PROBABILE");
  });

  it("lock ancora NOSTRO: non incolpa nessuno, manda a leggere il log", () => {
    const msg = describeServerDeath(probe({ runLockRaw: lockOf(999) }), PORT)!;
    expect(msg).not.toContain("un'ALTRA run E2E");
    expect(msg).toContain("[test-server]");
  });

  it("elenca chi tiene la porta adesso, con la sua riga di comando", () => {
    const msg = describeServerDeath(
      probe({ portHolders: [{ pid: 777, cmd: "bun run server.ts" }] }),
      PORT,
    )!;
    expect(msg).toContain("PID 777");
    expect(msg).toContain("bun run server.ts");
  });
});

describe("withServerDeathDiagnosis", () => {
  it("lascia passare INTATTO ciò che non è un errore di connessione", () => {
    const err = new Error("expect(received).toBe(expected)");
    expect(withServerDeathDiagnosis(err, PORT)).toBe(err);
  });

  it("lascia passare intatto anche un ECONNREFUSED se il server è VIVO", () => {
    // Il PID di questo processo è vivo per definizione: la sonda vede un server
    // in piedi e non deve dichiarare nessuna morte. È il caso che protegge i
    // rossi legittimi (un ECONNREFUSED verso un servizio esterno, per dire) dal
    // farsi seppellire sotto una diagnosi sbagliata.
    const saved = process.env.__TEST_SERVER_PID;
    process.env.__TEST_SERVER_PID = String(process.pid);
    try {
      const err = new Error("connect ECONNREFUSED ::1:1");
      expect(withServerDeathDiagnosis(err, 1)).toBe(err);
    } finally {
      if (saved === undefined) delete process.env.__TEST_SERVER_PID;
      else process.env.__TEST_SERVER_PID = saved;
    }
  });

  it("wrappa l'ECONNREFUSED quando il server è DAVVERO morto, senza perdere l'originale", () => {
    const saved = process.env.__TEST_SERVER_PID;
    // PID 2^31-1: fuori dallo spazio dei PID di macOS, quindi certo di non esistere.
    process.env.__TEST_SERVER_PID = "2147483647";
    try {
      const err = new Error("connect ECONNREFUSED ::1:1");
      const out = withServerDeathDiagnosis(err, 1) as Error;
      expect(out).not.toBe(err);
      expect(out.message).toContain("IL SERVER DI TEST NON C'È PIÙ");
      expect(out.message).toContain("connect ECONNREFUSED ::1:1");
    } finally {
      if (saved === undefined) delete process.env.__TEST_SERVER_PID;
      else process.env.__TEST_SERVER_PID = saved;
    }
  });
});
