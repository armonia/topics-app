import { defineConfig } from "@playwright/test";
import { E2E_BASE } from "./tests/e2e/helpers/test-server";

// Two-tier E2E: the PR gate runs a fast, deterministic subset; the full suite —
// including slow/perf/network/two-window/reload-persistence specs — runs nightly
// (see .github/workflows/e2e-nightly.yml). Set E2E_TIER=pr to gate mode.
//
// Whole files that are heavy, threshold-based, network-dependent, or flaky-by-
// design go nightly-only; a handful of individual reload-persistence tests in
// otherwise-PR files are tagged `@nightly` and excluded via grepInvert below.
// Coverage isn't lost — nightly runs everything; it's just off the PR path.
const IS_PR = process.env.E2E_TIER === "pr";
const NIGHTLY_ONLY_SPECS = [
  "performance",
  "browser-ws-streaming",
  "chat-scroll",
  "browser-agent-control",
  "browser-persistence",
  "browser-login-state",
  "terminal-session-resume",
  "worktree-domain",
  "screenshot-evidence",
  "cross-feature",
  "layout-edge-cases",
  "cross-window-topic-sync",
  "split-screen-sync",
  "pane-server-migration",
  // La famiglia file-explorer condivide un progetto/DB fra i test; su CI Linux
  // lo stato accumulato disegnava un secondo albero, i locator treeitem ne
  // trovavano >1 e il fallimento cascava di test in test (mettere in quarantena
  // uno lo spostava sul successivo).
  // L'isolamento c'è (fixtures/hermetic.ts: ogni FILE riparte dallo snapshot di
  // baseline del globalSetup, vedi services/db-snapshot.ts), ma è per-file, non
  // per-test: dentro lo stesso file lo stato scorre ancora — ed è voluto, quasi
  // tutte le suite sono `describe.serial` e si passano il topic creato nel
  // beforeAll. Restano quindi fuori dal gate PR finché non sono riscritte
  // test-per-test. TODO(e2e-isolation).
  //
  // `file-explorer` è stato spezzato in tre file per tema (era 22 test / 138s in
  // uno solo, il pavimento dello sharding — vedi helpers/file-project.ts). Ora
  // ognuno ha il SUO progetto seminato, il che toglie l'interferenza FRA i tre;
  // dentro ciascuno lo stato scorre ancora esattamente come prima, quindi la
  // ragione di questa esclusione non è cambiata e valgono tutti e tre.
  "file-explorer",
  "file-explorer-git",
  "file-explorer-panels",
  "file-context-menu",
  "file-external-drop",
].map((name) => `**/${name}.spec.ts`);

// ── Velocità vs. evidenza ────────────────────────────────────────────────────
// Il default è VELOCE. La modalità "guardabile" (slowMo + video su OGNI test)
// serve a produrre le clip di consegna richieste dal protocollo board, non a
// ogni verifica: si attiva con E2E_EVIDENCE=1.
//
// `slowMo` mette una pausa davanti a OGNI azione del protocollo. A 300 ms, con
// ~845 azioni statiche nella suite (click/fill/press/…), sono >4 minuti di sleep
// puro per passata prima ancora di contare loop e helper condivisi: il singolo
// costo più grosso della suite. Non è un meccanismo di stabilità — un test che
// regge solo grazie a slowMo sta nascondendo una race che va risolta con
// un'attesa condizionale, non con una pausa fissa.
//
// `video: "on"` registra e SALVA una clip anche per i test verdi, che nessuno
// guarda; "retain-on-failure" tiene solo quelle diagnosticamente utili.
const EVIDENCE = process.env.E2E_EVIDENCE === "1";

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",
  testIgnore: IS_PR ? NIGHTLY_ONLY_SPECS : [],
  grepInvert: IS_PR ? /@nightly/ : undefined,
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // sequential to avoid race conditions on shared DB
  workers: 1, // single worker: shared DB + capped CPU (avoids the headless-Chrome swarm that pegs the machine)
  retries: IS_PR ? 2 : 1, // PR gate absorbs residual flakiness under CI contention
  // Fail-fast in locale, quadro completo su CI.
  //
  // Quando il server di test muore — o la macchina è troppo carica per farlo
  // rispondere — OGNI test successivo fallisce con `ECONNREFUSED :13334`, e il
  // riepilogo dice "16 passed, 424 did not run" senza mai nominare la causa. Per
  // scoprirla bisogna aprire uno degli 88 artifact e leggere l'errore: un'ora
  // buttata a triagiare fallimenti che sono tutti lo stesso, e nel frattempo un
  // rosso da infrastruttura è indistinguibile da 88 regressioni vere.
  //
  // Otto fallimenti bastano a distinguere "qualcosa è rotto nel codice" da "il
  // server non c'è": nel secondo caso ci si arriva in un minuto invece che in
  // diciassette. Su CI resta 0 (nessun limite), perché il nightly serve proprio
  // a vedere TUTTO quello che è rotto in una passata.
  maxFailures: process.env.CI ? 0 : 8,
  reporter: [
    ["html", { outputFolder: "test-results/html-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: E2E_BASE,
    video: EVIDENCE ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    viewport: { width: 1280, height: 800 },
    launchOptions: EVIDENCE ? { slowMo: 300 } : {},
    permissions: ["clipboard-read", "clipboard-write"],
  },
  outputDir: "test-results/artifacts",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
