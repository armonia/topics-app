/**
 * The wire to the desktop Discord app: local IPC socket, zero dependencies.
 *
 * ── WHY NOT A LIBRARY ───────────────────────────────────────────────────────
 * The protocol is one page long: a unix socket, an eight-byte header, JSON
 * inside. The Rich Presence libraries you can find drag along an OAuth client,
 * voice, lobby invites - that is, a dependency tree to use thirty lines of it.
 * Here there is what is needed and nothing else.
 *
 * ── THE PROTOCOL ────────────────────────────────────────────────────────────
 *   socket   $TMPDIR/discord-ipc-N   (N = 0..9, unix domain; on Windows it is a
 *                                     named pipe, see `ipcCandidates`)
 *   frame    [op: uint32 LE][len: uint32 LE][payload JSON utf-8]
 *   op 0 HANDSHAKE  {v:1, client_id}       → Discord answers op 1 evt:"READY"
 *   op 1 FRAME      {cmd:"SET_ACTIVITY", args:{pid, activity}, nonce}
 *   op 2 CLOSE      op 3 PING   op 4 PONG
 *
 * ── TWO LAYERS, AND THE REASON IS THE TEST ──────────────────────────────────
 * Below live the PROTOCOL (composing and decomposing frames: pure functions, no
 * socket) and the TRANSPORT (opening the wire, retrying). The first is tested
 * without Discord and is where the real traps live - a `len` in BYTES that
 * someone reads as characters, a frame that arrives split into three pieces,
 * two frames in the same chunk. The second is tested with a fake Discord in
 * tmpdir (`discord-ipc.test.ts` opens one) because nothing in this file knows
 * the real app: the connector arrives injected.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ── Protocol ───────────────────────────────────────────────────────────────

export const IPC_OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const;

/** The ops this module KNOWS how to write. It is deliberately not exported:
 *  outside of here nobody composes frames by hand, and an export with no
 *  consumers is dead code for `check:deadcode`. It serves `encodeFrame`
 *  instead, which this way accepts only protocol ops rather than any `number`. */
type IpcOp = (typeof IPC_OP)[keyof typeof IPC_OP];

export interface IpcFrame {
  op: number;
  /** The body, already decoded. `null` if it was not valid JSON - an
   *  unreadable frame is not a reason to tear the wire down. */
  payload: Record<string, unknown> | null;
  /** The raw body, for the error messages: saying "Discord answered
   *  something" without showing it helps nobody. */
  raw: string;
}

/**
 * A frame ready to be written on the wire.
 *
 * `Buffer.byteLength` and not `String.length`: the `len` field counts BYTES.
 * With an accented project name - that is, half the projects in this house -
 * the two measures diverge, Discord reads a short length, and from there on
 * every following frame is a few bytes out of alignment. The wire does not die:
 * it becomes silent garbage.
 */
export function encodeFrame(op: IpcOp, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * The decomposer: you hand it the chunks as they arrive, it returns the
 * COMPLETE frames it managed to extract.
 *
 * A socket does not deliver messages, it delivers bytes: one frame can arrive
 * in three pieces and three frames can arrive in a single piece. Whoever reads
 * `chunk` as if it were a message works as long as the payloads are short -
 * that is, until one more field gets added.
 */
export function createFrameDecoder(): (chunk: Uint8Array) => IpcFrame[] {
  let buf = Buffer.alloc(0);
  return (chunk: Uint8Array): IpcFrame[] => {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    const out: IpcFrame[] = [];
    for (;;) {
      if (buf.length < 8) break;
      const op = buf.readUInt32LE(0);
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break;
      const raw = buf.subarray(8, 8 + len).toString("utf8");
      buf = buf.subarray(8 + len);
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw);
        payload = parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        payload = null;
      }
      out.push({ op, payload, raw });
    }
    return out;
  };
}

// ── Where the socket lives ─────────────────────────────────────────────────

/**
 * The macOS per-user temp (`/var/folders/xx/yyy/T`), the one Discord actually
 * uses, read without going through the environment.
 *
 * `getconf` is in `/usr/bin` on every macOS and does not touch the network; if
 * it is missing or answers crooked we return `null` and the environment
 * candidates remain, that is, the previous behaviour. An error here must not be
 * able to switch the search off.
 */
function darwinUserTempDir(): string | null {
  try {
    const out = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? out.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * The places the wire can be, in order of likelihood.
 *
 * Discord numbers its instances: the first takes `discord-ipc-0`, a second one
 * (a canary open next to the stable) takes `-1`. Trying only one means not
 * finding Discord while it is open, which from the interface reads as "Discord
 * is not there" - the wrong diagnosis.
 *
 * On Linux, with Flatpak or Snap, the root is not `$XDG_RUNTIME_DIR` but a
 * subfolder; on Windows it is not a file but a named pipe, and there
 * `existsSync` does not answer - which is why the "exists" filter sits in the
 * caller and not here.
 *
 * On macOS `$TMPDIR` is NOT reliable: it is per-process, and whoever launches
 * us inside it (an agent with its own scratch dir, a launchd with an explicit
 * `TMPDIR`) inherits a different one from Discord's, which always uses the
 * per-user temp from `confstr(_CS_DARWIN_USER_TEMP_DIR)`. Trusting only the
 * environment makes us say "Discord is not running" while Discord is open:
 * actually seen, with `TMPDIR=~/.jcode/scratch`. So on darwin the per-user temp
 * is looked up ALWAYS, even when the environment points at another one.
 */
export function ipcCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const base = (
    env.XDG_RUNTIME_DIR ||
    env.TMPDIR ||
    env.TMP ||
    env.TEMP ||
    os.tmpdir()
  ).replace(/\/+$/, "");
  const bases = [base];
  if (process.platform === "darwin") {
    // `os.tmpdir()` reads $TMPDIR first, so on its own it is not enough to
    // find the system temp again when the environment overrides it.
    const darwinTemp = darwinUserTempDir();
    if (darwinTemp && !bases.includes(darwinTemp)) bases.push(darwinTemp);
  }
  const roots: string[] = [];
  for (const b of bases) {
    roots.push(b, ...["snap.discord", "app/com.discordapp.Discord", ".flatpak/dev.vencord.Vesktop/xdg-run"].map((s) => path.join(b, s)));
  }
  const out: string[] = [];
  for (const root of roots) {
    for (let i = 0; i < 10; i++) out.push(path.join(root, `discord-ipc-${i}`));
  }
  return out;
}

/** The candidates that EXIST right now. On Windows we do not filter: a named
 *  pipe is not a file, and `existsSync` would declare it absent every time. */
export function existingIpcCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const all = ipcCandidates(env);
  if (process.platform === "win32") return all;
  return all.filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

// ── Transport ──────────────────────────────────────────────────────────────

/** The minimum socket shape this module needs: both `net` and the fake Discord
 *  of the tests satisfy it. */
export interface IpcSocket {
  write(data: Uint8Array): unknown;
  destroy(): unknown;
  on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: string, cb: (...args: never[]) => void): unknown;
}

export type IpcConnector = (socketPath: string) => IpcSocket;

/** The real connector. Injectable because the tests do not open the Discord app. */
export const netConnector: IpcConnector = (socketPath: string) =>
  net.createConnection(socketPath) as unknown as IpcSocket;

export interface HandshakeResult {
  socket: IpcSocket;
  /** The path that answered: needed so the diagnostics can say it. */
  socketPath: string;
  /** Who you are to Discord. We do not show it out of vanity: it is the only
   *  confirmation that the presence is landing on the RIGHT profile when a
   *  machine has two accounts on it. */
  user: { id?: string; username?: string; global_name?: string } | null;
}

export interface HandshakeOptions {
  clientId: string;
  connect?: IpcConnector;
  candidates?: string[];
  /** How long we wait for the READY before declaring that candidate dead. */
  timeoutMs?: number;
  /** Where the frames that arrive AFTER the handshake end up (Discord errors,
   *  CLOSE). The caller decides whether to reconnect. */
  onFrame?: (frame: IpcFrame) => void;
  onClose?: (reason: string) => void;
}

/**
 * Opens the wire and completes the handshake, trying the candidates in order.
 *
 * Rejects with a message that DISTINGUISHES the two failures the interface has
 * to be able to tell apart: "Discord is not open" (no socket) and "Discord is
 * there but refuses this application" (socket yes, READY no) - the second is
 * usually a wrong Application ID, and sending someone off to restart Discord
 * over a wrong id is sending them round in circles.
 */
export function handshake(opts: HandshakeOptions): Promise<HandshakeResult> {
  const connect = opts.connect ?? netConnector;
  const candidates = opts.candidates ?? existingIpcCandidates();
  const timeoutMs = opts.timeoutMs ?? 4000;

  if (candidates.length === 0) {
    return Promise.reject(new DiscordIpcError("no_socket", "nessun socket discord-ipc-N: Discord desktop non è in esecuzione"));
  }

  const attempt = (index: number): Promise<HandshakeResult> => {
    if (index >= candidates.length) {
      return Promise.reject(
        new DiscordIpcError("handshake_refused", "Discord ha chiuso il filo senza dire READY (Application ID sbagliato?)"),
      );
    }
    const socketPath = candidates[index]!;
    return tryOne(socketPath, opts.clientId, connect, timeoutMs, opts).catch((err) => {
      // A candidate that does not answer is not an error to show: it is the
      // reason a list exists at all. Only the LAST one propagates.
      if (index + 1 < candidates.length) return attempt(index + 1);
      throw err;
    });
  };

  return attempt(0);
}

export class DiscordIpcError extends Error {
  constructor(
    readonly code: "no_socket" | "handshake_refused" | "timeout" | "socket_error",
    message: string,
  ) {
    super(message);
    this.name = "DiscordIpcError";
  }
}

function tryOne(
  socketPath: string,
  clientId: string,
  connect: IpcConnector,
  timeoutMs: number,
  opts: HandshakeOptions,
): Promise<HandshakeResult> {
  return new Promise<HandshakeResult>((resolve, reject) => {
    let settled = false;
    let socket: IpcSocket;
    try {
      socket = connect(socketPath);
    } catch (err) {
      reject(new DiscordIpcError("socket_error", `${socketPath}: ${(err as Error)?.message ?? err}`));
      return;
    }

    const decode = createFrameDecoder();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already dead */ }
      reject(new DiscordIpcError("timeout", `${socketPath}: nessun READY entro ${timeoutMs}ms`));
    }, timeoutMs);
    // The timer must not keep the process awake: if the server is shutting
    // down, an in-flight handshake is not a reason to stay alive.
    (timer as unknown as { unref?: () => void }).unref?.();

    const fail = (err: DiscordIpcError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already dead */ }
      reject(err);
    };

    socket.on("data", (chunk: Uint8Array) => {
      for (const frame of decode(chunk)) {
        if (settled) {
          // After the handshake the frames belong to whoever asked for the wire.
          opts.onFrame?.(frame);
          if (frame.op === IPC_OP.CLOSE) opts.onClose?.(frame.raw);
          continue;
        }
        const evt = frame.payload?.evt;
        if (frame.op === IPC_OP.FRAME && evt === "READY") {
          settled = true;
          clearTimeout(timer);
          const data = frame.payload?.data as { user?: HandshakeResult["user"] } | undefined;
          resolve({ socket, socketPath, user: data?.user ?? null });
        } else if (frame.op === IPC_OP.CLOSE || evt === "ERROR") {
          fail(new DiscordIpcError("handshake_refused", `Discord ha rifiutato il collegamento: ${frame.raw.slice(0, 200)}`));
        }
      }
    });

    socket.on("error", (err: Error) => {
      fail(new DiscordIpcError("socket_error", `${socketPath}: ${err?.message ?? err}`));
    });

    socket.on("close", () => {
      if (settled) {
        opts.onClose?.("close");
        return;
      }
      fail(new DiscordIpcError("socket_error", `${socketPath}: chiuso prima del READY`));
    });

    try {
      socket.write(encodeFrame(IPC_OP.HANDSHAKE, { v: 1, client_id: clientId }));
    } catch (err) {
      fail(new DiscordIpcError("socket_error", `${socketPath}: ${(err as Error)?.message ?? err}`));
    }
  });
}

let nonceSeq = 0;

/**
 * The application name, as Discord knows it.
 *
 * It does not arrive with the READY - verified by reading the frame: there are
 * only `v`, `config` and `user` in there. It arrives instead in the answer to a
 * SET_ACTIVITY, where Discord sends the activity back as it saved it, with
 * `name` inside.
 *
 * It matters because that name is decided by the developer portal and nobody
 * can guess it from the code: the preview in the panel wrote "Topics" by hand
 * while the real card said "Jarvis".
 */
export function onActivityAck(
  socket: IpcSocket,
  cb: (ack: { applicationName: string | null; error: string | null }) => void,
): void {
  const decode = createFrameDecoder();
  socket.on("data", (chunk: Uint8Array) => {
    for (const frame of decode(chunk)) {
      const p = frame.payload as { cmd?: string; evt?: string; data?: Record<string, unknown> } | undefined;
      if (p?.cmd !== "SET_ACTIVITY") continue;
      if (p.evt === "ERROR") {
        const message = p.data?.message;
        cb({
          applicationName: null,
          error: typeof message === "string" ? message : "SET_ACTIVITY rifiutato",
        });
        continue;
      }
      const name = p.data?.name;
      cb({ applicationName: typeof name === "string" ? name : null, error: null });
    }
  });
}

/**
 * Writes a SET_ACTIVITY. `activity: null` CLEARS the presence - which is what
 * has to happen when the last session closes: a stale state is worse than no
 * state, because it says something false for an indefinite time.
 */
export function sendActivity(socket: IpcSocket, pid: number, activity: unknown): void {
  socket.write(
    encodeFrame(IPC_OP.FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid, activity },
      nonce: `topics-${Date.now()}-${nonceSeq++}`,
    }),
  );
}
