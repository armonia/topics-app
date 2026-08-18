/**
 * Chiudere un'anteprima deve liberare la PORTA, non solo il wrapper.
 *
 * PERCHE' ESISTE. Il teardown mandava un segnale al solo pid che aveva
 * spawnato: ma il comando di un'anteprima e' `bun run dev`, cioe' un
 * LANCIATORE, e chi ascolta sulla porta e' un suo discendente. Il wrapper
 * moriva, il server no, la porta del pool restava occupata — e nessuno
 * raccoglieva quel processo: il rilevatore del pannello attribuisce per albero
 * di una PTY claude, e un'anteprima non e' figlia di nessuna PTY. Con 51 porte
 * bastano poche consegne per lasciare una card in review senza evidenza.
 *
 * Gli unit test di `preview-manager.test.ts` NON possono vederlo: il loro
 * `proc.kill()` finto alza un booleano, e un booleano non tiene una porta.
 * Quindi qui il wrapper e' VERO e forca un listener VERO, e la barra e' una
 * sola: dopo il teardown la porta si connette a nessuno entro 5s.
 *
 * La seconda parte misura la spazzata d'avvio sullo stesso scenario, che e'
 * dove il difetto fa piu' male: il registro delle anteprime vive sta in
 * memoria, quindi il server che muore mentre una e' su la perde per sempre.
 */
import { describe, expect, test, afterEach, beforeAll } from "bun:test";
import * as fs from "node:fs";
import net from "node:net";
import { createPreviewManager, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree } from "../../server/services/preview-manager";
import { killProcessTree } from "../../server/lib/process-tree";
import { testTmpDir } from "./helpers";

const TEST_ROOT = testTmpDir("preview-teardown-tree");
const WT_PATH = `${TEST_ROOT}/wt`;
const WT: PreviewWorktree = { id: "wt1", absPath: WT_PATH, branchName: "topics/x", projectId: "p1", mode: "branch" };

/**
 * Il pool si stringe a UNA porta: il test non deve frugare in 51. Ma il numero
 * si chiede al kernel, non si scrive a mano.
 *
 * Era `const PORT = 34117`, e una costante di modulo non è ermetica: due `bun
 * test` avviati insieme (due worktree, o una sessione accanto alla tua) si
 * contendono la stessa porta e si spengono il listener a vicenda. Misurato: la
 * stessa suite dà `3 pass` da sola e `2 pass / 1 fail` in coppia — un rosso che
 * non è del codice in prova. `listen(0)` fa scegliere al kernel una porta
 * effimera libera ADESSO, che è la stessa difesa di `testTmpDir` per i path.
 */
let PORT = 0;

function freeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("nessuna porta effimera"))));
    });
  });
}

beforeAll(async () => { PORT = await freeEphemeralPort(); });

const spawned: ReturnType<typeof Bun.spawn>[] = [];

/**
 * Il wrapper: una shell che FORCA un listener e aspetta. E' la forma di
 * `bun run dev` che il difetto non chiudeva — il pid che si conosce non e'
 * quello che ascolta.
 */
function spawnWrapper(port: number): PreviewProcess {
  fs.mkdirSync(WT_PATH, { recursive: true });
  const listener = `${TEST_ROOT}/listen.mjs`;
  fs.writeFileSync(
    listener,
    `import net from "node:net";\nnet.createServer((s) => s.end()).listen(${port}, "127.0.0.1");\nsetTimeout(() => {}, 600000);\n`,
  );
  // `node … &` piu' `wait`: il figlio e' un processo separato, e il cwd del
  // worktree lo eredita — esattamente cio' che il cancello d'identita' e la
  // spazzata riconoscono.
  const child = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${listener} & wait`], {
    cwd: WT_PATH,
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
  spawned.push(child);
  return {
    get pid() { return child.pid ?? null; },
    alive() { return child.exitCode === null && !child.killed; },
    kill() { try { child.kill(); } catch { /* gia' morto */ } },
  };
}

function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (taken: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(taken); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 400);
  });
}

async function waitPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portTaken(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await portTaken(port));
}

async function waitPortTaken(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portTaken(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function lsofBin(): string { return Bun.which("lsof") ?? "/usr/sbin/lsof"; }

async function cmdOut(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch { return ""; }
}

/** Le stesse deps di produzione per identita' e albero (server.ts le cabla cosi'). */
function realDeps(over: Partial<PreviewManagerDeps> = {}): PreviewManagerDeps {
  return {
    worktreeOf: () => WT,
    resolveCommand: () => ({ cmd: ["/bin/sh", "-c", "listener"], deepLinkPath: "/" }),
    spawn: () => spawnWrapper(PORT),
    probe: async () => portTaken(PORT),
    listenerPid: async (port) => {
      const out = await cmdOut([lsofBin(), "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      const pid = out.split(/\s+/).map(Number).find((n) => Number.isFinite(n) && n > 0);
      return pid ?? null;
    },
    processCwd: async (pid) => {
      const out = await cmdOut([lsofBin(), "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = out.split("\n").find((l) => l.startsWith("n/"));
      return line ? line.slice(1) : null;
    },
    realPath: async (p) => { try { return fs.realpathSync(p); } catch { return null; } },
    screenshot: async () => false,
    currentOutputUrl: () => null,
    setOutputUrl: () => {},
    setPreviewImage: () => {},
    addReviewNote: () => {},
    killTree: (pid) => killProcessTree(pid, 1000),
    knownWorktreePaths: () => [WT_PATH],
    mediaDir: `${TEST_ROOT}/media`,
    ensureMediaDir: () => { fs.mkdirSync(`${TEST_ROOT}/media`, { recursive: true }); },
    portRange: [PORT, PORT],
    readyTimeoutMs: 15_000,
    readyPollMs: 200,
    portFree: async (port) => !(await portTaken(port)),
    ...over,
  };
}

/** Il cwd di un pid, canonicalizzato: `/tmp` su macOS e' un link a `/private/tmp`. */
async function canonicalCwdOf(pid: number): Promise<string | null> {
  const deps = realDeps();
  const cwd = await deps.processCwd?.(pid);
  if (!cwd) return null;
  try { return fs.realpathSync(cwd); } catch { return cwd; }
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try { child.kill(); } catch { /* gia' morto */ }
  }
  // La porta deve tornare libera anche quando un test fallisce, o il prossimo
  // misurerebbe lo sporco di questo.
  //
  // MA SOLO SE E' NOSTRA. Questa riga risolveva «chi tiene la porta» con `lsof`
  // e gli mandava un `killProcessTree` senza nessuna delle domande che il codice
  // in prova si fa: e' la pulizia di un test che ammazza un processo di cui non
  // sa niente. Con la porta effimera la collisione e' improbabile, ma
  // «improbabile» non e' il criterio giusto per un SIGKILL — il predicato e' lo
  // stesso di `sweepOrphans`: il cwd deve stare nel worktree del test.
  const pid = (await realDeps().listenerPid?.(PORT)) ?? 0;
  if (pid > 0) {
    const cwd = await canonicalCwdOf(pid);
    let mine = WT_PATH;
    try { mine = fs.realpathSync(WT_PATH); } catch { /* la cartella puo' non esserci ancora */ }
    if (cwd && (cwd === mine || cwd.startsWith(mine + "/"))) {
      await killProcessTree(pid, 200).catch(() => {});
    }
  }
  await waitPortFree(PORT, 3000);
});

describe("teardown di un'anteprima", () => {
  test("libera la PORTA, non solo il wrapper", async () => {
    const mgr = createPreviewManager(realDeps());
    const preview = await mgr.ensurePreview("task-tree-1");
    expect(preview?.port).toBe(PORT);
    expect(await waitPortTaken(PORT)).toBe(true);

    await mgr.teardown("task-tree-1");

    // LA BARRA. Col solo `proc.kill()` sul wrapper il listener sopravvive e
    // questa resta falsa: la porta e' persa per sempre.
    expect(await waitPortFree(PORT, 5000)).toBe(true);
  }, 60_000);

  test("la spazzata d'avvio chiude un'anteprima rimasta da un server morto", async () => {
    // Un'anteprima nata da un processo che non c'e' piu': il wrapper viene
    // avviato a mano, quindi il manager nuovo non ne sa niente — come dopo un
    // riavvio, dove il registro (in memoria) e' vuoto ma il processo no.
    spawnWrapper(PORT);
    expect(await waitPortTaken(PORT)).toBe(true);

    const mgr = createPreviewManager(realDeps());
    expect(mgr.list()).toEqual([]);
    const cleared = await mgr.sweepOrphans();

    expect(cleared).toEqual([PORT]);
    expect(await waitPortFree(PORT, 5000)).toBe(true);
  }, 60_000);

  test("la spazzata non tocca chi ascolta da una cartella che non e' un worktree", async () => {
    // Il falso positivo da non fare mai: il dev server di una persona, sulla
    // stessa porta, da un'altra cartella.
    spawnWrapper(PORT);
    expect(await waitPortTaken(PORT)).toBe(true);

    const mgr = createPreviewManager(realDeps({ knownWorktreePaths: () => [`${TEST_ROOT}/un-altro-posto`] }));
    expect(await mgr.sweepOrphans()).toEqual([]);
    expect(await portTaken(PORT)).toBe(true);
  }, 60_000);
});
