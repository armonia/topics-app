/**
 * @covers RETIRE-08
 */
import { describe, test, expect } from "bun:test";
import {
  BROWSER_MARK_FLAG,
  browserMarkArg,
  parseBrowserMark,
  isChromiumHelper,
  userDataDirOf,
  parseProcSnapshot,
  planBootSweep,
  formatSweepPlan,
  type ProcRow,
} from "./browser-orphan-sweep";


/** La home nelle fixture e' neutra apposta: le righe vengono da un `ps` vero,
 *  ma questo repo e' PUBBLICO e il nome utente non ci deve finire (il cancello
 *  e' `tests/unit/no-home-paths-tracked.test.ts`). Per la regola il percorso non
 *  conta: conta la FORMA della riga. */
const CASA = "/Users/utente";
// ─────────────────────────────────────────────────────────────────────────────
// Le righe di comando qui sotto sono COPIATE da un `ps -axo pid=,ppid=,command=`
// vero (macchina di Attilio, 12/08/2026), accorciate solo nei percorsi lunghi.
// Il punto: un parser provato su un formato inventato non prova niente, e la
// forma vera contiene proprio le due trappole di questo lavoro.
//
//   · `chrome_crashpad_handler` gira con ppid 1 e SENZA `--type=`, anche quando
//     il suo browser sta benissimo. Erano i "2 helper di un browser vivo" della
//     misura. Non porta `--user-data-dir` (il suo `--database` è la cartella
//     GLOBALE di Chrome, condivisa fra tutte le istanze), quindi non è
//     attribuibile a nessuno e non si tocca mai.
//   · Playwright dà a ogni lancio un profilo temporaneo UNICO
//     (`/var/folders/.../T/playwright_chromiumdev_profile-XXXXXX`), mentre il
//     nostro sidecar ha un profilo FISSO. Sono i due casi opposti del passo 3
//     della regola.
// ─────────────────────────────────────────────────────────────────────────────

const PW = `${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const HELPER = `${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/147.0.7727.15/Helpers/Google Chrome for Testing Helper.app/Contents/MacOS/Google Chrome for Testing Helper`;
const CRASHPAD = `${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/147.0.7727.15/Helpers/chrome_crashpad_handler`;
const SIDECAR_PROFILE = `${CASA}/.openclaw/chromium-sidecar`;
const TMP_A = "/var/folders/d8/0rlg1q2x64gbx_cn5y2qjf8w0000gn/T/playwright_chromiumdev_profile-aaaaaa";
const TMP_B = "/var/folders/d8/0rlg1q2x64gbx_cn5y2qjf8w0000gn/T/playwright_chromiumdev_profile-bbbbbb";

describe("marchio", () => {
  test("andata e ritorno per i due ruoli", () => {
    expect(browserMarkArg("agent", 4242)).toBe("--topics-browser=agent:4242");
    expect(browserMarkArg("sidecar", 7)).toBe("--topics-browser=sidecar:7");
    expect(parseBrowserMark(`${PW} --headless ${browserMarkArg("agent", 4242)} --no-sandbox`)).toEqual({
      role: "agent",
      ownerPid: 4242,
    });
    expect(parseBrowserMark(`${PW} ${browserMarkArg("sidecar", 7)}`)).toEqual({
      role: "sidecar",
      ownerPid: 7,
    });
  });

  test("il flag è la chiave di pgrep, e vale come prefisso", () => {
    expect(BROWSER_MARK_FLAG).toBe("--topics-browser=");
    expect(browserMarkArg("agent", 1).startsWith(BROWSER_MARK_FLAG)).toBe(true);
  });

  test("niente marchio, marchio storpiato o pid non valido non contano come marchio", () => {
    expect(parseBrowserMark(`${PW} --headless --remote-debugging-port=19222`)).toBeNull();
    expect(parseBrowserMark(`${PW} --topics-browser=agent`)).toBeNull();
    expect(parseBrowserMark(`${PW} --topics-browser=altro:123`)).toBeNull();
    expect(parseBrowserMark(`${PW} --topics-browser=agent:0`)).toBeNull();
    expect(parseBrowserMark(`${PW} --topics-browser=agent:-3`)).toBeNull();
  });
});

describe("i due discriminanti letti dalla riga di comando", () => {
  test("--type= distingue un helper dal processo browser", () => {
    expect(isChromiumHelper(`${HELPER} --type=renderer --user-data-dir=${TMP_A}`)).toBe(true);
    expect(isChromiumHelper(`${HELPER} --type=gpu-process --user-data-dir=${TMP_A}`)).toBe(true);
    expect(isChromiumHelper(`${PW} --headless --user-data-dir=${TMP_A}`)).toBe(false);
  });

  test("crashpad NON è un helper per --type=, e non è attribuibile a nessun profilo", () => {
    const line = `${CRASHPAD} --monitor-self --monitor-self-annotation=ptype=crashpad-handler --database=${CASA}/Library/Application Support/Google/Chrome for Testing/Crashpad --annotation=plat=OS X`;
    expect(isChromiumHelper(line)).toBe(false);
    expect(userDataDirOf(line)).toBeNull();
    expect(parseBrowserMark(line)).toBeNull();
  });

  test("il profilo si legge anche se il percorso contiene spazi", () => {
    expect(userDataDirOf(`${PW} --user-data-dir=${TMP_A} --no-sandbox`)).toBe(TMP_A);
    expect(userDataDirOf(`${PW} --user-data-dir=/Users/mario rossi/Profilo Chrome --no-first-run`)).toBe(
      "/Users/mario rossi/Profilo Chrome",
    );
    expect(userDataDirOf(`${PW} --user-data-dir=${SIDECAR_PROFILE}`)).toBe(SIDECAR_PROFILE);
    expect(userDataDirOf(`${PW} --headless`)).toBeNull();
  });
});

describe("parseProcSnapshot", () => {
  test("legge il formato vero di ps, spazi di allineamento compresi", () => {
    const out = [
      `59415     1 ${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/x --headless=new --remote-debugging-port=9333`,
      " 8157 53649 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer",
      "",
      "  312     1 /sbin/launchd",
    ].join("\n");
    expect(parseProcSnapshot(out)).toEqual([
      {
        pid: 59415,
        ppid: 1,
        command:
          `${CASA}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/x --headless=new --remote-debugging-port=9333`,
      },
      {
        pid: 8157,
        ppid: 53649,
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer",
      },
      { pid: 312, ppid: 1, command: "/sbin/launchd" },
    ]);
  });

  test("uscita vuota non è 'tutto pulito': rowsSeen lo dice", () => {
    expect(parseProcSnapshot("")).toEqual([]);
    const plan = planBootSweep({ rows: parseProcSnapshot(""), ownPid: 999 });
    expect(plan.rowsSeen).toBe(0);
    expect(plan.kill).toEqual([]);
  });
});

/** La macchina di riferimento: tutto quello che gira davvero, in una fotografia. */
function scenario(): ProcRow[] {
  return [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    // Il nostro server VIVO.
    { pid: 500, ppid: 400, command: `bun run ${CASA}/Projects/topics-app/server.ts` },
    // Il browser dell'agente di QUEL server: vivo e legittimo.
    {
      pid: 600,
      ppid: 500,
      command: `${PW} --no-sandbox --remote-debugging-port=19222 ${browserMarkArg("agent", 500)} --user-data-dir=${TMP_A}`,
    },
    { pid: 601, ppid: 600, command: `${HELPER} --type=gpu-process --user-data-dir=${TMP_A}` },
    // Il sidecar di quel server: vivo, profilo FISSO.
    {
      pid: 610,
      ppid: 500,
      command: `${PW} --remote-debugging-port=19333 --user-data-dir=${SIDECAR_PROFILE} ${browserMarkArg("sidecar", 500)} --no-first-run`,
    },
    // Un helper del sidecar vivo, REPARENTATO a launchd. Il caso della misura.
    { pid: 611, ppid: 1, command: `${HELPER} --type=renderer --user-data-dir=${SIDECAR_PROFILE}` },
    // ORFANI: il server 300 non esiste piu' (kill -9).
    {
      pid: 700,
      ppid: 1,
      command: `${PW} --no-sandbox --remote-debugging-port=19222 ${browserMarkArg("agent", 300)} --user-data-dir=${TMP_B}`,
    },
    { pid: 701, ppid: 700, command: `${HELPER} --type=gpu-process --user-data-dir=${TMP_B}` },
    // ...e un suo helper reparentato: il figlio non basta, serve il profilo.
    { pid: 702, ppid: 1, command: `${HELPER} --type=renderer --user-data-dir=${TMP_B}` },
    // Il sidecar dello stesso server morto: stesso profilo FISSO del sidecar vivo.
    {
      pid: 710,
      ppid: 1,
      command: `${PW} --remote-debugging-port=19333 --user-data-dir=${SIDECAR_PROFILE} ${browserMarkArg("sidecar", 300)} --no-first-run`,
    },
    // Crashpad dell'orfano, ppid 1, senza --type= e senza profilo.
    {
      pid: 703,
      ppid: 1,
      command: `${CRASHPAD} --monitor-self --database=${CASA}/Library/Application Support/Google/Chrome for Testing/Crashpad`,
    },
    // ── ESTRANEI, da non toccare mai ──
    // Il chromium di wigolo (Playwright, profilo temporaneo, nessun marchio).
    {
      pid: 800,
      ppid: 799,
      command: `${CASA}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell --remote-debugging-pipe --user-data-dir=/var/folders/d8/T/playwright_chromiumdev_profile-dV2en6`,
    },
    // L'headless su 9333 di origine non attribuita, ppid 1 da 17 ore.
    { pid: 810, ppid: 1, command: `${PW} --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/cft-profile` },
    // Il Chrome dell'utente, con la sua sessione loggata.
    {
      pid: 820,
      ppid: 1,
      command:
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${CASA}/.cache/cdp-mcp/skill-profile --remote-debugging-port=19223`,
    },
  ];
}

describe("planBootSweep", () => {
  const plan = planBootSweep({ rows: scenario(), ownPid: 900 });
  const killed = plan.kill.map((k) => k.pid);

  test("spazza il browser orfano, il suo figlio e il suo helper reparentato", () => {
    expect(killed).toContain(700);
    expect(killed).toContain(701);
    expect(killed).toContain(702);
  });

  test("spazza anche il sidecar orfano, che porta lo stesso marchio", () => {
    expect(killed).toContain(710);
  });

  test("risparmia tutto quello che appartiene a un server VIVO", () => {
    expect(killed).not.toContain(600);
    expect(killed).not.toContain(601);
    expect(killed).not.toContain(610);
  });

  test("l'helper reparentato del sidecar VIVO si salva: il profilo fisso è condiviso", () => {
    // È la trappola: 710 (morto) e 610 (vivo) hanno lo stesso --user-data-dir.
    // Allargarsi per profilo lì ucciderebbe l'helper del vivo.
    expect(killed).not.toContain(611);
    expect(plan.spared.map((s) => s.why).join(" ")).toContain("condiviso");
  });

  test("un chromium senza il nostro marchio non si tocca mai", () => {
    for (const estraneo of [800, 810, 820]) expect(killed).not.toContain(estraneo);
  });

  test("crashpad non si tocca: non è attribuibile, e muore da solo col suo browser", () => {
    expect(killed).not.toContain(703);
  });

  test("la lista è esattamente quella, ordinata", () => {
    expect(killed).toEqual([700, 701, 702, 710]);
    expect(plan.markedBrowsers).toBe(4);
    expect(plan.rowsSeen).toBe(scenario().length);
  });

  test("il log nomina i pid e i motivi", () => {
    const s = formatSweepPlan(plan, "sweep");
    expect(s).toContain("4 chromium marchiati");
    expect(s).toContain("4 da spazzare");
    expect(s).toContain("kill 700");
    expect(s).toContain("kill 702");
    expect(s).toContain("salvo 600");
    expect(formatSweepPlan(plan, "dry")).toContain("DRY");
  });
});

describe("i casi limite che decidono se la regola è sicura", () => {
  test("nessun marchio in giro: piano vuoto, e si vede che ha guardato", () => {
    const rows = scenario().filter((r) => !parseBrowserMark(r.command));
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill).toEqual([]);
    expect(plan.markedBrowsers).toBe(0);
    expect(plan.rowsSeen).toBeGreaterThan(5);
  });

  test("un browser marchiato col NOSTRO pid, all'avvio, è un pid riciclato: si spazza", () => {
    // Al boot non abbiamo ancora aperto niente, quindi nessun browser vivo può
    // legittimamente portare il nostro numero.
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 900, ppid: 400, command: "bun run server.ts" },
      {
        pid: 950,
        ppid: 1,
        command: `${PW} ${browserMarkArg("agent", 900)} --user-data-dir=${TMP_A}`,
      },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill.map((k) => k.pid)).toEqual([950]);
    expect(plan.kill[0]!.why).toContain("riciclato");
  });

  test("ppid 1 NON vuol dire orfano: col server vivo si salva", () => {
    // È il contratto per cui il marchio porta dentro il pid del server invece di
    // guardare il padre. Che un NOSTRO processo giri con ppid 1 mentre il suo
    // browser sta benissimo è misurato (12/08: due helper del Chrome vivo erano
    // già reparentati a launchd), e basta uno spawn `detached` in più perché
    // capiti anche al processo browser. Una regola su ppid == 1 qui spara.
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 500, ppid: 400, command: "bun run server.ts" },
      {
        pid: 600,
        ppid: 1,
        command: `${PW} ${browserMarkArg("sidecar", 500)} --user-data-dir=${SIDECAR_PROFILE}`,
      },
      { pid: 601, ppid: 1, command: `${HELPER} --type=renderer --user-data-dir=${SIDECAR_PROFILE}` },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill).toEqual([]);
    expect(plan.spared.map((s) => s.pid)).toEqual([600]);
  });

  test("un orfano con un padre VIVO che non è il suo server si spazza lo stesso", () => {
    // Lo specchio del test qui sopra. Il browser è figlio di start-prod.sh (che
    // è vivo e rilancia il server), ma il server che l'aveva aperto è morto:
    // nessuno lo governa più. Una regola su ppid == 1 qui lo lascia lì.
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 400, ppid: 1, command: `/bin/bash ${CASA}/Projects/topics-app/scripts/start-prod.sh` },
      { pid: 500, ppid: 400, command: "bun run server.ts" }, // il server NUOVO
      {
        pid: 600,
        ppid: 400,
        command: `${PW} ${browserMarkArg("agent", 300)} --user-data-dir=${TMP_A}`,
      },
    ];
    const plan = planBootSweep({ rows, ownPid: 500 });
    expect(plan.kill.map((k) => k.pid)).toEqual([600]);
  });

  test("due server vivi in parallelo si risparmiano a vicenda", () => {
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 500, ppid: 400, command: "bun run server.ts" }, // prod
      { pid: 501, ppid: 400, command: "bun run server.ts" }, // worktree
      {
        pid: 600,
        ppid: 500,
        command: `${PW} ${browserMarkArg("agent", 500)} --user-data-dir=${TMP_A}`,
      },
      {
        pid: 601,
        ppid: 501,
        command: `${PW} ${browserMarkArg("agent", 501)} --user-data-dir=${TMP_B}`,
      },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill).toEqual([]);
    expect(plan.spared.map((s) => s.pid)).toEqual([600, 601]);
  });

  test("un helper che PORTASSE il marchio non si giudica da solo", () => {
    // Chromium non propaga gli switch che non conosce, quindi in pratica non
    // capita. Se capitasse, un helper con owner morto NON deve essere il motivo
    // per cui si spara: il giudizio è sempre del browser.
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      {
        pid: 700,
        ppid: 1,
        command: `${HELPER} --type=renderer ${browserMarkArg("agent", 300)} --user-data-dir=${TMP_B}`,
      },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill).toEqual([]);
    expect(plan.markedBrowsers).toBe(0);
  });

  test("chrome-headless-shell: gli helper NON portano il profilo, si prendono per padre", () => {
    // Misurato il 12/08: gli helper del `chrome-headless-shell` (la famiglia che
    // Playwright usa per l'headless) girano con `--type=gpu-process` e
    // `--type=utility` e SENZA `--user-data-dir`, mentre quelli di «Chrome for
    // Testing» ce l'hanno. Due famiglie, due sole strade per raggiungere i
    // pezzi: il profilo per una, il padre per l'altra. Servono entrambe.
    const SHELL =
      `${CASA}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      {
        pid: 700,
        ppid: 1,
        command: `${SHELL} --remote-debugging-port=19222 ${browserMarkArg("agent", 300)} --user-data-dir=${TMP_B}`,
      },
      { pid: 701, ppid: 700, command: `${SHELL} --type=gpu-process --no-sandbox --headless` },
      {
        pid: 702,
        ppid: 700,
        command: `${SHELL} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US`,
      },
      // Stessa forma, ma di un browser che non è nostro: nessun legame, si salva.
      { pid: 801, ppid: 800, command: `${SHELL} --type=gpu-process --no-sandbox --headless` },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill.map((k) => k.pid)).toEqual([700, 701, 702]);
  });

  test("un orfano senza --user-data-dir si spazza da solo, senza allargarsi", () => {
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 700, ppid: 1, command: `${PW} --headless ${browserMarkArg("agent", 300)}` },
      { pid: 800, ppid: 1, command: `${PW} --headless --user-data-dir=/tmp/estraneo` },
    ];
    const plan = planBootSweep({ rows, ownPid: 900 });
    expect(plan.kill.map((k) => k.pid)).toEqual([700]);
  });
});
