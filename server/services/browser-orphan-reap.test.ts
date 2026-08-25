/**
 * @covers RETIRE-06
 */
import { describe, test, expect } from "bun:test";
import {
  reapOrphanBrowsers,
  sweepModeFromEnv,
  psSnapshot,
  type SweepMode,
} from "./browser-orphan-reap";
import { browserMarkArg, parseProcSnapshot, planBootSweep } from "../lib/browser-orphan-sweep";


/** La home nelle fixture e' neutra apposta: le righe vengono da un `ps` vero,
 *  ma questo repo e' PUBBLICO e il nome utente non ci deve finire (il cancello
 *  e' `tests/unit/no-home-paths-tracked.test.ts`). Per la regola il percorso non
 *  conta: conta la FORMA della riga. */
const CASA = "/Users/utente";
const CHROME = `${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const PROFILE = "/var/folders/d8/T/playwright_chromiumdev_profile-zzzzzz";

/** La fotografia che il server troverebbe dopo un `kill -9`: il suo browser di
 *  ieri (server 300, morto) e un chromium estraneo che sta lavorando. */
function psAfterKill9(): string {
  return [
    "    1     0 /sbin/launchd",
    `  900   400 bun run ${CASA}/Projects/topics-app/server.ts`,
    `  700     1 ${CHROME} --remote-debugging-port=19222 ${browserMarkArg("agent", 300)} --user-data-dir=${PROFILE}`,
    `  701     1 ${CHROME} Helper --type=renderer --user-data-dir=${PROFILE}`,
    "  800   799 /opt/homebrew/lib/node_modules/wigolo/chrome-headless-shell --remote-debugging-pipe --user-data-dir=/var/folders/d8/T/playwright_chromiumdev_profile-dV2en6",
  ].join("\n");
}

function harness(mode: SweepMode, ps: string | null = psAfterKill9()) {
  const killed: number[] = [];
  const lines: string[] = [];
  const res = reapOrphanBrowsers({
    snapshot: () => ps,
    kill: (pid) => killed.push(pid),
    ownPid: 900,
    mode,
    log: (m) => lines.push(m),
  });
  return { res, killed, log: lines.join("\n") };
}

describe("reapOrphanBrowsers", () => {
  test("spara sull'orfano e sul suo helper, non sull'estraneo", () => {
    const { res, killed } = harness("sweep");
    expect(killed).toEqual([700, 701]);
    expect(res.killed).toEqual([700, 701]);
    expect(killed).not.toContain(800);
  });

  test("dry: dice tutto e non spara niente", () => {
    const { killed, log, res } = harness("dry");
    expect(killed).toEqual([]);
    expect(res.plan?.kill.map((k) => k.pid)).toEqual([700, 701]);
    expect(log).toContain("DRY");
    expect(log).toContain("kill 700");
  });

  test("off: non guarda nemmeno", () => {
    const { killed, res, log } = harness("off");
    expect(killed).toEqual([]);
    expect(res.plan).toBeNull();
    expect(log).toContain("TOPICS_BROWSER_SWEEP");
  });

  test("un avvio pulito non stampa niente", () => {
    const { killed, log } = harness("sweep", "    1     0 /sbin/launchd\n  900   400 bun run server.ts");
    expect(killed).toEqual([]);
    expect(log).toBe("");
  });

  test("ps muto non e' 'pulito': lo dice e non spara", () => {
    const { killed, res, log } = harness("sweep", null);
    expect(killed).toEqual([]);
    expect(res.plan).toBeNull();
    expect(log).toContain("impossibile leggere i processi");
  });

  test("un pid gia' morto fra il ps e il kill non ferma il resto", () => {
    const killed: number[] = [];
    const res = reapOrphanBrowsers({
      snapshot: psAfterKill9,
      kill: (pid) => {
        if (pid === 700) throw new Error("ESRCH");
        killed.push(pid);
      },
      ownPid: 900,
      mode: "sweep",
      log: () => {},
    });
    expect(killed).toEqual([701]);
    expect(res.killed).toEqual([701]);
  });

  test("il pavimento: launchd, il gruppo intero e noi stessi non partono mai", () => {
    // Un piano non li contiene, e i test della regola lo dicono. Questo prova
    // l'ultima riga prima del grilletto: se un numero sbagliato arrivasse fin
    // qui, non parte. Si costruisce la fotografia in modo che la regola li
    // condanni davvero, cioe' marchiandoli con un server morto.
    const ps = [
      "    1     0 /sbin/launchd " + browserMarkArg("agent", 300),
      `  900   400 bun run server.ts ${browserMarkArg("agent", 300)}`,
      `  700     1 ${CHROME} ${browserMarkArg("agent", 300)}`,
    ].join("\n");
    // Il pavimento non e' un no-op: la regola, da sola, li condanna tutti e tre.
    expect(planBootSweep({ rows: parseProcSnapshot(ps), ownPid: 900 }).kill.map((k) => k.pid)).toEqual([
      1, 700, 900,
    ]);
    const { killed, log } = harness("sweep", ps);
    expect(killed).toEqual([700]);
    expect(log).toContain("RIFIUTATO il pid 1");
    expect(log).toContain("RIFIUTATO il pid 900");
  });
});

describe("sweepModeFromEnv", () => {
  test("di serie spazza", () => {
    for (const v of [undefined, "", "1", "on", "true", "sweep", "boh"]) {
      expect(sweepModeFromEnv(v)).toBe("sweep");
    }
  });
  test("si spegne e si mette a vuoto con le parole che uno scrive davvero", () => {
    for (const v of ["0", "off", "OFF", " false "]) expect(sweepModeFromEnv(v)).toBe("off");
    for (const v of ["dry", "DRY", "dry-run", "dryrun"]) expect(sweepModeFromEnv(v)).toBe("dry");
  });
});

describe("psSnapshot", () => {
  test("legge i processi VERI di questa macchina, e ci trova questo test", () => {
    // La fotografia e' l'unico pezzo che nessun mock puo' provare: se il formato
    // di `ps` non fosse quello che il parser si aspetta, tutto il resto girerebbe
    // su zero righe e direbbe «pulito».
    const raw = psSnapshot();
    expect(raw).not.toBeNull();
    const rows = parseProcSnapshot(raw!);
    expect(rows.length).toBeGreaterThan(10);
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.command).toContain("bun");
  });
});
