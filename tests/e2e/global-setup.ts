/**
 * Playwright global setup — runs BEFORE all test suites.
 *
 * 1. Starts an isolated test server with its own SQLite DB
 * 2. Cleans up stale E2E test data from previous failed runs
 *
 * The test server uses its own DATA_DIR under /tmp, completely isolated from
 * the production data/ directory — e da quella degli altri shard: porta e
 * percorsi vengono da `helpers/test-server.ts`, che li deriva da `E2E_PORT`.
 */

import { spawn, execFileSync, execSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
  E2E_BASE,
  E2E_PORT,
  E2E_PORT_ORIGIN,
  dataDirForPort,
  descendantsOf,
  publicDirForPort,
  testServerEnv,
} from "./helpers/test-server";
import { acquireRunLock, releaseRunLock } from "./helpers/run-lock";
import { SERVER_DEATH_GRACE_MS, portHolders } from "./helpers/server-death";

// Test server runs WITHOUT TLS for simplicity (NO_TLS=1)
// Port 13334 is the default per il checkout principale, chosen to avoid
// conflicts with production services (port 3334 is used by the openclaw-gateway
// voice-call webhook). Ogni shard ne usa una diversa via E2E_PORT, e un worktree
// di dispatch ne riceve una derivata dal path (helpers/worktree-port.ts).
const BASE = E2E_BASE;
const TEST_SERVER_PORT = E2E_PORT;
const TEST_DATA_DIR = dataDirForPort(E2E_PORT);

/**
 * Resolve a Chromium executable on disk. Falls back through the most likely
 * Playwright cache locations because the server's `playwright-core` may pin
 * a slightly older manifest version than the binary that `@playwright/test`
 * actually installs (e.g. server resolves chromium-1208 but the cache holds
 * chromium-1217). Returns "" if nothing found — BrowserService will then
 * surface a clear error at first use.
 */
function resolveChromiumPath(): string {
  const cacheDir = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cacheDir)) return "";
  try {
    const entries = readdirSync(cacheDir).filter((d) => d.startsWith("chromium-"));
    // Prefer the highest revision numerically (newer cache wins).
    entries.sort((a, b) => {
      const ax = parseInt(a.split("-")[1] || "0", 10);
      const bx = parseInt(b.split("-")[1] || "0", 10);
      return bx - ax;
    });
    for (const dir of entries) {
      const candidate = join(
        cacheDir,
        dir,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * Congela il bundle del client sotto la DATA_DIR dello shard e ritorna il
 * percorso della copia.
 *
 * `public/` è una cartella VIVA: `vite build --watch` (il `dev:client` che
 * l'utente tiene su, per contratto — vedi CLAUDE.md) la riscrive a ogni
 * salvataggio, e per qualche decina di millisecondi `index.html` non esiste.
 * Un test che carica la pagina in quella finestra prende un 404 dal server e
 * fallisce per un motivo finto: nell'ultima run intera sono caduti tre test dei
 * terminali, con lo screenshot che diceva "no such file or directory …
 * public/index.html". Il rosso si sposta a ogni run perché dipende da QUANDO si
 * salva un file, non da cosa fa il codice — esattamente il tipo di non-ermeticità
 * che questa suite deve smettere di avere.
 *
 * La copia viene VALIDATA, non solo fatta: se `cp` è passato mentre il watcher
 * riscriveva, `index.html` può puntare a un asset che nella copia non c'è. In
 * quel caso si riprova invece di servire un bundle rotto — che sarebbe lo stesso
 * fallimento di prima, solo congelato per tutta la run.
 */
async function snapshotBundle(): Promise<string> {
  // `TOPICS_E2E_BUNDLE_DIR` — un bundle costruito ALTROVE.
  //
  // Il default (`public/`) presuppone che il watcher del client sia vivo e
  // aggiorni la cartella: è il contratto dello sviluppo su questa macchina. Ma
  // ci sono casi in cui non lo è, e senza via d'uscita la suite non parte
  // affatto: una macchina di CI che builda una volta e basta; un checkout dove
  // il watcher è morto o — visto il 2026-08-02 — è rimasto a girare a vuoto,
  // 98% di CPU per un'ora senza scrivere niente. In entrambi i casi l'unica
  // strada era «aspetta 90 secondi e arrenditi», su un bundle che nessuno stava
  // per aggiornare.
  //
  // Con la variabile si punta a una cartella costruita a mano
  // (`cd client && ./node_modules/.bin/vite build --outDir /tmp/e2e-bundle`),
  // che NON tocca `public/` e non richiede di riavviare niente. I controlli di
  // coerenza restano identici: quel bundle viene validato e congelato come
  // l'altro. Salta invece l'attesa di freschezza, che non ha senso su una
  // cartella che nessun watcher sta riscrivendo.
  const override = process.env.TOPICS_E2E_BUNDLE_DIR?.trim();
  const src = override ? resolve(override) : resolve(__dirname, "../../public");
  if (override) {
    if (!existsSync(src)) {
      throw new Error(
        `[global-setup] TOPICS_E2E_BUNDLE_DIR punta a ${src}, che non esiste.\n` +
          `Costruiscilo: cd client && ./node_modules/.bin/vite build --outDir ${src}`,
      );
    }
    console.log(`[global-setup] Bundle da TOPICS_E2E_BUNDLE_DIR: ${src} (nessuna attesa del watcher)`);
  }
  const dest = publicDirForPort(E2E_PORT);
  for (let attempt = 1; attempt <= 3; attempt++) {
    // La freschezza si ricontrolla a OGNI tentativo: fra una copia stracciata e
    // la successiva possono passare secondi, e in mezzo il watcher può aver
    // ricominciato da capo. Con un bundle esterno non c'è nessun watcher da
    // aspettare: la coerenza si verifica lo stesso, sulla copia, qui sotto.
    if (!override) await waitForFreshBundle(src);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // execFileSync, non execSync: niente shell di mezzo, quindi un percorso con
    // uno spazio o un apice non diventa una riga di comando diversa.
    execFileSync("cp", ["-R", `${src}/.`, `${dest}/`]);
    const missing = missingBundleAssets(dest);
    if (missing.length === 0) {
      console.log(`[global-setup] Bundle congelato in ${dest}`);
      return dest;
    }
    console.warn(
      `[global-setup] Copia del bundle incoerente (tentativo ${attempt}/3), asset mancanti: ${missing.join(", ")}`,
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `[global-setup] Non sono riuscito a fotografare un bundle coerente da ${src}.\n` +
      `Probabile: un build del client in corso che riscrive public/ di continuo. ` +
      `Aspetta che finisca e rilancia.`,
  );
}

/**
 * Cosa manca perché `dir` sia un bundle servibile. Vuoto = va bene.
 *
 * Non basta "gli asset citati esistono": `index.html` stesso può essere a metà.
 * Visto davvero — la copia ha beccato vite fra il `create` e il `write`, e ne è
 * uscito un `index.html` di ZERO byte. Un file vuoto non cita nessun asset,
 * quindi il controllo degli asset passava a vuoto, il server serviva una pagina
 * bianca e tutti i test fallivano dicendo che non trovavano la sidebar. Prima
 * si verifica che il file sia INTERO (chiuso, e con dentro l'entry del client),
 * poi che ciò che cita ci sia.
 */
function missingBundleAssets(dir: string): string[] {
  const entry = join(dir, "index.html");
  if (!existsSync(entry)) return ["index.html"];
  const html = readFileSync(entry, "utf8");
  if (!html.trim()) return ["index.html (vuoto)"];
  if (!/<\/html>\s*$/.test(html)) return ["index.html (troncato)"];
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) refs.add(m[1]);
  // Senza il modulo di entry la pagina si carica e non fa niente: bianca, e il
  // rosso accusa il primo componente che qualcuno cerca.
  if (![...refs].some((r) => /^\/assets\/.*\.js$/.test(r))) return ["index.html (senza entry /assets/*.js)"];
  return [...refs].filter((ref) => !existsSync(join(dir, ref.replace(/^\//, ""))));
}

/** Quanto si aspetta che il watcher finisca di ricostruire, prima di arrendersi. */
const BUNDLE_FRESH_TIMEOUT_MS = 90_000;

/**
 * Aspetta che `public/` sia più NUOVO dell'ultimo sorgente del client.
 *
 * Congelare il bundle toglie la non-ermeticità (vedi `snapshotBundle`), ma da
 * solo introduce un rischio peggiore: se la fotografia viene scattata mentre il
 * watcher non ha ancora ricostruito, la run intera gira sul codice di PRIMA — in
 * silenzio, e stavolta in modo perfettamente riproducibile. È già successo: un
 * `aria-label` appena cambiato non era nel bundle, il test falliva citando la
 * versione vecchia della stringa e il rosso sembrava un bug del componente.
 * Un test verde su codice vecchio è peggio di un test rosso: mente.
 *
 * Il confronto è mtime dell'`index.html` prodotto contro il sorgente toccato più
 * di recente — ma prima ancora il bundle dev'essere INTERO
 * (`missingBundleAssets`): a metà rebuild `index.html` ha già l'mtime nuovo ed è
 * ancora vuoto, e il solo mtime direbbe "pronto" su una pagina bianca.
 *
 * Si ASPETTA invece di fallire subito, perché il caso normale è proprio questo:
 * si salva un file e si lancia la suite un secondo dopo, mentre
 * `vite build --watch` sta ancora macinando.
 *
 * I `*.test.ts(x)` sono esclusi apposta: non sono nel grafo dei moduli
 * dell'entry, quindi salvarne uno non produce nessun rebuild e l'attesa non
 * finirebbe mai.
 */
async function waitForFreshBundle(publicDir: string): Promise<void> {
  const entry = join(publicDir, "index.html");
  const deadline = Date.now() + BUNDLE_FRESH_TIMEOUT_MS;
  let announced = false;
  let newest: { path: string; mtimeMs: number };

  for (;;) {
    // Il sorgente si rilegge a ogni giro: se qualcuno salva mentre aspettiamo,
    // il traguardo si sposta in avanti — che è la risposta giusta.
    newest = newestClientSource();
    // Coerente PRIMA che recente: durante un rebuild `index.html` esiste già,
    // con l'mtime nuovo, ma può essere ancora vuoto — e un mtime da solo
    // direbbe "pronto" su una pagina bianca.
    const coherent = missingBundleAssets(publicDir).length === 0;
    const builtAt = coherent ? statSync(entry).mtimeMs : 0;
    if (coherent && builtAt >= newest.mtimeMs) {
      if (announced) console.log(`[global-setup] Bundle aggiornato, si prosegue.`);
      return;
    }
    if (Date.now() >= deadline) break;
    if (!announced) {
      announced = true;
      console.log(
        coherent
          ? `[global-setup] Bundle più vecchio di ${newest.path}: aspetto il build del client…`
          : `[global-setup] Bundle a metà (${missingBundleAssets(publicDir)[0]}): aspetto il build del client…`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const missing = missingBundleAssets(publicDir);
  const stato = missing.length
    ? `manca ${missing.join(", ")}`
    : `il bundle è fermo a ${new Date(statSync(entry).mtimeMs).toLocaleTimeString()}, ` +
      `l'ultimo sorgente è delle ${new Date(newest.mtimeMs).toLocaleTimeString()}`;
  throw new Error(
    `[global-setup] Il bundle del client non è utilizzabile: ${stato}.\n` +
      `Ultimo file toccato: ${newest.path}\n\n` +
      `La suite girerebbe sul codice di PRIMA (o su una pagina bianca) e il rosso ` +
      `accuserebbe il componente sbagliato.\n` +
      `Probabile: \`bun run dev:client\` non è su, oppure il build è fallito.\n\n` +
      `SE \`public/\` NON È TUA (un worktree, una sessione parallela, la app viva):\n` +
      `NON ricostruirla: \`build:client\` la RISCRIVE, e chi ci sta sopra si ritrova\n` +
      `il bundle di un'altra persona (o il proprio lavoro non committato inglobato).\n` +
      `Costruisci altrove e punta la suite lì:\n\n` +
      `    git archive HEAD | tar -x -C /tmp/e2e-src && (cd /tmp/e2e-src/client && bun install && bun run build)\n` +
      `    TOPICS_E2E_BUNDLE_DIR=/tmp/e2e-src/public bun run test:e2e\n\n` +
      `Se \`public/\` è tua e nessun altro ci lavora:\n\n` +
      `    bun run build:client\n\n` +
      `(Se il file è appena stato creato e non lo importa ancora nessuno, il watcher ` +
      `non ha nulla da ricostruire: importalo o fai un build a mano.)`,
  );
}

/** Il sorgente del client toccato più di recente, esclusi i test. */
function newestClientSource(): { path: string; mtimeMs: number } {
  const roots = [resolve(__dirname, "../../client/src"), resolve(__dirname, "../../client/index.html")];
  let best = { path: roots[0], mtimeMs: 0 };

  const visit = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) visit(join(p, name));
      return;
    }
    // Non nel grafo dei moduli: non fa scattare nessun rebuild.
    if (/\.test\.[cm]?[jt]sx?$/.test(p)) return;
    if (st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  };

  for (const root of roots) if (existsSync(root)) visit(root);
  return best;
}

let serverProcess: ChildProcess | null = null;

/**
 * `true` da quando questo processo ha preso il lock della porta. Serve a
 * `emergencyCleanup`: un Ctrl-C deve restituire la porta, ma un'uscita
 * PRIMA dell'acquisizione (bundle assente, oppure lock rifiutato perché lo
 * teneva un altro) non deve cancellare il lock di nessuno.
 */
let runLockHeld = false;

/**
 * Chromium PIDs that were ALREADY running when this run started — i.e. someone
 * else's: another repo's E2E run, the user's claude-in-chrome browser, a debug
 * window. Recorded so neither the emergency kill nor global-teardown reaps them.
 */
let foreignChromiumPids: Set<string> = new Set();

/**
 * PIDs of every Chromium our cleanup code considers fair game, machine-wide.
 * MUST stay in sync with the match used by global-teardown.ts — the whole point
 * is that the "spare" snapshot and the kill see the same population.
 */
function listPlaywrightChromiumPids(): string[] {
  try {
    return execSync(
      'ps ax -o pid=,command= | grep -E "ms-playwright|mcp-chrome" | grep -Ei "chromium|chrome" | grep -v grep | awk \'{ print $1 }\'',
    )
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Attende che la porta del server di test si apra. Il tetto arriva da
 * `E2E_SERVER_START_TIMEOUT_MS` perché quanto serve dipende da quanti shard
 * stanno bootando insieme: `scripts/e2e-shards.sh` lo alza, un run singolo tiene
 * i 30s. Alzarlo non rallenta nulla — il ciclo esce appena la porta risponde —
 * costa solo quanto si aspetta prima di dichiararlo morto.
 */
async function waitForServer(
  _url: string,
  timeoutMs = Number(process.env.E2E_SERVER_START_TIMEOUT_MS) || 30000,
): Promise<void> {
  const net = await import("net");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(
        { port: TEST_SERVER_PORT, host: "127.0.0.1" },
        () => { socket.destroy(); resolve(true); }
      );
      socket.on("error", () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (isOpen) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Test server did not start within ${timeoutMs}ms`);
}

async function startTestServer(): Promise<void> {
  const scriptPath = resolve(__dirname, "../../scripts/start-test-server.sh");

  serverProcess = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      // Porta, DATA_DIR, TOPICS_HOME, OPENCLAW_DIR e i socket del PTY-bridge /
      // ai-bridge: tutto da testServerEnv(), l'unica lista. Prima era ricopiata
      // qui, dentro start-test-server.sh e dentro lo spec che riavvia il server
      // — tre copie già divergenti fra loro.
      ...testServerEnv(TEST_SERVER_PORT),
      // Phase 30 plan 30-05: server's playwright-core ships an older
      // chromium-1208 manifest, but @playwright/test installs the current
      // chromium-1217 binary. Pin the BrowserService Chromium to the
      // actually-installed binary. Override via CHROMIUM_PATH env if
      // running on a machine with a different layout.
      CHROMIUM_PATH: process.env.CHROMIUM_PATH ||
        resolveChromiumPath(),
    },
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[test-server] ${msg}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[test-server:err] ${msg}`);
  });

  serverProcess.on("error", (err) => {
    console.error("[test-server] Failed to start:", err.message);
  });

  // La morte del server, NOMINATA nell'istante in cui succede.
  //
  // Senza questo, un server ucciso a metà run lascia solo una scia di test che
  // falliscono con ECONNREFUSED: otto rossi che parlano di HTTP mentre il
  // difetto è che non c'è più nessuno dall'altra parte, e il primo sospettato
  // diventa l'ultimo commit. Qui la riga esce nello stdout della run nel punto
  // ESATTO del buco, con il segnale che l'ha ucciso — `SIGTERM` = qualcuno da
  // fuori (tipicamente il globalSetup di un altro checkout che ammazza chi
  // tiene la porta), uscita con codice = è crashato da solo.
  serverProcess.on("exit", (code, signal) => {
    // Morte ATTESA (global-teardown / emergencyCleanup l'hanno appena ucciso):
    // silenzio. Il flag passa da env perché global-teardown.ts è un modulo a
    // parte nello stesso processo — come già fa __TEST_SERVER_PID.
    if (process.env.__E2E_TEARDOWN_STARTED === "1") return;

    // NON gridare subito. `terminal-session-resume.spec.ts` (AC-2, «server
    // restart restores sessions») ammazza il server e ne riavvia un altro sulla
    // stessa porta, DI PROPOSITO. Visto da qui quell'uscita è indistinguibile da
    // un omicidio: il SIGTERM viene gestito con uno shutdown pulito, quindi
    // arriva come `codice 0`, esattamente come un kill da un altro checkout. La
    // prima versione di questo banner infatti accusava quel riavvio di essere un
    // crash — a ogni run, in mezzo a una suite verde. Un allarme che suona
    // sempre non è un allarme: è rumore che insegna a ignorare l'allarme vero.
    //
    // Ciò che distingue i due casi non è la MORTE, è cosa succede DOPO: un
    // riavvio voluto riapre la porta in pochi secondi, un omicidio la lascia
    // vuota (o in mano a un altro). Quindi si aspetta, si guarda, e si parla solo
    // se non è tornato nessuno. `unref()` perché questo timer non deve tenere in
    // vita il runner: se la suite finisce prima, il banner semplicemente non
    // serve più.
    const timer = setTimeout(() => {
      if (process.env.__E2E_TEARDOWN_STARTED === "1") return;
      if (portHolders(TEST_SERVER_PORT).length > 0) return; // riavviato: tutto a posto
      console.error(
        `\n[test-server] ═══ IL SERVER DI TEST È MORTO A METÀ RUN ` +
          `(${signal ? `segnale ${signal}` : `codice ${code}`}), E NESSUNO L'HA RIAVVIATO ═══\n` +
          `[test-server] Da qui in poi ogni test fallisce con ECONNREFUSED: sono rossi FINTI.\n` +
          `[test-server] Quasi sempre è un'altra run E2E sulla stessa porta (${TEST_SERVER_PORT}): il suo\n` +
          `[test-server] globalSetup ammazza chi la tiene. Un worktree di dispatch ormai ha una porta sua\n` +
          `[test-server] (helpers/worktree-port.ts), ma i checkout nati prima del 2026-07-28 non hanno nemmeno\n` +
          `[test-server] il run-lock. Rimedio immediato: E2E_PORT=13400 npx playwright test\n`,
      );
    }, SERVER_DEATH_GRACE_MS);
    timer.unref();
  });

  // Store PID for teardown
  if (serverProcess.pid) {
    process.env.__TEST_SERVER_PID = String(serverProcess.pid);
  }

  console.log(
    `[global-setup] Starting test server on port ${TEST_SERVER_PORT} (PID: ${serverProcess.pid})...`
  );

  await waitForServer(BASE);
  console.log("[global-setup] Test server is ready.");
}

async function globalSetup() {
  // Il bundle deve esistere ED ESSERE AGGIORNATO prima di ogni altra cosa, o
  // ogni test mente — in due modi diversi.
  //
  // Assente: `public/` è gitignored, quindi in un checkout fresco — un worktree
  // di agente, una clone pulita, una CI senza step di build — semplicemente non
  // c'è. Il server di test parte lo stesso e serve una pagina vuota, quindi
  // TUTTI i test falliscono sul primo
  // `waitForSelector('[aria-label="Topics sidebar"]')`: ~500 rossi che accusano
  // il componente sbagliato e mandano a caccia di un bug che non esiste (visto:
  // chat.spec.ts sembrava rotto sullo scroll, era `bun run build:client` fallito
  // in silenzio per node_modules mancanti).
  //
  // Vecchio: la suite gira sul codice di ieri e il verde non dimostra niente.
  //
  // Il controllo ASPETTA (vedi waitForFreshBundle) invece di fallire subito,
  // perché il caso normale è lanciare i test un secondo dopo aver salvato,
  // mentre il watcher sta ancora ricostruendo — e in quella finestra `public/`
  // è vuota. Fallire lì sarebbe la stessa flakiness, spostata di un metro.
  //
  // Sta QUI, prima del lock e dei passi distruttivi: se manca il build non c'è
  // motivo di ammazzare la porta di nessuno.
  //
  // `TOPICS_E2E_BUNDLE_DIR` deve saltare anche QUESTO controllo, non solo
  // quello dentro `snapshotBundle`. Era il buco che rendeva la variabile
  // inservibile proprio nel caso per cui esiste: con un bundle costruito
  // altrove e nessun watcher a riscrivere `public/`, la suite moriva qui —
  // «il bundle è fermo alle 00:55» — su una cartella che non stava per
  // usare, e il messaggio mandava a cercare un build rotto che non c'era.
  if (!process.env.TOPICS_E2E_BUNDLE_DIR?.trim()) {
    await waitForFreshBundle(resolve(__dirname, "../../public"));
  }

  // Il lock PRIMA di qualsiasi passo distruttivo.
  //
  // Da qui in giù questo setup ammazza chi tiene la porta e cancella
  // `topics.db`, assumendo che sia un residuo. Se invece è una run VIVA, quella
  // run non muore: resta in piedi con il file SQLite sfilato da sotto e fallisce
  // ogni test con `SQLITE_IOERR_VNODE`. Meglio fermarsi qui con un messaggio che
  // dice chi c'è e come girare in parallelo (vedi helpers/run-lock.ts).
  if (E2E_PORT_ORIGIN === "worktree") {
    console.log(
      `[global-setup] Questo è un worktree di dispatch: porta ${TEST_SERVER_PORT} ` +
        `(derivata dal path), non la 13334 del checkout principale. ` +
        `DATA_DIR ${TEST_DATA_DIR}. Forzala con E2E_PORT=<porta> se serve.`,
    );
  }
  acquireRunLock(TEST_SERVER_PORT);
  runLockHeld = true;
  // Il PID scritto nel lock, passato ai worker via env (come __TEST_SERVER_PID).
  // Serve alla diagnosi di helpers/server-death.ts: se a metà run il lock non è
  // più questo, qualcuno si è preso la porta — ed è lui che ci ha ammazzato il
  // server, non l'ultimo commit.
  process.env.__E2E_RUN_LOCK_PID = String(process.pid);

  // Disable TLS verification for localhost self-signed certs
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  // Snapshot foreign Chromiums BEFORE we launch any of our own, so the
  // emergency kill can tell them apart (see emergencyCleanup).
  foreignChromiumPids = new Set(listPlaywrightChromiumPids());
  // global-teardown.ts runs in this same process but as a separate module, so
  // it can't see the Set — hand the list over via env, as we already do for
  // __TEST_SERVER_PID.
  process.env.__FOREIGN_CHROMIUM_PIDS = [...foreignChromiumPids].join(",");
  if (foreignChromiumPids.size) {
    console.log(
      `[global-setup] ${foreignChromiumPids.size} pre-existing Chromium process(es) — not ours, will be spared on cleanup.`,
    );
  }

  // Phase 30.1 polish — propagate DATA_DIR to the Playwright runner so specs
  // that need to read files written by the test server (e.g.
  // browser-persistence.spec.ts reading data/browser-state/<id>/storage.json)
  // can resolve the same path the server uses. The spawned test server
  // already gets DATA_DIR via startTestServer(); without this line the
  // runner's process.env.DATA_DIR stays unset and specs would have to
  // hardcode the path.
  if (!process.env.DATA_DIR) process.env.DATA_DIR = TEST_DATA_DIR;

  // Same rationale, for OPENCLAW_DIR (see startTestServer() below) — specs
  // that resolve project-workspace paths (e.g. project-commands.spec.ts's
  // WORKSPACE_DIR) need to agree with the isolated server on where
  // `${OPENCLAW_DIR}/workspace` lives. NOT done for HOME itself: HOME is
  // isolated for the spawned server process only (start-test-server.sh) —
  // mutating it here, in the runner process, would also change what
  // Playwright's own os.homedir()-based Chromium cache lookup resolves to
  // for every worker, breaking browser launch for the whole suite.
  if (!process.env.OPENCLAW_DIR) process.env.OPENCLAW_DIR = `${TEST_DATA_DIR}/.openclaw`;

  // Kill any stale test server processes on the test port before starting.
  // `-sTCP:LISTEN`: senza, lsof elenca anche i socket che hanno questa porta
  // come capo REMOTO — cioè i client. Vogliamo chi TIENE la porta, non chi la
  // sta usando (vedi killServer in terminal-session-resume.spec.ts).
  try {
    const stalePids = execSync(
      `lsof -ti :${TEST_SERVER_PORT} -sTCP:LISTEN 2>/dev/null || true`
    ).toString().trim();
    if (stalePids) {
      execSync(`kill ${stalePids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-setup] Killed stale test processes on port ${TEST_SERVER_PORT}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}

  // Pulizia dello stato browser della run PRECEDENTE — SOLO sotto la cartella
  // dati di test, mai `<repo>/data`.
  //
  // Qui c'era anche `join(process.cwd(), "data", "browser-state")`, con accanto
  // un commento che lo chiamava «belt-and-braces» per ripulire i residui delle
  // run pre-fix. La premessa era falsa e il prezzo altissimo: il server di
  // PRODUZIONE non ha `DATA_DIR` (il plist com.armonia.topics-server esporta
  // solo HOME e PATH, con WorkingDirectory sul repo), quindi
  // `browser-state-store.ts:19-21` risolve proprio `<repo>/data/browser-state`.
  // Quella cartella contiene i cookie e il localStorage di ogni pane browser
  // (`storage.json`), l'ultima URL visitata (`last-url.json`) e — sotto
  // `_handles/` — i login salvati a mano con `browser_save_state`. Nessun
  // percorso di produzione li cancella: l'unico che lo faceva era questa riga.
  //
  // Effetto per chi usa l'app: dopo ogni run E2E lanciata dal checkout, tutte
  // le pane browser si risvegliano SLOGGATE e su `about:blank` invece che sulla
  // loro pagina — non subito (i contesti vivi tengono i cookie in RAM) ma al
  // primo ricreare del contesto, cioè al riavvio del server o dopo il reaper
  // d'inattività. È il «ai reset si perde la sessione» + «schermata bianca»
  // segnalato il 2026-08-02. Nei log ci sono le prove del wipe del 30/07, e da
  // lì in poi lo stesso contesto passa da `persisted=yes` a `persisted=no`.
  //
  // Toglierla non tocca un solo assert: la riga 466 forza già `DATA_DIR` a
  // TEST_DATA_DIR, `scripts/start-test-server.sh` la esporta sempre, e le spec
  // risolvono il percorso da lì (browser-persistence.spec.ts usa E2E_DATA_DIR),
  // mai da `process.cwd()`.
  for (const dir of [join(TEST_DATA_DIR, "browser-state")]) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[global-setup] Wiped stale browser-state: ${dir}`);
      }
    } catch (err) {
      console.warn(`[global-setup] Failed to wipe ${dir}: ${(err as Error).message}`);
    }
  }

  // Hard-wipe the SQLite DB so every full run starts from a pristine schema.
  //
  // This is the ROOT fix for cross-run pollution. `DELETE /api/topics/:id` is a
  // SOFT delete — it only sets archived=true (server/routes/topics.ts) — so the
  // old DELETE-based cleanup below never actually removed anything. Archived
  // rows accumulate across runs, and `GET /api/topics` still returns them, so
  // helpers.ts `ensureTopicVisible` (which resolves a topic id by name-regex and
  // then UNARCHIVES every match) resurrects them: e.g. `/Input Feature Test/`
  // matched 4 stale copies → strict-mode violation. A blank DB removes the whole
  // class: no stale topics, no archived baselines (Web Search Test), no orphan
  // panes in ui_state. The server recreates the schema on boot (server/db.ts
  // `new Database(dbPath)` + CREATE TABLE IF NOT EXISTS), and seedBaselineData()
  // re-seeds Web Search Test / Best Ramen fresh + non-archived every run.
  const dataDir = process.env.DATA_DIR || TEST_DATA_DIR;
  for (const f of ["topics.db", "topics.db-wal", "topics.db-shm"]) {
    const p = join(dataDir, f);
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        console.log(`[global-setup] Wiped stale test DB file: ${p}`);
      }
    } catch (err) {
      console.warn(`[global-setup] Failed to wipe ${p}: ${(err as Error).message}`);
    }
  }

  // Il bundle si congela QUI: dopo l'ultimo passo che tocca il disco e prima
  // che il server apra la porta, così ciò che serve per tutta la run è un
  // insieme di file che nessuno riscriverà più.
  await snapshotBundle();

  // Start isolated test server
  await startTestServer();

  try {
    // Clean up stale E2E topics
    const topicsRes = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (topicsRes.ok) {
      const data = (await topicsRes.json()) as {
        topics: Record<string, { id: string; name: string }>;
      };
      const E2E_TOPIC_PATTERNS = [
        /^E2E-/,
        /^Toolbar E2E /,
        /^Pin E2E /,
        /^Chat E2E Test /,
        /^Input Feature Test /,
        /^Branch E2E /,
      ];
      const staleTopics = Object.values(data.topics).filter(
        (t) => t.name && E2E_TOPIC_PATTERNS.some((p) => p.test(t.name))
      );
      if (staleTopics.length > 0) {
        console.log(
          `[global-setup] Cleaning ${staleTopics.length} stale E2E topics...`
        );
        for (const topic of staleTopics) {
          await fetch(`${BASE}/api/topics/${topic.id}`, {
            method: "DELETE",
          }).catch(() => {});
        }
      }
    }

    // Reset UI state to prevent stale panels/layout from breaking tests.
    // Includes both legacy keys AND the Phase 30 pane-store-v2 reducer snapshot
    // so the unified-timeline sidebar starts clean.
    const uiResets: Record<string, any> = {
      panels: { openPanels: [] },
      "grid-layout": { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      "panel-order": { order: [], pinned: [] },
      "pane-store-v2": {
        panes: {},
        groups: { "group:default": { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
        lastSeq: 0,
      },
    };
    for (const [key, value] of Object.entries(uiResets)) {
      await fetch(`${BASE}/api/ui-state/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }).catch(() => {});
    }
    console.log("[global-setup] Reset UI state (panels, grid-layout, panel-order)");
  } catch (err) {
    // Server might have issues — don't fail setup, tests will catch errors
    console.warn(
      "[global-setup] Could not clean stale data:",
      (err as Error).message
    );
  }

  // Seed baseline data that legacy tests (Phase 1-2) expect
  await seedBaselineData();

  // Fotografa QUESTO stato: è la baseline a cui ogni file di spec torna prima
  // di partire (tests/e2e/fixtures/hermetic.ts). Va per forza qui, dopo il
  // seed e prima del primo test — è l'unico istante in cui il DB contiene
  // esattamente ciò che la suite assume e nulla di ciò che produrrà.
  await checkpointBaseline();
}

/**
 * Congela lo stato appena seminato come baseline della run.
 *
 * Fallire qui è meglio che proseguire: senza fotografia ogni `hermetic()`
 * risponde 409 e la suite tornerebbe non ermetica — ma in silenzio, che è il
 * modo in cui questo problema è già costato giorni di caccia al rosso mobile.
 */
async function checkpointBaseline() {
  const res = await fetch(`${BASE}/api/test/checkpoint`, { method: "POST" }).catch((err) => {
    throw new Error(`[global-setup] checkpoint della baseline non raggiungibile: ${(err as Error).message}`);
  });
  if (!res.ok) {
    throw new Error(
      `[global-setup] checkpoint della baseline fallito: ${res.status} ${res.statusText}\n` +
        `Le route /api/test/* esistono solo con TOPICS_E2E=1 (vedi helpers/test-server.ts + scripts/start-test-server.sh).`,
    );
  }
  const body = (await res.json()) as { tables?: number; rows?: number };
  console.log(`[global-setup] Baseline fotografata: ${body.tables} tabelle, ${body.rows} righe`);
}

/**
 * Create baseline topics that older tests reference by name.
 * Phase 3-12 tests self-provision via API fixtures; these are for Phase 1-2 tests.
 */
async function seedBaselineData() {
  const requiredTopics = [
    { name: "Web Search Test", type: "chat" },
    { name: "Best Ramen", type: "chat" },
  ];

  try {
    const topicsRes = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (!topicsRes.ok) return;

    const data = (await topicsRes.json()) as {
      topics: Record<string, { id: string; name: string }>;
    };
    const existingNames = new Set(
      Object.values(data.topics).map((t) => t.name)
    );

    for (const topic of requiredTopics) {
      if (!existingNames.has(topic.name)) {
        const res = await fetch(`${BASE}/api/topics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: topic.name, type: topic.type }),
        });
        if (res.ok) {
          console.log(`[global-setup] Seeded topic: "${topic.name}"`);
        }
      }
    }

    // Seed messages into "Web Search Test" so tests that depend on it having
    // messages (e.g., scroll position, markdown rendering) work reliably
    const topicsAfterSeed = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (topicsAfterSeed.ok) {
      const afterData = (await topicsAfterSeed.json()) as {
        topics: Record<string, { id: string; name: string }>;
      };
      const webSearchTopic = Object.values(afterData.topics).find(
        (t) => t.name === "Web Search Test"
      );
      if (webSearchTopic) {
        // Check if it already has messages via history endpoint
        const historyRes = await fetch(
          `${BASE}/api/history/${webSearchTopic.id}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
        );
        const historyData = historyRes.ok ? await historyRes.json() as { messages?: any[] } : { messages: [] };
        if (!historyData.messages || historyData.messages.length === 0) {
          // Seed sample messages for tests that expect content
          const sampleMessages = [
            "Here is a **bold** statement and some `inline code`.\n\n```javascript\nconst x = 42;\nconsole.log(x);\n```\n\n- Item one\n- Item two\n\n[A link](https://example.com)",
            "This is a follow-up response with more content.\n\n## Heading\n\nSome paragraph text with *italics* and **bold**.",
            "Final message with a longer response to ensure scrollable content is present for scroll position tests.",
          ];
          for (const content of sampleMessages) {
            await fetch(`${BASE}/api/topics/${webSearchTopic.id}/system-message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content }),
            }).catch(() => {});
          }
          console.log(`[global-setup] Seeded ${sampleMessages.length} messages into "Web Search Test"`);
        }
      }
    }
  } catch (err) {
    console.warn(
      "[global-setup] Could not seed baseline data:",
      (err as Error).message
    );
  }
}

// Cleanup on crash/interrupt — kill test server + Chromium processes
function emergencyCleanup() {
  // Da qui la morte del server è ATTESA: zittisce il banner "morto a metà run".
  process.env.__E2E_TEARDOWN_STARTED = "1";
  // Per primo il lock: se Ctrl-C arriva a metà run, la porta deve tornare
  // libera subito. `releaseRunLock` toglie solo il lock NOSTRO, quindi
  // chiamarlo qui non può mai scoprire la porta a un'altra run.
  if (runLockHeld) {
    runLockHeld = false;
    try { releaseRunLock(TEST_SERVER_PORT); } catch {}
  }
  try {
    if (serverProcess?.pid) process.kill(-serverProcess.pid, 'SIGTERM');
  } catch {}
  try {
    // `-sTCP:LISTEN` o si ammazzano anche i CLIENT della porta: senza il filtro
    // lsof elenca i Chromium connessi al server di test, e questo kill li porta
    // via insieme al server (il fallimento poi esce altrove, come flake).
    execSync(`lsof -ti :${TEST_SERVER_PORT} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true`);
    // Kill only the Chromiums THIS run is responsible for. The previous version
    // killed every ms-playwright Chromium on the machine, which reaches across
    // repos: a concurrent E2E run in another project (and its results) died
    // whenever this suite crashed or was interrupted. Nostri = discendenti di
    // questo runner; la fotografia dei PID pre-esistenti resta come cintura in
    // più, ma da sola non basta con più shard in parallelo (i browser degli
    // altri nascono DOPO la fotografia).
    const mine = descendantsOf(process.pid);
    const ours = listPlaywrightChromiumPids().filter(
      (pid) => !foreignChromiumPids.has(pid) && mine.has(pid) && /^\d+$/.test(pid),
    );
    if (ours.length) execSync(`kill -9 ${ours.join(" ")} 2>/dev/null || true`);
  } catch {}
}
process.on('SIGINT', emergencyCleanup);
process.on('SIGTERM', emergencyCleanup);
process.on('exit', emergencyCleanup);

export default globalSetup;
