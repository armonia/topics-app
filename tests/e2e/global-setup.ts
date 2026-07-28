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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
  E2E_BASE,
  E2E_PORT,
  dataDirForPort,
  descendantsOf,
  publicDirForPort,
  testServerEnv,
} from "./helpers/test-server";
import { acquireRunLock, releaseRunLock } from "./helpers/run-lock";

// Test server runs WITHOUT TLS for simplicity (NO_TLS=1)
// Port 13334 is the default, chosen to avoid conflicts with production services
// (port 3334 is used by the openclaw-gateway voice-call webhook); ogni shard
// ne usa una diversa via E2E_PORT.
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
  const src = resolve(__dirname, "../../public");
  const dest = publicDirForPort(E2E_PORT);
  for (let attempt = 1; attempt <= 3; attempt++) {
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

/** Gli asset che `index.html` cita ma che nella copia non ci sono. */
function missingBundleAssets(dir: string): string[] {
  const entry = join(dir, "index.html");
  if (!existsSync(entry)) return ["index.html"];
  const html = readFileSync(entry, "utf8");
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) refs.add(m[1]);
  return [...refs].filter((ref) => !existsSync(join(dir, ref.replace(/^\//, ""))));
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

async function waitForServer(_url: string, timeoutMs = 30000): Promise<void> {
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
  // Il bundle deve esistere PRIMA di accendere il server, o ogni test mente.
  //
  // `public/` è gitignored: in un checkout fresco — un worktree di agente, una
  // clone pulita, una CI senza step di build — semplicemente non c'è. Il server
  // di test parte lo stesso e serve una pagina vuota, quindi TUTTI i test
  // falliscono sul primo `waitForSelector('[aria-label="Topics sidebar"]')`:
  // ~500 rossi che accusano il componente sbagliato e mandano a caccia di un
  // bug che non esiste (visto: chat.spec.ts sembrava rotto sullo scroll, era
  // `bun run build:client` fallito in silenzio per node_modules mancanti).
  // Un errore solo, che dice cosa lanciare, vale più di una suite rossa.
  const bundleEntry = resolve(__dirname, "../../public/index.html");
  if (!existsSync(bundleEntry)) {
    throw new Error(
      `[global-setup] Bundle del client assente: ${bundleEntry}\n` +
        `Il server di test servirebbe una pagina vuota e ogni test fallirebbe ` +
        `per un motivo finto. Lancia prima:\n\n    bun run build:client\n`
    );
  }

  // Il lock PRIMA di qualsiasi passo distruttivo.
  //
  // Da qui in giù questo setup ammazza chi tiene la porta e cancella
  // `topics.db`, assumendo che sia un residuo. Se invece è una run VIVA, quella
  // run non muore: resta in piedi con il file SQLite sfilato da sotto e fallisce
  // ogni test con `SQLITE_IOERR_VNODE`. Meglio fermarsi qui con un messaggio che
  // dice chi c'è e come girare in parallelo (vedi helpers/run-lock.ts).
  acquireRunLock(TEST_SERVER_PORT);
  runLockHeld = true;

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

  // Kill any stale test server processes on the test port before starting
  try {
    const stalePids = execSync(
      `lsof -ti :${TEST_SERVER_PORT} 2>/dev/null || true`
    ).toString().trim();
    if (stalePids) {
      execSync(`kill ${stalePids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-setup] Killed stale test processes on port ${TEST_SERVER_PORT}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}

  // Phase 30.1 polish — wipe per-topic browser-state from previous runs.
  // BASE_DIR in browser-state-store.ts now honours DATA_DIR, but pre-fix
  // runs (or runs with the old default) may have left files under
  // <repo>/data/browser-state/. Belt-and-braces: clean both locations
  // before the test server boots so restoreAllContexts doesn't re-hydrate
  // a context with stale cookies that would skew BROWSER-CHAT-01 asserts.
  for (const dir of [join(TEST_DATA_DIR, "browser-state"), join(process.cwd(), "data", "browser-state")]) {
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
    execSync(`lsof -ti :${TEST_SERVER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true`);
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
