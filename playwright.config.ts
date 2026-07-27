import { defineConfig } from "@playwright/test";

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
  // The file-explorer family shares one project/DB across tests; on CI Linux
  // the accumulated state renders a second tree, so treeitem locators resolve
  // to >1 element and the failure cascades test-to-test (quarantining one just
  // shifts it to the next). Off the PR gate as a class until the suite gets
  // per-test DB isolation. TODO(e2e-isolation).
  "file-explorer",
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
  reporter: [
    ["html", { outputFolder: "test-results/html-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: "http://localhost:13334",
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
