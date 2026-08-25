/**
 * The wire to Discord, tested without Discord.
 *
 * The two halves are tested in two different ways, on purpose:
 *   • the PROTOCOL with hand-written bytes - that is where the traps live
 *     (length in bytes, split frame, two frames in one chunk), and they are
 *     exactly the cases "it works on my Mac" never touches;
 *   • the TRANSPORT against a fake Discord: a real unix socket in tmpdir that
 *     speaks the real protocol. Not a mock of our own client - a
 *     counterpart, one that can also answer badly.
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
    // An accented word and an emoji (the fixture below): `String.length` would
    // say less than the truth, and from there on every following frame would be
    // out of alignment.
    const payload = { details: "Attività su Pixê 🌙" };
    const frame = encodeFrame(IPC_OP.FRAME, payload);
    const json = JSON.stringify(payload);
    expect(frame.readUInt32LE(4)).toBe(Buffer.byteLength(json, "utf8"));
    expect(frame.readUInt32LE(4)).toBeGreaterThan(json.length);
    // And the full round trip does not lose a character.
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

  // The real case: a process launched with its own scratch dir as TMPDIR looked
  // for the socket ONLY there and concluded "Discord is not running" while
  // Discord was open. The macOS per-user temp has to be looked up anyway.
  test.skipIf(process.platform !== "darwin")(
    "su macOS un TMPDIR sovrascritto non nasconde la temp di sistema",
    () => {
      const c = ipcCandidates({ TMPDIR: "/tmp/x" } as NodeJS.ProcessEnv);
      expect(c).toContain("/tmp/x/discord-ipc-0");
      // We do not compare against a constant: the path is per-user, and writing
      // it out by hand would tie the test to this machine.
      const systemTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
      }).trim().replace(/\/+$/, "");
      expect(c).toContain(`${systemTemp}/discord-ipc-0`);
    },
  );
});

// ── Transport: a fake Discord ──────────────────────────────────────────────

interface FakeDiscord {
  path: string;
  /** Everything the client wrote, already decomposed. */
  received: Array<{ op: number; payload: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

/**
 * A unix socket that speaks the real protocol.
 *
 * `mode` decides how it behaves at the handshake: `ready` answers READY,
 * `refuse` answers ERROR (the wrong Application ID), `silent` does not answer
 * at all (the case that has to end in a timeout and not in an endless wait).
 */
function startFakeDiscord(dir: string, mode: "ready" | "refuse" | "silent" = "ready"): Promise<FakeDiscord> {
  const path = join(dir, "discord-ipc-0");
  const received: FakeDiscord["received"] = [];
  const server = net.createServer((sock) => {
    const decode = createFrameDecoder();
    sock.on("data", (chunk: Buffer | string) => {
      // `net` types `data` as `string | Buffer` (it depends on `setEncoding`,
      // which nobody calls here): the wire is binary, and that has to be said.
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
    sock.on("error", () => { /* a client that closes abruptly is not a fault */ });
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

    const activity = fake.received.find((f) => f.payload?.cmd === "SET_ACTIVITY");
    expect(activity).toBeDefined();
    expect(activity!.payload).toMatchObject({
      cmd: "SET_ACTIVITY",
      args: { pid: 4242, activity: { details: "3 al lavoro · 12 aperte" } },
    });
    // The nonce is there: without it, Discord ignores the command in silence.
    expect(typeof activity!.payload!.nonce).toBe("string");
    res.socket.destroy();
  });

  test("pulire la presence è un SET_ACTIVITY con activity null, non un silenzio", async () => {
    const dir = tempDir();
    const fake = await startFakeDiscord(dir);
    fakes.push(fake);

    const res = await handshake({ clientId: "123", candidates: [fake.path], timeoutMs: 2000 });
    sendActivity(res.socket, 1, null);
    await Bun.sleep(60);

    const activity = fake.received.find((f) => f.payload?.cmd === "SET_ACTIVITY");
    expect((activity!.payload!.args as { activity: unknown }).activity).toBeNull();
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
    // The message carries Discord's own reason, not an "it does not work".
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
