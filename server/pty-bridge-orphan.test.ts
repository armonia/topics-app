/**
 * Il ponte PTY deve sapersi ritirare.
 *
 * STORIA (misurata il 2026-08-14 su questa macchina). `ps` mostrava 20 ponti PTY
 * vivi con ZERO client e ZERO sessioni figlie, fino a 37 ore di età, 15 dei quali
 * puntavano a worktree già cancellate: ~365 MB fermi lì. Nessuno di quei processi
 * aveva mai scritto «Parent died» nel proprio log, cioè il monitor anti-orfano non
 * si era mai armato.
 *
 * PERCHÉ. La guardia era `process.ppid === 1 && initialPpid !== 1`, e `initialPpid`
 * veniva letto DENTRO `start()`, dopo `await checkExistingBridge()` e
 * `await selfTest()` (fino a ~3s). Se il server che lo lanciava moriva in quella
 * finestra, il ponte leggeva già 1 come ppid iniziale: la guardia diventava falsa
 * per sempre e il monitor non poteva più scattare. A/B eseguito sul ponte di allora,
 * stesso spawn, unica variabile la vita del padre: padre morto subito → ponte vivo
 * dopo 5 minuti, log senza una riga di «Parent died»; padre vivo 6s → uscito nei
 * tempi previsti.
 *
 * COSA MISURA QUESTO FILE. I due pezzi che chiudono il buco: `--parent-pid` (chi ci
 * ha lanciato lo DICE, niente indovinelli sul ppid né sul momento in cui lo si
 * legge) e il backstop idle (nessun client, nessuna sessione → ci si ritira comunque),
 * che è la rete per i casi che nessun controllo sul padre può coprire — pid
 * riciclato, worktree spazzata via da sotto, `bun test` morto senza afterAll.
 * Gli altri due test tengono ferma la ragione per cui il ponte è detached: con un
 * padre vivo, o con un server attaccato, non deve morire.
 *
 * Nota: il ponte gira sotto **node** (node-pty non funziona sotto Bun), quindi si
 * spawna `node`, non `process.execPath`.
  * @covers PTYORPH-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeBin, nodeMancanteMessage } from "./lib/test-node-bin";

/** L'eseguibile Node con cui lanciare il ponte. */
const NODE = resolveNodeBin();

const BRIDGE = join(import.meta.dir, "pty-bridge.mjs");
// Tick ridotto via env per non sedersi attraverso i 5s di produzione a ogni run.
// Production never sets TOPICS_PTY_BRIDGE_MONITOR_TICK_MS.
const MONITOR_TICK_MS = 500;
const BRIDGE_ENV_FAST = { TOPICS_PTY_BRIDGE_MONITOR_TICK_MS: String(MONITOR_TICK_MS) };

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** Corto per forza: un socket unix oltre i 104 byte non si lega (EINVAL). */
function socketPath(name: string): string {
  const sock = join(tmpdir(), `ptb-${name}-${process.pid}.sock`);
  cleanups.push(() => {
    for (const p of [sock, sock.replace(/\.sock$/, ".pid")]) {
      try { rmSync(p, { force: true }); } catch { /* già sparito */ }
    }
  });
  return sock;
}

function spawnBridge(sock: string, parentPid: number, env: Record<string, string> = {}) {
  // `NODE` e non `"node"`: il PATH di chi esegue i test non e' garantito, e un
  // `ENOENT` qui produceva rossi che accusavano il monitor anti-orfano invece
  // dell'ambiente. Vedi `shared/test-node-bin.ts`.
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [NODE, BRIDGE, "--socket", sock, "--parent-pid", String(parentPid)],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...env } },
    );
  } catch (e) {
    throw new Error(nodeMancanteMessage(NODE, e));
  }
  cleanups.push(() => { try { proc.kill(9); } catch { /* già morto: è il caso di successo */ } });
  return proc;
}

/** Aspetta che `pred` sia vera, o scade. */
async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(100);
  }
  return pred();
}

/** Un pid sicuramente morto: si lancia qualcosa di banale e lo si raccoglie. */
async function deadPid(): Promise<number> {
  const corpse = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
  await corpse.exited;
  return corpse.pid;
}

describe("pty-bridge · monitor anti-orfano", () => {
  test("un ponte il cui --parent-pid è morto si ritira, e si porta via il socket", async () => {
    const sock = socketPath("orphan");
    const bridge = spawnBridge(sock, await deadPid(), { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS: "1000" });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    expect(await until(() => exited, MONITOR_TICK_MS * 3 + 5_000)).toBe(true);
    // shutdown() pulito scollega il socket; uno sporco lo lascerebbe lì a
    // ingannare il prossimo che prova a connettersi.
    expect(existsSync(sock)).toBe(false);
  }, 40_000);

  test("una sonda che si connette e chiude NON rinnova la licenza dell'orfano", async () => {
    // Come sopravvivevano davvero. Ogni ponte che prova a nascere esegue
    // `checkExistingBridge()`, che si connette qui e chiude in millisecondi. Il
    // monitor contava QUALSIASI connessione come «il server si è riagganciato» e
    // azzerava la scadenza: in ai-bridge/daemon.log, il 2026-08-14, «Parent died
    // … exit in 90s» e «Server reconnected» si alternavano all'infinito, e il pid
    // 41214 era ancora vivo dopo 12 minuti — padre morto e zero peer sul socket.
    const sock = socketPath("probe");
    const bridge = spawnBridge(sock, await deadPid(), {
      ...BRIDGE_ENV_FAST,
      TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS: "1000",
      // Una sonda vera dura ~1s (connect → ping → pong → close): la soglia sta
      // sopra, così le sonde qui sotto non contano mai come server.
      TOPICS_PTY_BRIDGE_REAL_CLIENT_MS: "3000",
    });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });

    // Sonde SOVRAPPOSTE: ognuna tiene aperto un secondo, una nuova ogni 800ms.
    // Il socket non è mai libero — la versione col buco non si armava nemmeno —
    // ma nessuna connessione raggiunge i 3s, quindi nessuna è un server.
    const open = new Set<ReturnType<typeof net.connect>>();
    const probing = setInterval(() => {
      const probe = net.connect(sock);
      open.add(probe);
      probe.on("error", () => { /* il ponte se n'è andato: è il caso di successo */ });
      setTimeout(() => { open.delete(probe); probe.destroy(); }, 1_000).unref();
    }, 800);
    cleanups.push(() => { clearInterval(probing); for (const p of open) p.destroy(); });

    expect(await until(() => exited, MONITOR_TICK_MS * 6 + 5_000)).toBe(true);
  }, 60_000);

  test("un ponte con il padre VIVO resta su", async () => {
    const sock = socketPath("live");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS: "1000" });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    await Bun.sleep(MONITOR_TICK_MS * 2 + 2_000); // ben oltre due tick + grazia
    expect(exited).toBe(false);
  }, 40_000);
});

describe("pty-bridge · backstop idle", () => {
  test("senza client e senza sessioni si ritira ANCHE con il padre vivo", async () => {
    const sock = socketPath("idle");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_IDLE_EXIT_MS: "2000" });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    expect(await until(() => exited, 20_000)).toBe(true);
    expect(existsSync(sock)).toBe(false);
  }, 40_000);

  test("con un client attaccato NON si ritira (il backstop non uccide chi è in uso)", async () => {
    const sock = socketPath("busy");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_IDLE_EXIT_MS: "2000" });
    expect(await until(() => existsSync(sock), 15_000)).toBe(true);

    const client = net.connect(sock);
    cleanups.push(() => { try { client.destroy(); } catch { /* già chiuso */ } });
    expect(await until(() => client.readyState === "open", 5_000)).toBe(true);

    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    await Bun.sleep(8_000); // quattro volte la finestra idle
    expect(exited).toBe(false);
  }, 40_000);
});
