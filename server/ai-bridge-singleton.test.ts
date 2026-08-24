import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Who owns the broker socket, and who is allowed to take it away.
//
// On 2026-08-13 this contract cost the machine twice in one hour, once even
// across a reboot: 1612 daemons on a single socket in twelve minutes, 3653
// processes, 36 GB of swap on a 32 GB box, load 644, and the server on :3333
// unreachable. The cause was one line of judgement: `probeBridge` returns
// `timeout` both when the owner is dead and when the machine is too loaded for
// it to answer within 1.5s, and `checkExistingBridge` treated the two the same.
// Every new daemon evicted the previous one; `listen()` on a just-unlinked path
// does not fail with EADDRINUSE but creates a new file, so all of them stayed
// alive and none was reachable.
//
// These tests fence that judgement. The first one is the one that matters: it
// must be seen RED against the pre-fix daemon.

const BRIDGE = join(import.meta.dir, "ai-bridge.mjs");
const PROBE_MS = 1_500; // the timeout inside probeBridge()

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-singleton-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } });
  return dir;
}

function socketPath(name: string): string {
  // Keep it short: a unix socket path over 104 bytes fails to bind (EINVAL).
  const sock = join(tmpdir(), `abs-${name}-${process.pid}.sock`);
  cleanups.push(() => {
    for (const p of [sock, `${sock}.lock`, pidPathFor(sock)]) {
      try { rmSync(p, { force: true }); } catch { /* already gone */ }
    }
  });
  return sock;
}

/** The pid file the daemon writes next to its socket. */
function pidPathFor(sock: string): string {
  return sock.replace(/\.sock$/, ".pid");
}

/**
 * An owner that ACCEPTS the connection and never answers: this is the loaded
 * machine, not a dead daemon. It runs in its own process, because the whole
 * point of the test is that this process survives.
 */
async function muteOwner(sock: string): Promise<{ pid: number; alive: () => boolean }> {
  const code = `
    const net = require("net"), fs = require("fs");
    const srv = net.createServer(() => { /* accept and stay silent */ });
    srv.listen(${JSON.stringify(sock)}, () => {
      fs.writeFileSync(${JSON.stringify(pidPathFor(sock))}, String(process.pid));
      console.log("ready");
    });
    setTimeout(() => process.exit(0), 30000);
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { try { proc.kill(9); } catch { /* already dead */ } });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(pidPathFor(sock))) {
    await Bun.sleep(50);
  }
  return {
    pid: proc.pid,
    alive: () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } },
  };
}

function spawnDaemon(sock: string, store: string) {
  const proc = Bun.spawn(
    [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
    { stdout: "pipe", stderr: "pipe" },
  );
  cleanups.push(() => { try { proc.kill(9); } catch { /* already dead */ } });
  return proc;
}

function someoneListening(sock: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((res) => {
    if (!existsSync(sock)) { res(false); return; }
    const c = net.connect(sock);
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; try { c.destroy(); } catch { /* already closed */ } res(v); };
    c.on("connect", () => finish(true));
    c.on("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

describe("ai-bridge · socket ownership", () => {
  test("a LIVE owner that is merely too slow to answer is not evicted", async () => {
    const sock = socketPath("mute");
    const store = storeDir();
    const owner = await muteOwner(sock);
    expect(owner.alive()).toBe(true);

    const proc = spawnDaemon(sock, store);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    // The newcomer backs off...
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NOT evicting it");
    // ...and above all it does not touch the incumbent. This is the assertion
    // whose absence turned a loaded machine into 1612 processes.
    expect(owner.alive()).toBe(true);
    // The pid file still names the owner: nobody stole its place.
    expect(readFileSync(pidPathFor(sock), "utf8").trim()).toBe(String(owner.pid));
  }, 20_000);

  test("a stale socket with nobody listening is taken over", async () => {
    const sock = socketPath("stale");
    const store = storeDir();
    // The file exists but is not a live socket, and the recorded pid does not
    // exist: this is the case where evicting is right, and the daemon MUST take
    // the socket rather than back off.
    writeFileSync(sock, "");
    writeFileSync(pidPathFor(sock), "999999");

    const proc = spawnDaemon(sock, store);

    // La pazienza e' un TETTO, non una misura: il daemon deve solo prendersi il
    // socket. Con 8 s cadeva dentro `test:unit` intero, dove far nascere un
    // processo Bun mentre 853 file girano prende molto piu' del solito, e il
    // rosso raccontava il carico della macchina invece del comportamento.
    const deadline = Date.now() + 25_000;
    let taken = false;
    while (Date.now() < deadline && !taken) {
      taken = await someoneListening(sock);
      if (!taken) await Bun.sleep(100);
    }
    expect(taken).toBe(true);
    // ASPETTARE ANCHE IL PID, e non solo l'ascolto: sono due eventi, in
    // quest'ordine, e il test guardava fra l'uno e l'altro.
    //
    // Nel daemon il pid si scrive DENTRO il callback di `listen()`
    // (ai-bridge.mjs: `server.listen(...)` poi `writeFileSync(pidPath)`),
    // quindi c'e' una finestra in cui il socket risponde gia' e il file non
    // esiste ancora. `someoneListening` la vede aperta e il `readFileSync`
    // subito dopo esplodeva con ENOENT. Misurato nella suite intera: l'ascolto
    // c'era dopo 300ms, il pid file no.
    //
    // Non e' un difetto del daemon: scrive il pid PRIMA di rilasciare il lock,
    // che e' l'ordine che conta per chi si contende il socket. E' il test che
    // trattava due eventi come uno. Stessa pazienza dell'attesa qui sopra,
    // perche' il motivo e' lo stesso: sotto carico ogni passo dura di piu'.
    let pid: string | null = null;
    const pidDeadline = Date.now() + 25_000;
    while (Date.now() < pidDeadline && pid === null) {
      try {
        pid = readFileSync(pidPathFor(sock), "utf8").trim();
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(pid).toBe(String(proc.pid));
  }, 40_000);

  test("five daemons racing for a free socket leave exactly ONE listening", async () => {
    const sock = socketPath("race");
    const store = storeDir();

    const racers = Array.from({ length: 5 }, () => spawnDaemon(sock, store));

    // Wait for the race to settle: the losers EXIT, which is the whole point.
    // Before the fix they all ended up listening and stayed alive forever.
    /* LA SCADENZA, e perche' non era abbastanza.
     *
     * Misurato: sotto la suite intera questo caso e' fallito a **12.198 ms**
     * contro una scadenza di 12.000 — mancava un quinto di secondo. Da solo
     * passa sempre (tre giri su tre, ~2 s). Non e' quindi un difetto della
     * gara: e' che cinque processi che nascono, sondano e muoiono impiegano
     * piu' tempo quando la macchina sta gia' girando 876 file di test.
     *
     * Il tempo non e' cio' che questo caso prova. L'affermazione e' «i perdenti
     * ESCONO, e ne resta uno solo in ascolto»; quanto ci mettono e' un
     * dettaglio dell'ambiente. Una scadenza tarata sulla macchina scarica
     * trasforma quella affermazione in una misura di velocita' della macchina,
     * e produce un rosso che accusa la gara mentre parla del carico.
     *
     * Il tetto del test (30 s) resta la vera rete di sicurezza: se i perdenti
     * NON escono davvero — il difetto che questo caso esiste per cogliere —
     * qui si aspetta invano e il rosso arriva lo stesso, solo piu' tardi. */
    const deadline = Date.now() + PROBE_MS * 4 + 18_000;
    let alive = racers.length;
    while (Date.now() < deadline) {
      alive = racers.filter((p) => p.exitCode === null && p.signalCode === null).length;
      if (alive <= 1) break;
      await Bun.sleep(200);
    }

    expect(alive).toBe(1);
    // ── SE QUESTA RIGA E' ROSSA, NON DARE LA COLPA AL CARICO PER PRIMO.
    //    Il commento della scadenza qui sopra spiega bene perche' e' generosa,
    //    ma da' anche l'impressione che un rosso qui sia sempre lentezza. Il
    //    24/08 non lo era: aspettando OLTRE la scadenza, i perdenti che non
    //    erano usciti entro 24s non uscivano nemmeno a 30, 45 e 60. Restavano
    //    vivi, e due di loro avevano stampato «Listening» sullo stesso path.
    //
    //    Causa trovata e corretta in `ai-bridge.mjs` (553e60409): il pid si
    //    scriveva DENTRO il callback di `listen()`, quindi c'era un istante in
    //    cui il socket accettava e il pid file non esisteva. Chi sondava li'
    //    dentro leggeva `timeout` senza owner registrato, concludeva «libero» e
    //    subentrava a un processo vivo. Ora il pid si scrive prima, e un
    //    `timeout` vale come «qualcuno ascolta» anche senza pid.
    //
    //    Prima: 2 fallimenti su 12. Dopo: 30 giri su 30 verdi, e ricostruendo
    //    il codice vecchio il difetto torna (1 su 20). Se questa riga si
    //    ripresenta rossa, la sonda utile scrive lo stderr dei daemon su FILE:
    //    leggere lo stream di un processo ancora vivo blocca chi legge.
    expect(await someoneListening(sock)).toBe(true);
    // 45 s e non 30: la scadenza interna arriva a 24, e un tetto che scatta
    // PRIMA di quella attesa la renderebbe inutile — il test morirebbe per
    // timeout di bun invece di dire quanti daemon sono rimasti vivi, che e'
    // l'unica informazione utile quando questo caso fallisce davvero.
  }, 45_000);
});
