/**
 * The PTY bridge has to know how to retire.
 *
 * HISTORY (measured 2026-08-14 on this machine). `ps` showed 20 live PTY bridges
 * with ZERO clients and ZERO child sessions, up to 37 hours old, 15 of which
 * pointed at already deleted worktrees: ~365 MB sitting there. None of those processes
 * had ever written «Parent died» to its own log, meaning the orphan monitor had
 * never armed itself.
 *
 * WHY. The guard was `process.ppid === 1 && initialPpid !== 1`, and `initialPpid`
 * was read INSIDE `start()`, after `await checkExistingBridge()` and
 * `await selfTest()` (up to ~3s). If the server that launched it died in that
 * window, the bridge already read 1 as its initial ppid: the guard stayed false
 * forever and the monitor could never fire. A/B run on the bridge of that day,
 * same spawn, only variable the life of the parent: parent dead at once → bridge alive
 * after 5 minutes, log without a line of «Parent died»; parent alive 6s → out on
 * schedule.
 *
 * WHAT THIS FILE MEASURES. The two pieces that close the hole: `--parent-pid` (whoever
 * launched it SAYS so, no guessing the ppid or when to read it)
 * and the idle backstop (no client, no session → retire anyway),
 * which is the net for the cases no check on the parent can cover — recycled pid,
 * worktree swept from under it, `bun test` dead with no afterAll.
 * The other two tests pin down why the bridge is detached: with a
 * live parent, or with a server attached, it must not die.
 *
 * Note: the bridge runs under **node** (node-pty does not work under Bun), so
 * `node` is spawned, not `process.execPath`.
  * @covers PTYORPH-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeBin, nodeMancanteMessage } from "./lib/test-node-bin";
import { slackMs } from "../tests/helpers/time-slack";
import { guiSessionName } from "./pty-bridge-platform.mjs";

/** L'eseguibile Node con cui lanciare il ponte. */
const NODE = resolveNodeBin();

const BRIDGE = join(import.meta.dir, "pty-bridge.mjs");
// Tick ridotto via env per non sedersi attraverso i 5s di produzione a ogni run.
// Production never sets TOPICS_PTY_BRIDGE_MONITOR_TICK_MS.
const MONITOR_TICK_MS = 500;
const BRIDGE_ENV_FAST = { TOPICS_PTY_BRIDGE_MONITOR_TICK_MS: String(MONITOR_TICK_MS) };

/**
 * The idle backstop window GIVEN TO THE BRIDGE for these tests, and the two
 * budgets measured against it.
 *
 * Two seconds is a window the test has to WIN: the client below must be
 * connected before it elapses, or the bridge retires exactly as designed and
 * the test blames the backstop for the machine. That is the red of 2026-09-07
 * (card 0f4cbccb, load ~11 on 12 cores), green alone straight after. So the
 * window - and everything sized on it - is widened with the load, and stays
 * exactly two seconds on a quiet machine, where a bridge that fails to accept a
 * connection in two seconds is still a bug.
 */
const IDLE_EXIT_MS = slackMs(2_000);
/** Long enough to catch a connect that has to cross a loaded scheduler. */
const CLIENT_OPEN_MS = slackMs(5_000);
/**
 * The idle window for the ONE case that has to attach a client first, and it is
 * deliberately not `IDLE_EXIT_MS`.
 *
 * That case was racing itself. It allows the connect up to `CLIENT_OPEN_MS` to
 * complete, which is longer than `IDLE_EXIT_MS`: on a loaded machine the bridge
 * legitimately retired while the client was still crossing the scheduler, and
 * the test read that as "the backstop killed a bridge in use". The window the
 * case needs is one the attach cannot lose to, so it is the worst connect we
 * tolerate PLUS a full idle window on top.
 *
 * The assertion does not get weaker: the proof below still sleeps past this
 * window, so the backstop has had its chance and declined to fire.
 */
const BUSY_IDLE_EXIT_MS = CLIENT_OPEN_MS + IDLE_EXIT_MS;
/** The per-test ceiling, which has to hold all of the above. */
const CASE_MS = slackMs(40_000);

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
  }, CASE_MS);

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

    // The budget is wide because what is being measured is a NEGATIVE (nobody
    // renews the licence), and its proof is an exit that has to be waited for
    // through several ticks. Under the full suite this bridge is one of 1149
    // files competing for the machine: at `MONITOR_TICK_MS * 6 + 5s` it went red
    // at 8.9s on 2026-09-05 while passing alone in 22s, i.e. it was measuring the
    // load and not the monitor. The test still ends the moment the process dies.
    expect(await until(() => exited, MONITOR_TICK_MS * 12 + 20_000)).toBe(true);
  }, slackMs(90_000));

  test("un ponte con il padre VIVO resta su", async () => {
    const sock = socketPath("live");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS: "1000" });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    await Bun.sleep(MONITOR_TICK_MS * 2 + 2_000); // ben oltre due tick + grazia
    expect(exited).toBe(false);
  }, CASE_MS);
});

describe("pty-bridge · backstop idle", () => {
  test("senza client e senza sessioni si ritira ANCHE con il padre vivo", async () => {
    const sock = socketPath("idle");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_IDLE_EXIT_MS: String(IDLE_EXIT_MS) });

    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    expect(await until(() => exited, slackMs(20_000))).toBe(true);
    expect(existsSync(sock)).toBe(false);
  }, CASE_MS);

  test("con un client attaccato NON si ritira (il backstop non uccide chi è in uso)", async () => {
    const sock = socketPath("busy");
    const bridge = spawnBridge(sock, process.pid, { ...BRIDGE_ENV_FAST, TOPICS_PTY_BRIDGE_IDLE_EXIT_MS: String(BUSY_IDLE_EXIT_MS) });
    expect(await until(() => existsSync(sock), 15_000)).toBe(true);

    const client = net.connect(sock);
    cleanups.push(() => { try { client.destroy(); } catch { /* già chiuso */ } });
    expect(await until(() => client.readyState === "open", CLIENT_OPEN_MS)).toBe(true);

    let exited = false;
    void bridge.exited.then(() => { exited = true; });
    await Bun.sleep(BUSY_IDLE_EXIT_MS * 2); // well past the window it was given
    expect(exited).toBe(false);
  }, CASE_MS);
});

describe("pong", () => {
  // Il server rifà il ponte su questo campo (bridgeOutsideGuiSession): un ponte
  // nato da qui sta nella sessione di chi lo lancia, e deve dirlo.
  test("carries the bridge's launchd session", async () => {
    const sock = socketPath("pong");
    spawnBridge(sock, process.pid);
    expect(await until(() => existsSync(sock), 15_000)).toBe(true);
    const client = net.connect(sock);
    cleanups.push(() => client.destroy());
    const pong = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      client.on("data", (d) => {
        buffer += d.toString();
        for (const line of buffer.split("\n")) {
          try { const m = JSON.parse(line); if (m.type === "pong") resolve(m); } catch { /* riga a metà */ }
        }
      });
      client.on("error", reject);
      client.on("connect", () => client.write(JSON.stringify({ type: "ping" }) + "\n"));
    });
    expect(pong.session).toBe(guiSessionName());
  }, CASE_MS);
});
