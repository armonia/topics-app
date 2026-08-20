// Il ponte PTY che QUESTA macchina esegue davvero.
//
// Il server sotto launchd usa `server/pty-bridge.mjs` a meno che
// `TOPICS_PTY_BRIDGE_BIN` non sia impostata (lo fa solo Tauri). Le quattro
// modifiche della campagna sui `kill` erano arrivate a entrambi i ponti, ma il
// test — `desktop-tauri/pty-bridge/tests/kill.rs` — copriva solo quello Rust:
// il ponte in produzione qui era l'unico senza barra. Questo file gliela mette,
// e la mette allo stesso modo (un daemon vero, un socket vero, i frame veri):
// il protocollo è l'unica superficie che il server conosce, e una prova che non
// passi di lì non prova niente su ciò che il server vedrà.
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { testTmpDir, PROJECT_ROOT } from "./helpers";
import { resolveNodeBin, nodeMancanteMessage } from "../../shared/test-node-bin";

const ROOT = testTmpDir("pty-bridge-mjs");
const BRIDGE = path.join(PROJECT_ROOT, "server", "pty-bridge.mjs");

/** L'eseguibile Node con cui lanciare il ponte: il PATH di chi esegue i test
 *  non e' garantito. La ricerca e il messaggio d'errore stanno in
 *  `shared/test-node-bin.ts`, condivisi con `server/pty-bridge-orphan.test.ts` —
 *  due copie della stessa ricerca divergono, e la seconda si scopre rotta solo
 *  quando fallisce come la prima. */
const NODE = resolveNodeBin();
/** Corta per forza: un socket unix oltre i 104 byte non si lega (EINVAL). */
const GRACE_MS = 400;

interface Frame { type: string; id?: string; [k: string]: unknown }

class Bridge {
  private constructor(
    readonly proc: ReturnType<typeof Bun.spawn>,
    readonly socketPath: string,
    readonly pidPath: string,
  ) {}

  static async start(label: string, env: Record<string, string> = {}): Promise<Bridge> {
    const socketPath = path.join(ROOT, `${label}.sock`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        [NODE, BRIDGE, "--socket", socketPath, "--parent-pid", String(process.pid)],
        {
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, TOPICS_PTY_BRIDGE_KILL_GRACE_MS: String(GRACE_MS), ...env },
        },
      );
    } catch (e) {
      // ACCUSA L'AMBIENTE, non il ponte. Un `ENOENT` grezzo qui produceva
      // cinque rossi che sembravano difetti dello shutdown, e sono costati una
      // diagnosi: il rosso deve dire cosa manca e come si ripara.
      throw new Error(nodeMancanteMessage(NODE, e));
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(socketPath)) break;
      await Bun.sleep(50);
    }
    if (!fs.existsSync(socketPath)) throw new Error("il ponte non ha mai messo in ascolto");
    return new Bridge(proc, socketPath, socketPath.replace(/\.sock$/, ".pid"));
  }

  stop(): void {
    try { this.proc.kill("SIGKILL"); } catch { /* già uscito */ }
  }
}

/** Un client del ponte che sa aspettare un frame. */
class Client {
  private frames: Frame[] = [];
  private constructor(private readonly sock: net.Socket) {}

  static connect(b: Bridge): Promise<Client> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(b.socketPath);
      const c = new Client(sock);
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try { c.push(JSON.parse(line) as Frame); } catch { /* riga parziale */ }
        }
      });
      sock.on("error", reject);
      sock.on("connect", () => resolve(c));
    });
  }

  private push(f: Frame): void { this.frames.push(f); }
  send(msg: Record<string, unknown>): void { this.sock.write(JSON.stringify(msg) + "\n"); }
  close(): void { try { this.sock.destroy(); } catch { /* già chiuso */ } }

  /** Il primo frame che soddisfa `pred`, o `null` allo scadere. */
  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await Bun.sleep(20);
    }
    return null;
  }

  /** Quanti ne arrivano nella finestra. Serve a provare che il SECONDO non c'è. */
  async countIn(windowMs: number, pred: (f: Frame) => boolean): Promise<number> {
    await Bun.sleep(windowMs);
    return this.frames.filter(pred).length;
  }

  async list(): Promise<string[]> {
    this.frames = this.frames.filter((f) => f.type !== "list");
    this.send({ type: "list" });
    const l = await this.waitFor((f) => f.type === "list", 5_000);
    const sessions = (l?.sessions ?? []) as Array<{ id: string }>;
    return sessions.map((s) => s.id);
  }
}

const bridges: Bridge[] = [];
const clients: Client[] = [];

async function bridgeWithClient(label: string, env?: Record<string, string>): Promise<{ b: Bridge; c: Client }> {
  const b = await Bridge.start(label, env);
  bridges.push(b);
  const c = await Client.connect(b);
  clients.push(c);
  return { b, c };
}

function create(c: Client, id: string, script: string): void {
  c.send({ type: "create", id, shell: "/bin/sh", args: ["-c", script], cwd: ROOT, cols: 80, rows: 24 });
}

/** `kill -0`: vero anche per uno zombie, e va bene — l'`exit` arriva dopo la reap. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(() => { for (const c of clients.splice(0)) c.close(); });
afterAll(() => { for (const b of bridges.splice(0)) b.stop(); });

// `node` deve esserci: il ponte USA node-pty, che sotto Bun non gira. Se manca,
// in produzione non ci sarebbero terminali affatto.
beforeAll(() => { expect(fs.existsSync(BRIDGE)).toBe(true); });

describe("kill finisce con un figlio MORTO, non con un frame ottimista", () => {
  /**
   * IL DIFETTO. `kill` era un solo SIGHUP e la voce usciva dalla mappa PRIMA
   * che qualcuno avesse confermato la morte: un figlio che intrappola HUP
   * sopravviveva e da quel momento non esisteva per nessuno — non per `list`,
   * non per la riconciliazione, non per lo shutdown. Un PTY vivo e
   * irraggiungibile fino alla morte della macchina.
   */
  test("un figlio che ignora SIGHUP viene ucciso lo stesso, e ne esce un exit", async () => {
    const { c } = await bridgeWithClient("kill");
    // `echo PRONTO` non è decorazione: senza aspettare quel byte il kill può
    // arrivare mentre la shell sta ancora partendo, con HUP ancora al default,
    // e allora muore per la ragione sbagliata.
    create(c, "s1", 'trap "" HUP; echo PRONTO; sleep 300');
    const created = await c.waitFor((f) => f.type === "created" && f.id === "s1");
    expect(created).not.toBeNull();
    const pid = created?.pid as number;
    expect(await c.waitFor((f) => f.type === "data" && f.id === "s1" && String(f.data).includes("PRONTO"))).not.toBeNull();

    c.send({ type: "kill", id: "s1" });
    // `killed` acka la RICHIESTA, non la morte: la morte è l'`exit`.
    expect(await c.waitFor((f) => f.type === "killed" && f.id === "s1", 5_000)).not.toBeNull();
    expect(await c.waitFor((f) => f.type === "exit" && f.id === "s1")).not.toBeNull();
    expect(pidAlive(pid)).toBe(false);
    expect(await c.list()).not.toContain("s1");
  }, 40_000);

  /**
   * L'altra metà: finché il figlio è vivo la voce RESTA. È ciò che rende la
   * sessione visibile a `list`, alla riconciliazione e allo shutdown mentre la
   * grazia scorre — la proprietà che il vecchio `sessions.delete` immediato
   * distruggeva.
   */
  test("durante la grazia la sessione è ancora in list", async () => {
    const { c } = await bridgeWithClient("grace", { TOPICS_PTY_BRIDGE_KILL_GRACE_MS: "3000" });
    create(c, "s2", 'trap "" HUP; echo PRONTO; sleep 300');
    expect(await c.waitFor((f) => f.type === "data" && f.id === "s2" && String(f.data).includes("PRONTO"))).not.toBeNull();
    c.send({ type: "kill", id: "s2" });
    expect(await c.waitFor((f) => f.type === "killed" && f.id === "s2", 5_000)).not.toBeNull();
    // Ackato il kill, il figlio è ancora vivo e la voce c'è: nessuno l'ha persa.
    expect(await c.list()).toContain("s2");
    expect(await c.waitFor((f) => f.type === "exit" && f.id === "s2", 15_000)).not.toBeNull();
    expect(await c.list()).not.toContain("s2");
  }, 40_000);
});

describe("un id, un PTY", () => {
  /**
   * Due `create` sullo stesso id (la doppia POST /revive) costruivano DUE figli
   * sopra una sola voce di mappa; il primo a uscire trasmetteva un `exit` che
   * portava via il superstite, che da lì in poi non stava né in questa mappa né
   * in quella del server.
   */
  test("il secondo create trova l'id occupato e risponde `exists`", async () => {
    const { c } = await bridgeWithClient("dup");
    create(c, "dup1", "sleep 300");
    create(c, "dup1", "sleep 300");
    expect(await c.countIn(1_500, (f) => f.type === "created" && f.id === "dup1")).toBe(1);
    const err = await c.waitFor((f) => f.type === "error" && f.id === "dup1", 3_000);
    // `code: 'exists'` non è cosmetica: il server conta i frame `error`
    // consecutivi come guasti di spawn e a tre ricicla l'intero ponte, e questo
    // non è un guasto di spawn.
    expect(err?.code).toBe("exists");
    expect((await c.list()).filter((id) => id === "dup1").length).toBe(1);
  }, 30_000);
});

describe("lo shutdown non lascia niente indietro", () => {
  /**
   * Uscire dopo un solo SIGHUP è come un figlio che ignora HUP sopravviveva al
   * daemon che lo possedeva, tenendo un PTY che nessuno poteva più raggiungere.
   * E i due file su disco (socket e pidfile) devono sparire: un socket rimasto
   * a puntare nel vuoto è ciò che il prossimo ponte trova al posto suo.
   */
  test("SIGTERM: il figlio muore e socket e pidfile spariscono", async () => {
    const { b, c } = await bridgeWithClient("shutdown");
    create(c, "s3", 'trap "" HUP; echo PRONTO; sleep 300');
    const created = await c.waitFor((f) => f.type === "created" && f.id === "s3");
    const pid = created?.pid as number;
    expect(await c.waitFor((f) => f.type === "data" && f.id === "s3" && String(f.data).includes("PRONTO"))).not.toBeNull();
    expect(fs.existsSync(b.pidPath)).toBe(true);

    b.proc.kill("SIGTERM");
    await b.proc.exited;
    expect(pidAlive(pid)).toBe(false);
    expect(fs.existsSync(b.socketPath)).toBe(false);
    expect(fs.existsSync(b.pidPath)).toBe(false);
  }, 40_000);

  /**
   * IL SOSPETTO, misurato invece che creduto: «lo shutdown differisce l'uscita
   * di `KILL_GRACE_MS` e i due file su disco spariscono solo alla fine, quindi
   * un SIGKILL in quella finestra (un `kickstart -k` che atterra a metà
   * spegnimento) li lascia lì». Per il SOCKET è falso — `net.Server.close()`
   * toglie da solo il path — e questo test è ciò che lo tiene vero: se un
   * domani lo shutdown smettesse di chiudere il server prima di aspettare, il
   * socket resterebbe a puntare nel vuoto e il prossimo ponte lo troverebbe al
   * posto suo. Il PIDFILE resta, ed è inevitabile: nessun handler gira dopo un
   * SIGKILL. Se ne occupa `checkExistingBridge`, che sonda l'owner invece di
   * fidarsi del numero.
   */
  test("SIGKILL dentro la grazia non lascia un socket che punta nel vuoto", async () => {
    const { b, c } = await bridgeWithClient("kickstart", { TOPICS_PTY_BRIDGE_KILL_GRACE_MS: "5000" });
    create(c, "s4", 'trap "" HUP; echo PRONTO; sleep 300');
    const created = await c.waitFor((f) => f.type === "created" && f.id === "s4");
    const pid = created?.pid as number;
    expect(await c.waitFor((f) => f.type === "data" && f.id === "s4" && String(f.data).includes("PRONTO"))).not.toBeNull();

    b.proc.kill("SIGTERM");
    await Bun.sleep(500); // dentro la grazia: il timer non è ancora scattato
    b.proc.kill("SIGKILL");
    await b.proc.exited;

    expect(fs.existsSync(b.socketPath)).toBe(false);
    // Il figlio, lui, sopravvive a questa finestra: è il prezzo del SIGKILL sul
    // daemon, non un difetto del ponte. Si ripulisce qui.
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* già uscito */ } }
  }, 40_000);
});
