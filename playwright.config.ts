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
  // Misura click → inchiostro sui tre gesti più frequenti e scrive il JSON che
  // `scripts/check-ink-latency.ts` giudica. Il CANCELLO è quello script, non
  // questa spec (che non asserisce nessuna soglia): sul gate PR pagherebbe ~40s
  // per riprovare tre flussi che altre spec già coprono. Nel notturno gira, così
  // l'attrezzo resta vivo e i numeri del giorno restano registrati.
  "ink-latency",
  "browser-ws-streaming",
  "chat-scroll",
  "browser-agent-control",
  "browser-persistence",
  "browser-login-state",
  // Stessa famiglia: apre un Chromium headless SERVER-SIDE. Sotto i quattro
  // shard quel launch va in timeout a 180s (misurato nel log dello shard, 08/08)
  // e il test accusa il broadcast, che non c'entra — non c'era nessun browser da
  // cui potesse partire. Nel notturno gira senza sharding e passa.
  "browser-shared-session",
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
    // Lingua del BROWSER fissata all'italiano.
    //
    // L'app ha una lingua (`lib/i18n.ts`) e il default `auto` segue il browser.
    // Chromium di Playwright parla en-US, quindi senza questa riga la suite
    // vedrebbe l'interfaccia in INGLESE mentre le sue asserzioni sono scritte in
    // italiano — e un rosso del genere non parla del prodotto, parla della
    // lingua della macchina che lancia i test. Misurato il 04/08: convertite le
    // voci del menu tab, 8 test caddero su «Dividi a destra» perche' l'app
    // rendeva «Split right», correttamente.
    locale: "it-IT",
  },
  outputDir: "test-results/artifacts",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      // La spec touch gira nel SUO progetto (sotto), non qui: se girasse in
      // entrambi, l'unico progetto senza `hasTouch` la eseguirebbe con
      // `isTouch === false` e verificherebbe l'esatto contrario di ciò che
      // afferma, in verde.
      //
      // NB — il `testIgnore` di PROGETTO **sostituisce** quello globale (riga 71),
      // non ci si somma: scrivendo qui la sola spec touch, il gate PR tornava a
      // eseguire tutte le NIGHTLY_ONLY_SPECS (file-explorer, cross-feature,
      // cross-window-topic-sync, chat-scroll…) e si riempiva di rossi che il
      // gate esiste apposta per non guardare. La lista va quindi RIPETUTA qui.
      testIgnore: [
        "**/sidebar-touch-audit.spec.ts",
        "**/hover-reveal-touch-audit.spec.ts",
        ...(IS_PR ? NIGHTLY_ONLY_SPECS : []),
      ],
    },
    /**
     * IL DITO NON ERA MAI STATO PROVATO.
     *
     * La suite gira tutta a 1280×800 con un mouse: in ogni test
     * `useMobile().isTouch` è FALSO, quindi long-press, menu «…», bersagli
     * allargati e i rami touch di ogni componente non avevano UNA riga di
     * copertura — mentre l'app è usata da iPhone tutti i giorni. Un progetto
     * dedicato costa un file di test, non una seconda passata della suite:
     * `testMatch` lo tiene su quell'unica spec.
     *
     * `hasTouch` è ciò che accende `navigator.maxTouchPoints`, cioè il segnale
     * su cui `useMobile` decide — senza, il progetto sarebbe solo una viewport
     * stretta e proverebbe metà del problema.
     */
    {
      name: "chromium-touch",
      testMatch: "**/sidebar-touch-audit.spec.ts",
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    /**
     * IL DITO, MA SU UNO SCHERMO LARGO.
     *
     * `isTouch` e `isMobile` sono due domande diverse (vedi `hooks/useMobile.ts`),
     * e il progetto qui sopra le fa insieme: a 390px l'app è in layout mobile,
     * quindi non può provare i rami touch delle superfici che a quella larghezza
     * non esistono — la barra laterale del progetto, il pannello git, la tendina
     * dei rami. Stessi segnali (`hasTouch` + `isMobile` spengono
     * `(hover: hover)`), viewport da desktop: così `useMobile()` risponde
     * `isTouch: true, hasHover: false, isMobile: false`, che è esattamente la
     * combinazione di un tablet con la tastiera staccata — e la popolazione su
     * cui i comandi nascosti dietro l'hover sparivano.
     */
    {
      name: "chromium-touch-wide",
      testMatch: "**/hover-reveal-touch-audit.spec.ts",
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
