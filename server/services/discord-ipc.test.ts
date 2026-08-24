/**
 * Il filo con Discord, provato senza Discord.
 *
 * Le due metà si provano in due modi diversi, di proposito:
 *   • il PROTOCOLLO con dei byte scritti a mano — è lì che vivono le trappole
 *     (lunghezza in byte, frame spezzato, due frame in un chunk), e sono
 *     esattamente i casi che «funziona sul mio Mac» non tocca mai;
 *   • il TRASPORTO contro un finto Discord: un vero socket unix in tmpdir che
 *     parla il vero protocollo. Non un mock del nostro client — un
 *     interlocutore, che può anche rispondere male.
 */

import { describe, expect, test, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  encodeFrame,
  createFrameDecoder,
  handshake,
  sendActivity,
  ipcCandidates,
  IPC_OP,
  DiscordIpcError,
  type IpcSocket,
} from "./discord-ipc";

// ── Protocollo ─────────────────────────────────────────────────────────────

describe("encodeFrame", () => {
  test("scrive op e lunghezza in little-endian, poi il JSON", () => {
    const frame = encodeFrame(IPC_OP.HANDSHAKE, { v: 1, client_id: "42" });
    expect(frame.readUInt32LE(0)).toBe(0);
    const body = frame.subarray(8).toString("utf8");
    expect(frame.readUInt32LE(4)).toBe(Buffer.byteLength(body, "utf8"));
    expect(JSON.parse(body)).toEqual({ v: 1, client_id: "42" });
  });

  test("la lunghezza è in BYTE, non in caratteri", () => {
    // «Attività» e un'emoji: `String.length` direbbe meno del vero, e da lì in
    // poi ogni frame successivo sarebbe disallineato.
    const payload = { details: "Attività su Pixê 🌙" };
    const frame = encodeFrame(IPC_OP.FRAME, payload);
    const json = JSON.stringify(payload);
    expect(frame.readUInt32LE(4)).toBe(Buffer.byteLength(json, "utf8"));
    expect(frame.readUInt32LE(4)).toBeGreaterThan(json.length);
    // E il giro completo non perde un carattere.
    const decode = createFrameDecoder();
    expect(decode(frame)[0]?.payload).toEqual(payload);
  });
});

describe("createFrameDecoder", () => {
  test("ricompone un frame arrivato in tre pezzi", () => {
    const decode = createFrameDecoder();
    const frame = encodeFrame(IPC_OP.FRAME, { evt: "READY", data: { user: { username: "j" } } });
    expect(decode(frame.subarray(0, 4))).toEqual([]);
    expect(decode(frame.subarray(4, 10))).toEqual([]);
    const out = decode(frame.subarray(10));
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ evt: "READY" });
  });

  test("restituisce DUE frame arrivati nello stesso chunk", () => {
    const decode = createFrameDecoder();
    const a = encodeFrame(IPC_OP.FRAME, { evt: "READY" });
    const b = encodeFrame(IPC_OP.CLOSE, { code: 1000 });
    const out = decode(Buffer.concat([a, b]));
    expect(out.map((f) => f.op)).toEqual([IPC_OP.FRAME, IPC_OP.CLOSE]);
  });

  test("un payload illeggibile non butta giù il filo: payload null, raw conservato", () => {
    const decode = createFrameDecoder();
    const body = Buffer.from("non-json", "utf8");
    const head = Buffer.alloc(8);
    head.writeUInt32LE(IPC_OP.FRAME, 0);
    head.writeUInt32LE(body.length, 4);
    const out = decode(Buffer.concat([head, body]));
    expect(out[0]!.payload).toBeNull();
    expect(out[0]!.raw).toBe("non-json");
  });
});

describe("ipcCandidates", () => {
  test("prova dieci istanze, non solo la zero", () => {
    const c = ipcCandidates({ TMPDIR: "/tmp/x" } as NodeJS.ProcessEnv);
    expect(c).toContain("/tmp/x/discord-ipc-0");
    expect(c).toContain("/tmp/x/discord-ipc-9");
  });

  test("la barra finale della radice non produce un doppio slash", () => {
    const c = ipcCandidates({ TMPDIR: "/tmp/x/" } as NodeJS.ProcessEnv);
    expect(c.some((p) => p.includes("//"))).toBe(false);
  });

  // Il caso vero: un processo lanciato con la propria scratch dir come TMPDIR
  // cercava il socket SOLO lì e concludeva «Discord non è in esecuzione» con
  // Discord aperto. La temp per-utente di macOS va cercata comunque.
  test.skipIf(process.platform !== "darwin")(
    "su macOS un TMPDIR sovrascritto non nasconde la temp di sistema",
    () => {
      const c = ipcCandidates({ TMPDIR: "/tmp/x" } as NodeJS.ProcessEnv);
      expect(c).toContain("/tmp/x/discord-ipc-0");
      // Non si confronta con una costante: il percorso è per-utente, e scriverlo
      // a mano legherebbe il test a questa macchina.
      const systemTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
      }).trim().replace(/\/+$/, "");
      expect(c).toContain(`${systemTemp}/discord-ipc-0`);
    },
  );
});

// ── Trasporto: un finto Discord ────────────────────────────────────────────

interface FakeDiscord {
  path: string;
  /** Tutto ciò che il client ha scritto, già scomposto. */
  received: Array<{ op: number; payload: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

/**
 * Un socket unix che parla il protocollo vero.
 *
 * `mode` decide come si comporta all'handshake: `ready` risponde READY,
 * `refuse` risponde ERROR (l'Application ID sbagliato), `silent` non risponde
 * affatto (il caso che deve finire in timeout e non in attesa infinita).
 */
function startFakeDiscord(dir: string, mode: "ready" | "refuse" | "silent" = "ready"): Promise<FakeDiscord> {
  const path = join(dir, "discord-ipc-0");
  const received: FakeDiscord["received"] = [];
  const server = net.createServer((sock) => {
    const decode = createFrameDecoder();
    sock.on("data", (chunk: Buffer | string) => {
      // `net` tipizza `data` come `string | Buffer` (dipende da `setEncoding`,
      // che qui nessuno chiama): il filo è binario, e va detto.
      for (const frame of decode(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)) {
        received.push({ op: frame.op, payload: frame.payload });
        if (frame.op !== IPC_OP.HANDSHAKE) continue;
        if (mode === "ready") {
          sock.write(encodeFrame(IPC_OP.FRAME, { evt: "READY", data: { v: 1, user: { id: "7", username: "pippo" } } }));
        } else if (mode === "refuse") {
          sock.write(encodeFrame(IPC_OP.FRAME, { evt: "ERROR", data: { code: 4000, message: "Invalid Client ID" } }));
        }
      }
    });
    sock.on("error", () => { /* il client che chiude di colpo non è un guasto */ });
  });
  return new Promise((resolve) => {
    server.listen(path, () => {
      resolve({
        path,
        received,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const dirs: string[] = [];
const fakes: FakeDiscord[] = [];

afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "discord-ipc-test-"));
  dirs.push(d);
  return d;
}

describe("handshake", () => {
  test("completa il giro e riporta CHI sei per Discord", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir);
    fakes.push(fake);

    const res = await handshake({ clientId: "123", candidates: [fake.path], timeoutMs: 2000 });
    expect(res.user?.username).toBe("pippo");
    expect(res.socketPath).toBe(fake.path);
    expect(fake.received[0]?.payload).toMatchObject({ v: 1, client_id: "123" });
    res.socket.destroy();
  });

  test("SET_ACTIVITY arriva a Discord con l'attività dentro", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir);
    fakes.push(fake);

    const res = await handshake({ clientId: "123", candidates: [fake.path], timeoutMs: 2000 });
    sendActivity(res.socket, 4242, { details: "3 al lavoro · 12 aperte" });
    await Bun.sleep(60);

    const attivita = fake.received.find((f) => f.payload?.cmd === "SET_ACTIVITY");
    expect(attivita).toBeDefined();
    expect(attivita!.payload).toMatchObject({
      cmd: "SET_ACTIVITY",
      args: { pid: 4242, activity: { details: "3 al lavoro · 12 aperte" } },
    });
    // Il nonce esiste: senza, Discord ignora il comando in silenzio.
    expect(typeof attivita!.payload!.nonce).toBe("string");
    res.socket.destroy();
  });

  test("pulire la presence è un SET_ACTIVITY con activity null, non un silenzio", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir);
    fakes.push(fake);

    const res = await handshake({ clientId: "123", candidates: [fake.path], timeoutMs: 2000 });
    sendActivity(res.socket, 1, null);
    await Bun.sleep(60);

    const attivita = fake.received.find((f) => f.payload?.cmd === "SET_ACTIVITY");
    expect((attivita!.payload!.args as { activity: unknown }).activity).toBeNull();
    res.socket.destroy();
  });

  test("nessun socket ⇒ `no_socket`, che l'interfaccia legge «apri Discord»", async () => {
    await expect(handshake({ clientId: "123", candidates: [] })).rejects.toMatchObject({
      code: "no_socket",
    });
  });

  test("Discord c'è ma rifiuta l'applicazione ⇒ `handshake_refused`, non `no_socket`", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir, "refuse");
    fakes.push(fake);

    const err = await handshake({ clientId: "sbagliato", candidates: [fake.path], timeoutMs: 2000 })
      .then(() => null, (e: DiscordIpcError) => e);
    expect(err).toBeInstanceOf(DiscordIpcError);
    expect(err!.code).toBe("handshake_refused");
    // Il messaggio porta la ragione di Discord, non un «non funziona».
    expect(err!.message).toContain("Invalid Client ID");
  });

  test("un Discord muto finisce in timeout invece di restare appeso", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir, "silent");
    fakes.push(fake);

    const err = await handshake({ clientId: "123", candidates: [fake.path], timeoutMs: 120 })
      .then(() => null, (e: DiscordIpcError) => e);
    expect(err!.code).toBe("timeout");
  });

  test("i candidati si provano in ORDINE: un path morto non nasconde quello vivo", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir);
    fakes.push(fake);

    const res = await handshake({
      clientId: "123",
      candidates: [join(dir, "discord-ipc-9"), fake.path],
      timeoutMs: 2000,
    });
    expect(res.socketPath).toBe(fake.path);
    res.socket.destroy();
  });

  test("un connettore che esplode non propaga l'eccezione: diventa un errore tipato", async () => {
    const connect = (): IpcSocket => { throw new Error("EACCES"); };
    const err = await handshake({ clientId: "1", candidates: ["/dev/null/nope"], connect })
      .then(() => null, (e: DiscordIpcError) => e);
    expect(err!.code).toBe("socket_error");
    expect(err!.message).toContain("EACCES");
  });
});
