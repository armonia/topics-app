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
  // Stessa famiglia, stessa ragione: il prologo aspetta che il server lanci un
  // Chromium headless e ci navighi dentro due volte prima di poter filmare.
  "browser-forget-site-shared",
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
  // Dipende da un motore STT raggiungibile (ElevenLabs o whisper locale) e
  // asserisce sul comportamento del provider reale: va bene nel notturno, non
  // nel gate PR dove il server di test gira senza chiavi e senza modelli.
  // Il tag @nightly nel titolo gia' esclude i singoli test con grepInvert,
  // ma senza questa riga il FILE rimane in testIgnore=[] e viene scoperto
  // ugualmente: il filtro grepInvert salta i test, non i file, quindi il
  // beforeAll (che chiama /api/stt/capabilities) gira comunque.
  "dictation-real-mic",
].map((name) => `**/${name}.spec.ts`);

// ── Velocità vs. evidenza ────────────────────────────────────────────────────
// Il default è VELOCE. `E2E_EVIDENCE=1` accende trace e video su OGNI test, per
// produrre le clip di consegna richieste dal protocollo board — non serve a ogni
// verifica.
//
// NON accende più `slowMo`: quello ha il suo interruttore (`E2E_SLOWMO=1`, più
// sotto) perché è il pezzo che costa, e il perché è misurato lì.
//
// `video: "on"` registra e SALVA una clip anche per i test verdi, che nessuno
// guarda; "retain-on-failure" tiene solo quelle diagnosticamente utili.
const EVIDENCE = process.env.E2E_EVIDENCE === "1";

// I TRE PEZZI DELL'EVIDENZA SI PAGANO SEPARATAMENTE, perché costano in modo
// molto diverso e servono a cose diverse.
//
//   trace   la sessione riproducibile: DOM, rete, console, e uno screenshot per
//           ogni azione. È ciò che si apre per capire COSA è successo, ed è
//           anche la fonte da cui si può ricavare un filmato dopo, quando
//           serve davvero (`npx playwright show-trace`).
//   video   la clip .webm. Bella da guardare, ma in buona parte una copia di
//           ciò che il trace ha già: gli screenshot per azione ci sono.
//   slowMo  300 ms davanti a OGNI azione. Non è una prova, è un rallentatore
//           perché il filmato sia guardabile da un umano.
//
// `E2E_NO_VIDEO=1` toglie la clip e tiene il trace. `E2E_NO_SLOWMO=1` toglie la
// pausa. Servono a rispondere con una misura, invece che a occhio, alla domanda
// «quanto ci costa l'evidenza e quale pezzo».
const NO_VIDEO = process.env.E2E_NO_VIDEO === "1";

// SLOWMO NON È PIÙ ACCESO DALL'EVIDENZA: va chiesto, con `E2E_SLOWMO=1`.
//
// Misurato due volte sullo stesso campione di 31 test, questa macchina:
//
//   senza evidenza                     68s / 69s
//   evidenza SENZA slowMo (trace+video) 75s / 76s   <- +10%: quasi gratis
//   evidenza com'era (con slowMo)      211s         <- 3,1x
//
// Il video e il trace insieme costano il 10%. Lo slowMo da solo vale 136 dei
// 143 secondi di sovrapprezzo, cioè il 95%: sono 300 ms davanti a OGNI azione,
// e con ~845 azioni statiche nella suite fanno oltre quattro minuti di pausa
// pura per passata, prima ancora di contare i cicli negli helper.
//
// E non è una prova: è un rallentatore perché la clip sia guardabile da un
// umano. Il trace registra comunque uno screenshot per azione, quindi ciò che
// è successo si vede lo stesso — e se serve un filmato a velocità umana lo si
// rigenera dopo, sul singolo test, invece di pagarlo su tutti e 1120.
//
// Il valore vecchio resta a un tasto di distanza (`E2E_SLOWMO=1`) per quando
// una clip va davvero girata per un umano.
const SLOWMO = process.env.E2E_SLOWMO === "1";

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
    /**
     * Un'azione ha un limite, e prima non ce l'aveva.
     *
     * Il default di Playwright per `actionTimeout` è **0, cioè nessun limite**: un
     * `click()` su un elemento che non diventerà mai cliccabile non fallisce, resta
     * lì finché scade il TEST. Il rosso che ne esce si intesta al test
     * (`locator.click: Test timeout of 30000ms exceeded`) invece che all'azione:
     * il call log col locator c'è ancora, ma il tempo se l'è preso tutto l'ultima
     * azione e ogni assert successivo non viene mai eseguito, quindi il test
     * racconta un solo sintomo invece dei suoi.
     *
     * E dove il test si alza il proprio timeout non resta nemmeno quello. Il
     * 2026-08-15 `long-session-growth.spec.ts` è stato fermo VENTICINQUE MINUTI
     * senza scrivere un artefatto, perché si dà 1.500.000 ms e il limite
     * dell'azione era, di nuovo, nessuno: tagliare i cicli non cambiava niente,
     * il limite non era mai stato il lavoro. Nella nightly dello stesso giorno
     * tutti e sedici i rossi di `layout-edge-cases.spec.ts` sono quella riga,
     * identica, in otto test diversi.
     *
     * 15 s e non 30: dentro un test da 30 s l'azione deve fallire abbastanza presto
     * da lasciare a Playwright il tempo di attribuire l'errore e allegare traccia e
     * video. E non 10 s, che è il limite di `expect`, per non trasformare in rosso
     * un'azione lenta ma legittima su un runner sotto carico. Una spec che ha
     * davvero bisogno di più lo chiede sulla singola chiamata, dove si legge il
     * perché — che è esattamente il contrario di un default infinito che non si
     * legge da nessuna parte.
     */
    actionTimeout: 15_000,

    baseURL: E2E_BASE,
    video: EVIDENCE && !NO_VIDEO ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    viewport: { width: 1280, height: 800 },
    launchOptions: SLOWMO ? { slowMo: 300 } : {},
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
    // MOVIMENTO RIDOTTO PER TUTTA LA SUITE.
    //
    // Non è una preferenza estetica del runner: è il modo pulito di togliere di
    // mezzo una classe intera di rossi da «elemento mai stable». Playwright,
    // prima di ogni click, aspetta che la scatola del bersaglio sia ferma per
    // due frame consecutivi; con le transizioni accese, su un runner carico —
    // quattro shard sulla stessa macchina — una tab che scorre o un pannello che
    // scivola può non arrivarci dentro il timeout, e il test muore su
    // un'animazione invece che su un difetto. Spente, la geometria è quella
    // finale dal primo frame.
    //
    // Ciò che si perde è coperto altrove: le transizioni che sono LA cosa da
    // provare (il composer che scende, il drawer) hanno le loro spec, e chi
    // vuole vedere l'app muoversi ha `E2E_EVIDENCE=1`.
    //
    // Restava chiusa da un difetto: fino al 09/08 il comando in testa alla riga
    // di chrome stava a `md:left-[5.5px]`, mezzo pixel dentro il punto (5, 5)
    // che `reopen-closed-tab` usa per spostare il fuoco — e l'hit-test di
    // Chromium arrotondava DENTRO la scatola, mandando il click a timeout. Il
    // mezzo pixel è sparito (ab8d7514, inset a 6) e ora c'è una guardia che
    // misura la cosa nelle due modalità:
    // `tests/e2e/reduced-motion-chrome-controls.spec.ts`.
    //
    // `contextOptions` è la sola porta: fino alla 1.59 `reducedMotion` non è
    // un'opzione di primo livello di `use` (lo è `colorScheme`, non questa).
    // Conseguenza per chi scrive una spec che vuole l'altra modalità:
    // `contextOptions` è UN fixture solo, quindi un `test.use` che lo tocca
    // SOSTITUISCE l'oggetto invece di aggiungerci una chiave — la guardia infatti
    // si apre i due contesti a mano con `browser.newContext`.
    contextOptions: { reducedMotion: "reduce" },
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
        "**/sidebar-finger-follow.spec.ts",
        "**/sheet-finger-follow.spec.ts",
        "**/hover-reveal-touch-audit.spec.ts",
        "**/browser-mobile-keyboard.spec.ts",
        "**/mobile-chrome-bar.spec.ts",
        "**/mobile-edge-swipe-no-history.spec.ts",
        // Le due che mancavano. `sidebar-pin-drag-touch` è nel `testMatch` di
        // `chromium-touch` e `tab-close-ring-touch` in quello di
        // `chromium-touch-wide`, ma un `testMatch` altrove non ESCLUDE nulla
        // qui: senza queste due righe ognuna girava una SECONDA volta a
        // 1280×800 con `hasTouch: false`, dove `.tap()` non esiste e le misure
        // da dito non possono reggere. Ogni spec di questa famiglia va nominata
        // in DUE posti: il `testMatch` del suo progetto e questa lista.
        "**/sidebar-pin-drag-touch.spec.ts",
        "**/tab-close-ring-touch.spec.ts",
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
      // Tre spec, stessa popolazione: la prima misura le SUPERFICI col dito
      // (bersagli, menu, seconda riga), la seconda i GESTI del cassetto (che
      // segue il dito, le tessere fissate che non scattano quando scorri), la
      // terza i FOGLI dal basso (si spingono giù col dito, e il tocco che li
      // chiude non aziona ciò che sta sotto).
      testMatch: [
        "**/sidebar-touch-audit.spec.ts",
        "**/sidebar-finger-follow.spec.ts",
        "**/sheet-finger-follow.spec.ts",
        // La quarta: i due gesti che ATTRAVERSANO il bordo della griglia dei
        // Fissati (fissare trascinando dentro, sfissare trascinando fuori).
        "**/sidebar-pin-drag-touch.spec.ts",
      ],
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
     *
     * Qui gira anche `browser-mobile-keyboard.spec.ts` (quale tastiera esce
     * toccando un campo nel pane browser, e la scala che non si muove), per la
     * stessa ragione: serve il DITO, non la larghezza. A 390px il pane browser
     * sta dietro la navigazione mobile e il tocco atterra sulla colonna dei
     * topic — misurato, l'hit-test in quel punto restituisce `sidebar-column`.
     * Il contratto sotto esame (il campo di cattura che si veste come il campo
     * remoto, e la soglia dei 16px) non dipende dalla larghezza: si prova dove
     * la superficie esiste, invece di pilotare la navigazione del telefono.
     */
    /**
     * IL TELEFONO INTERO, non solo il dito.
     *
     * La chrome mobile decisa il 12/08 — «Topics» solo in alto, tre porte in
     * basso, la fila che segue la curva dello schermo — esiste SOLO sotto i
     * 768px e solo col dito: nel progetto `chromium` a 1280 non c'è proprio, e
     * un test che gira lì passerebbe misurando l'assenza. Stessi segnali della
     * spec touch (`hasTouch` + `isMobile`), viewport di un iPhone 14.
     */
    {
      name: "chromium-phone",
      // Due spec, stesso telefono: la prima misura la CHROME (cosa c'è in alto e
      // in basso), la seconda il BORDO (chi si prende il trascinamento che parte
      // dal margine dello schermo, il cassetto o la cronologia).
      testMatch: ["**/mobile-chrome-bar.spec.ts", "**/mobile-edge-swipe-no-history.spec.ts"],
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "chromium-touch-wide",
      // `board-card-stop` gira in DUE progetti (qui e in `chromium`): è lo stesso
      // menu aperto da due gesti, e i suoi due test si escludono a vicenda con
      // `test.skip(isMobile)`. A 390px la board è appiattita e la card non c'è —
      // serve il dito su schermo largo, che è esattamente questo progetto.
      testMatch: [
        "**/hover-reveal-touch-audit.spec.ts",
        "**/browser-mobile-keyboard.spec.ts",
        "**/board-card-stop.spec.ts",
        // La spunta della tab: il contratto e' «col dito», non «sul telefono»,
        // e a 390px la striscia non si disegna piu'. Qui c'e' e il dito e' vero.
        "**/tab-close-ring-touch.spec.ts",
      ],
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { width: 1280, height: 900 },
      },
    },
    /**
     * IL MOTORE DEL GUSCIO, non un secondo browser per scrupolo.
     *
     * L'app viene usata dentro una WKWebView (Tauri su macOS), e li' c'e' un
     * difetto che su Chromium NON esiste: `setDragImage` su un nodo fuori dal
     * viewport visivo torna VUOTA, e il sistema ripiega sull'icona generica di
     * documento. E' la segnalazione «la tab sembra un file mentre la trascino»,
     * ed e' il motivo per cui `lib/dragPreview` monta un nodo VIVO alla
     * posizione del cursore invece di fotografarne uno nascosto.
     *
     * Conseguenza diretta: la versione Chromium di quelle asserzioni resterebbe
     * VERDE mentendo, perche' su Chromium anche il trucco vecchio funziona. La
     * stessa spec va quindi ripetuta qui, che e' l'unico posto dove il difetto
     * si manifesta. Vedi `docs/drag-preview.md`.
     *
     * Gira SOLO `drag-preview.spec.ts`, e di proposito: il resto della suite ha
     * gia' la sua copertura su Chromium, e una seconda passata intera pagherebbe
     * il doppio del tempo per riprovare cose che non dipendono dal motore.
     *
     * NB - il `testMatch` qui NON esclude niente altrove: la stessa spec gira
     * ANCHE nel progetto `chromium` (non e' nel suo `testIgnore`), ed e' voluto.
     * Il punto del lavoro e' la STESSA asserzione nei due motori: se restasse
     * solo qui, una regressione che rompe Chromium passerebbe inosservata.
     */
    {
      name: "webkit",
      testMatch: ["**/drag-preview.spec.ts"],
      use: {
        browserName: "webkit",
        /* I permessi del `use` globale sono quelli della clipboard, e WebKit non
           li conosce: il contesto muore in partenza con «Unknown permission:
           clipboard-write», prima ancora che si apra una pagina, quindi ogni
           test di questo progetto sarebbe rosso per la configurazione e non per
           il prodotto. Si azzerano QUI e non nel blocco globale, dove servono al
           resto della suite. Questa spec la clipboard non la tocca, quindi
           azzerarli non le toglie niente. */
        permissions: [],
      },
    },
  ],
});
