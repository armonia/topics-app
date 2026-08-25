/**
 * La diagnosi serve una volta al mese e deve essere giusta QUELLA volta: il
 * resto del tempo nessuno la guarda, e un messaggio che accusa la run sbagliata
 * costa più del silenzio. Qui si inchiodano le due decisioni che contano —
 * quando TACERE (server vivo: l'errore è vero, va lasciato intatto) e quando
 * puntare il dito su un'altra run.
  * @covers E2E-GATE-05
 */
import { describe, it, expect } from "bun:test";
import {
  describeServerDeath,
  runLockStolenBy,
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
      probe({ runLockRaw: lockOf(12345), portHolders: [{ pid: 777, cmd: "bun run server.ts" }] }),
      PORT,
    )!;
    expect(msg).toContain("PID 777");
    expect(msg).toContain("bun run server.ts");
  });

  // Il caso che la prima versione sbagliava, e che una suite verde ha smascherato:
  // `terminal-session-resume.spec.ts` (AC-2) ammazza il server e ne spawna un
  // altro *detached*. Da quel momento `__TEST_SERVER_PID` punta a un processo
  // morto per tutti i ~70 test che restano — e una diagnosi che guarda solo quel
  // PID accuserebbe una morte a ogni errore di rete fino a fine run.
  it("PID noto morto ma la porta risponde e il lock è nostro: è un RIAVVIO, non una morte", () => {
    const p = probe({
      serverPid: 4242,
      serverAlive: false,
      runLockRaw: lockOf(999),
      portHolders: [{ pid: 5150, cmd: "bun run server.ts" }],
    });
    expect(describeServerDeath(p, PORT)).toBeNull();
  });

  it("porta USURPATA: non dice «non c'è più», dice che il database non è il nostro", () => {
    const msg = describeServerDeath(
      probe({ runLockRaw: lockOf(12345), portHolders: [{ pid: 777, cmd: "bun run server.ts" }] }),
      PORT,
    )!;
    expect(msg).not.toContain("NON C'È PIÙ");
    expect(msg).toContain("UN'ALTRA RUN");
    expect(msg).toContain("DATABASE");
  });

  it("il furto si dichiara anche se il NOSTRO server è ancora vivo — sta per morire", () => {
    const p = probe({ serverAlive: true, runLockRaw: lockOf(12345) });
    expect(describeServerDeath(p, PORT)).toContain("un'ALTRA run E2E");
  });
});

describe("runLockStolenBy", () => {
  const withEnv = (ourPid: string | undefined, fn: () => void) => {
    const saved = process.env.__E2E_RUN_LOCK_PID;
    if (ourPid === undefined) delete process.env.__E2E_RUN_LOCK_PID;
    else process.env.__E2E_RUN_LOCK_PID = ourPid;
    try { fn(); } finally {
      if (saved === undefined) delete process.env.__E2E_RUN_LOCK_PID;
      else process.env.__E2E_RUN_LOCK_PID = saved;
    }
  };

  it("tace se non sappiamo di chi sia il lock — fuori dal globalSetup non si accusa", () => {
    withEnv(undefined, () => {
      expect(runLockStolenBy(PORT)).toBeNull();
    });
  });

  it("tace se il lock non c'è: è un indizio, e qui i falsi positivi costano troppo", () => {
    // Porta 1: nessuna run ci ha mai scritto un lock.
    withEnv("999", () => {
      expect(runLockStolenBy(1)).toBeNull();
    });
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
