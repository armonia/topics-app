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
 * propria `DATA_DIR` e i propri socket. Senza la variabile il checkout
 * principale resta identico a prima (13334 + `/tmp/topics-test-data`): il
 * singolo `npx playwright test` non cambia di una virgola.
 *
 * Un WORKTREE di dispatch, invece, non riceve più 13334 ma una porta derivata
 * dal path del checkout — vedi `worktree-port.ts` per il perché (in breve: due
 * run sulla stessa porta si ammazzano il server a vicenda, e l'ho pagato due
 * volte in rossi finti).
 */

import { realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { IS_WINDOWS, processRows } from "./platform";
import { defaultE2EPort, E2E_DEFAULT_PORT } from "./worktree-port";

/**
 * Il checkout a cui appartiene QUESTO file — non `process.cwd()`, che cambia a
 * seconda della cartella da cui si lancia Playwright e renderebbe la porta
 * derivata instabile (porta diversa = `DATA_DIR` diversa = bundle da ricopiare).
 * `__dirname` è disponibile sia sotto Playwright (che transpila in CJS, e lo usa
 * già in `global-setup.ts`) sia sotto Bun.
 */
const CHECKOUT_ROOT = resolve(__dirname, "../../..");

export const E2E_PORT = Number(
  process.env.E2E_PORT || defaultE2EPort(CHECKOUT_ROOT, homedir()),
);

/**
 * Da dove viene la porta. Serve al `global-setup` per DIRLO: una porta diversa
 * da 13334 senza spiegazione fa cercare a vuoto (`/tmp/topics-test-data` non si
 * aggiorna più, il server "non parte"), e la riga di log è la differenza fra
 * un'isolazione che si capisce e una che sembra un guasto.
 */
export const E2E_PORT_ORIGIN: "env" | "worktree" | "default" = process.env.E2E_PORT
  ? "env"
  : E2E_PORT === E2E_DEFAULT_PORT
    ? "default"
    : "worktree";

export const E2E_BASE = `http://localhost:${E2E_PORT}`;

export const E2E_WS_BASE = `ws://localhost:${E2E_PORT}`;

/**
 * La porta «da fuori» del server di test.
 *
 * Serve perché il confinamento di un ospite NON è osservabile da loopback: la
 * rete anti-lockout della 080 fa proprietaria ogni richiesta locale, senza
 * chiedere credenziali. Un test che bussasse alla porta principale con il
 * biscotto di un ospite vedrebbe un proprietario, e passerebbe dicendo il
 * contrario di ciò che voleva dire.
 *
 * `+ 1000` e non `+ 1`: le porte principali occupano 13334 e 13500–13899
 * (`worktree-port.ts`), quindi un offset piccolo farebbe collidere il tunnel di
 * un worktree con la porta principale di un altro, e due suite in parallelo si
 * ammazzerebbero a vicenda per un motivo illeggibile.
 */
export function tunnelPortFor(port: number = E2E_PORT): number {
  return port + 1000;
}

export const E2E_TUNNEL_BASE = `http://127.0.0.1:${tunnelPortFor(E2E_PORT)}`;
export const E2E_TUNNEL_WS_BASE = `ws://127.0.0.1:${tunnelPortFor(E2E_PORT)}`;

/**
 * The scratch ROOT, canonical: `/private/tmp` on macOS, `/tmp` on Linux.
 *
 * A FUNCTION and not a constant because a spec composes its paths at module
 * level, before anything is on disk, and only the root can be resolved that
 * early. `scripts/check-tmp-canonical.ts` is what keeps the literal from
 * coming back; `helpers/file-project.ts` builds `canonicalTmpDir()` on top.
 *
 * It lives HERE, next to the bench paths, because the bench root itself has to
 * obey the rule: see `dataDirForPort` below.
 */
export function canonicalTmpRoot(): string {
  // Windows has no `/tmp`, and `os.tmpdir()` is NOT the answer on POSIX: on
  // macOS it points at the per-user `/var/folders/...` sandbox, so reading it
  // here would move DATA_DIR away from the path `.gitignore`, the scripts and
  // muscle memory all point at. The rule below is therefore per platform, not
  // "the portable call everywhere".
  const root = IS_WINDOWS ? tmpdir() : "/tmp";
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Dove vive lo stato del server di test per una data porta.
 *
 * La porta di default tiene il percorso storico: script, `.gitignore` e memoria
 * muscolare puntano lì, e uno shard singolo non deve cambiare nulla.
 *
 * CANONICAL ROOT, and it is the whole reason `canonicalTmpRoot` sits in this
 * file. `${OPENCLAW_DIR}/workspace` hangs off this directory, so every project
 * created inside it is named by this string on BOTH sides of the bench — and
 * the server does not spell it the same way twice: a project reached by BARE
 * NAME keeps the raw path the workspace scan produced, while one reached by
 * ABSOLUTE PATH goes through `canonicalProjectPath` (server/routes/topics.ts,
 * `resolveProjectRef`). On macOS `/tmp` is a link to `/private/tmp`, so with a
 * raw root those two spellings disagree and the SAME folder answers under two
 * names: measured on PROJCMD-4, which asserted the binding of
 * `/tmp/…/workspace/e2e-test-proj-…` and got `/private/tmp/…` back, while
 * PROJCMD-1 and PROJCMD-3 (bare name) stayed green next to it. On the Linux
 * runner the two spellings are the same string, so CI never saw it.
 *
 * Resolving the root once removes the whole class from the bench instead of
 * teaching each spec which of its own paths the server will rewrite.
 */
export function dataDirForPort(port: number): string {
  const root = canonicalTmpRoot();
  // `join` and not a `/` template: on Windows the root is a drive path and the
  // mixed separator that came out of the template travelled into DATA_DIR, into
  // every path a spec compares against, and into the server's own canonical
  // spelling - three places that then disagreed on the same folder.
  return join(root, port === E2E_DEFAULT_PORT ? "topics-test-data" : `topics-test-data-${port}`);
}

/**
 * Dove sta la FOTOGRAFIA del bundle servita da quel server.
 *
 * Non è `public/` del repo: quella cartella è viva. `vite build --watch` la
 * svuota e la riscrive a ogni salvataggio nel client, e nella finestra in cui
 * `index.html` non c'è il server risponde "no such file or directory". L'app
 * non si carica e falliscono test a caso — nell'ultima run erano i terminali,
 * accusati di non renderizzare xterm mentre il problema era che non c'era la
 * pagina. `global-setup.ts` copia il bundle qui una volta e ci punta il server.
 */
export function publicDirForPort(port: number): string {
  return join(dataDirForPort(port), "public");
}

/**
 * The bench's own IPC endpoint for a bridge, per port.
 *
 * A Unix socket is a FILE and a Windows named pipe is not: `\\.\pipe\<name>` is
 * the only spelling `net.connect` accepts there, and a `/tmp/...sock` handed to
 * a Windows server fails with ENOENT, which the terminal route reads as "no
 * bridge" - terminals that simply never open. The server derives exactly this
 * shape when nothing overrides it (`getSocketPath` in server/routes/terminal.ts);
 * the bench has to speak the same dialect or its isolation is a broken pipe.
 */
function bridgeSocket(kind: "pty-bridge" | "ai-bridge", port: number): string {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\topics-${kind}-e2e-${port}`
    : `/tmp/topics-${kind}-e2e-${port}.sock`;
}

/** La `DATA_DIR` di QUESTO processo — le spec la leggono per ispezionare i file scritti dal server. */
export const E2E_DATA_DIR = process.env.DATA_DIR || dataDirForPort(E2E_PORT);

/** La HOME isolata del server (`start-test-server.sh` la esporta, alcune spec ci seminano dentro). */
export const E2E_HOME = join(E2E_DATA_DIR, ".home");

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
    TOPICS_HOME: join(dataDir, ".topics-home"),
    // Config e sessioni OpenClaw dell'utente vero fuori dai piedi: SESSIONS_DIR
    // deriva da OPENCLAW_DIR, quindi questa sola variabile copre entrambi.
    OPENCLAW_DIR: join(dataDir, ".openclaw"),
    // Socket del PTY-bridge: senza, viene derivato dalla cwd — che il server di
    // test CONDIVIDE con quello di sviluppo — e il reconcile del test vedrebbe
    // le PTY Claude vive dello sviluppo come orfane, ammazzandole.
    TOPICS_PTY_SOCKET: bridgeSocket("pty-bridge", port),
    // Stessa storia per il broker stream-json.
    TOPICS_AI_BRIDGE_SOCKET: bridgeSocket("ai-bridge", port),
    // Il bundle servito è la fotografia fatta dal globalSetup, non `public/` del
    // repo: vedi publicDirForPort qui sopra.
    TOPICS_PUBLIC_DIR: publicDirForPort(port),
    NO_TLS: "1",
    // Arma le route di reset (`/api/test/checkpoint`, `/api/test/reset`). Sono
    // distruttive per costruzione — svuotano ogni tabella — quindi esistono solo
    // dove questa variabile c'è: vedi server/routes/e2e.ts.
    TOPICS_E2E: "1",
    // L'ascoltatore «da fuori»: ciò che entra di qui non è locale per
    // definizione, ed è l'unico modo di provare il confinamento com'è in
    // produzione invece che con una scorciatoia buona solo per i test.
    TOPICS_TUNNEL_PORT: String(tunnelPortFor(port)),
    // THE GATEWAY URL IS DECLARED ONLY IF SOMEONE IS ACTUALLY LISTENING.
    // THE TOKEN, INSTEAD, IS ALWAYS DECLARED — and the difference is the whole
    // point, because getting it wrong breaks the terminal tests.
    //
    // A fake GATEWAY_URL elected `openclaw` as the bench's AI provider
    // (`providers/index.ts` registers it when GATEWAY_URL **and** GATEWAY_TOKEN
    // are both present) while nothing answered on :18789. Consequence: a sent
    // message opened a turn that NEVER ENDED — the server kept reporting
    // `state: "streaming"` and the composer stayed on the `queue` action,
    // because with a turn in flight Enter parks the text instead of sending it.
    // It was also the source of the thousands of "[GatewayWS] Connect failed"
    // lines in the nightly logs, in every shard, including the green ones.
    // Dropping the URL is enough to stop that: the election needs BOTH.
    //
    // The token is a different job that happens to share a name. It is also the
    // legacy credential `agentAuthOk()` accepts on the terminal routes (see
    // server/routes/terminal.ts), and api-fixtures.ts sends it as
    // `x-gateway-token` on every terminal call. Dropping it too — as a first
    // attempt did — made GET /sessions/:id/buffer answer 401 to the bench
    // itself, so TERM-02 read an empty buffer and failed while the product was
    // perfectly fine. Measured: red 2 runs out of 2 without it, green with.
    GATEWAY_TOKEN: process.env.GATEWAY_TOKEN ?? "test-token",
    ...(process.env.GATEWAY_URL ? { GATEWAY_URL: process.env.GATEWAY_URL } : {}),
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
  for (const { pid, ppid } of processRows()) {
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
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
