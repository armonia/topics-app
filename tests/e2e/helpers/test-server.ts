/**
 * Dove vive il server di test, in UN posto solo.
 *
 * Prima l'indirizzo era un literal ripetuto: `const BASE = "http://localhost:13334"`
 * in 46 file, più la porta, la `DATA_DIR`, la home isolata e i socket ricopiati
 * a mano in `global-setup.ts`, in `scripts/start-test-server.sh` e dentro lo
 * spec che riavvia il server. Tre copie della stessa lista che erano già
 * divergenti (il riavvio di `terminal-session-resume` non passava `TOPICS_HOME`
 * né `OPENCLAW_DIR`, quindi il server ripartiva meno isolato di come era nato).
 *
 * Quel numero cablato è anche ciò che teneva la suite seriale. Far girare più
 * shard sulla stessa macchina significa più processi Playwright avviati
 * insieme, e con la porta fissa si contenderebbero lo stesso listener, lo
 * stesso file SQLite e lo stesso socket del PTY-bridge. Su CI il nightly se la
 * cava perché ogni shard ha un runner tutto suo
 * (`.github/workflows/e2e-nightly.yml`); in locale no.
 *
 * Con la porta presa da `E2E_PORT` ogni shard si porta il proprio server, la
 * propria `DATA_DIR` e i propri socket. Senza la variabile tutto resta identico
 * a prima (13334 + `/tmp/topics-test-data`): il singolo `npx playwright test`
 * non cambia di una virgola.
 */

import { execSync } from "child_process";

export const E2E_PORT = Number(process.env.E2E_PORT || 13334);

export const E2E_BASE = `http://localhost:${E2E_PORT}`;

export const E2E_WS_BASE = `ws://localhost:${E2E_PORT}`;

/**
 * Dove vive lo stato del server di test per una data porta.
 *
 * La porta di default tiene il percorso storico: script, `.gitignore` e memoria
 * muscolare puntano lì, e uno shard singolo non deve cambiare nulla.
 */
export function dataDirForPort(port: number): string {
  return port === 13334
    ? "/tmp/topics-test-data"
    : `/tmp/topics-test-data-${port}`;
}

/** La `DATA_DIR` di QUESTO processo — le spec la leggono per ispezionare i file scritti dal server. */
export const E2E_DATA_DIR = process.env.DATA_DIR || dataDirForPort(E2E_PORT);

/** La HOME isolata del server (`start-test-server.sh` la esporta, alcune spec ci seminano dentro). */
export const E2E_HOME = `${E2E_DATA_DIR}/.home`;

/**
 * L'ambiente completo di un server di test.
 *
 * Unica fonte per chi lo avvia: `global-setup.ts` al boot della suite e
 * `terminal-session-resume.spec.ts` quando lo riavvia a metà test. Ogni voce
 * qui isola il server da QUALCOSA che, senza, andrebbe a toccare la macchina
 * vera — i commenti dicono cosa.
 */
export function testServerEnv(port: number = E2E_PORT): Record<string, string> {
  const dataDir = dataDirForPort(port);
  return {
    BUN_PORT: String(port),
    DATA_DIR: dataDir,
    // TOPICS_HOME dedicata: il lock del daemon (`daemon-process.lock`) è per-home,
    // e quello vero ce l'ha il server di sviluppo.
    TOPICS_HOME: `${dataDir}/.topics-home`,
    // Config e sessioni OpenClaw dell'utente vero fuori dai piedi: SESSIONS_DIR
    // deriva da OPENCLAW_DIR, quindi questa sola variabile copre entrambi.
    OPENCLAW_DIR: `${dataDir}/.openclaw`,
    // Socket del PTY-bridge: senza, viene derivato dalla cwd — che il server di
    // test CONDIVIDE con quello di sviluppo — e il reconcile del test vedrebbe
    // le PTY Claude vive dello sviluppo come orfane, ammazzandole.
    TOPICS_PTY_SOCKET: `/tmp/topics-pty-bridge-e2e-${port}.sock`,
    // Stessa storia per il broker stream-json.
    TOPICS_AI_BRIDGE_SOCKET: `/tmp/topics-ai-bridge-e2e-${port}.sock`,
    NO_TLS: "1",
    GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || "test-token",
    GATEWAY_URL: process.env.GATEWAY_URL || "http://127.0.0.1:18789",
  };
}

/**
 * I PID discendenti da `root`, ricostruiti dalla tabella ppid.
 *
 * Serve alla pulizia dei browser: uno è NOSTRO se discende da questo runner.
 * Prima ci si basava su una fotografia dei Chromium vivi al boot, ammazzando
 * tutto ciò che non era nella foto. Regge finché la suite gira da sola, ma con
 * più shard in parallelo lo shard che finisce per primo ammazzerebbe i browser
 * degli altri: sono partiti DOPO la sua fotografia, quindi per lui sono
 * "orfani". L'albero dei processi non ha questa ambiguità.
 */
export function descendantsOf(root: number): Set<string> {
  const children = new Map<string, string[]>();
  try {
    for (const row of execSync("ps ax -o pid=,ppid=").toString().trim().split("\n")) {
      const [pid, ppid] = row.trim().split(/\s+/);
      if (!pid || !ppid) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  const queue = [String(root)];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}
