/**
 * Il filo con l'app Discord del desktop: socket IPC locale, zero dipendenze.
 *
 * ── PERCHÉ NON UNA LIBRERIA ─────────────────────────────────────────────────
 * Il protocollo è di una pagina: un socket unix, un'intestazione di otto byte,
 * JSON dentro. Le librerie di Rich Presence che si trovano portano dietro un
 * client OAuth, il voice, gli inviti alle lobby — cioè un albero di dipendenze
 * per usarne trenta righe. Qui c'è quello che serve e nient'altro.
 *
 * ── IL PROTOCOLLO ───────────────────────────────────────────────────────────
 *   socket   $TMPDIR/discord-ipc-N   (N = 0..9, unix domain; su Windows è una
 *                                     named pipe, vedi `ipcCandidates`)
 *   frame    [op: uint32 LE][len: uint32 LE][payload JSON utf-8]
 *   op 0 HANDSHAKE  {v:1, client_id}       → Discord risponde op 1 evt:"READY"
 *   op 1 FRAME      {cmd:"SET_ACTIVITY", args:{pid, activity}, nonce}
 *   op 2 CLOSE      op 3 PING   op 4 PONG
 *
 * ── DUE STRATI, E LA RAGIONE È IL TEST ──────────────────────────────────────
 * Qui sotto stanno il PROTOCOLLO (comporre e scomporre frame: funzioni pure,
 * nessun socket) e il TRASPORTO (aprire il filo, riprovare). Il primo si prova
 * senza Discord ed è dove vivono le trappole vere — un `len` in BYTE che
 * qualcuno legge come caratteri, un frame che arriva spezzato in tre pezzi, due
 * frame nello stesso chunk. Il secondo si prova con un finto Discord in tmpdir
 * (`discord-ipc.test.ts` ne apre uno) perché niente in questo file conosce
 * l'app vera: il connettore arriva iniettato.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

// ── Protocollo ─────────────────────────────────────────────────────────────

export const IPC_OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const;

/** Gli op che questo modulo SA scrivere. Non è esportato di proposito: fuori
 *  di qui nessuno compone frame a mano, e un export senza consumatori è codice
 *  morto per `check:deadcode`. Serve invece a `encodeFrame`, che così accetta
 *  solo op del protocollo invece di un `number` qualunque. */
type IpcOp = (typeof IPC_OP)[keyof typeof IPC_OP];

export interface IpcFrame {
  op: number;
  /** Il corpo già decodificato. `null` se non era JSON valido — un frame
   *  illeggibile non è una ragione per buttare giù il filo. */
  payload: Record<string, unknown> | null;
  /** Il corpo grezzo, per i messaggi d'errore: dire «Discord ha risposto
   *  qualcosa» senza mostrarlo non aiuta nessuno. */
  raw: string;
}

/**
 * Un frame pronto da scrivere sul filo.
 *
 * `Buffer.byteLength` e non `String.length`: il campo `len` conta BYTE. Con un
 * nome di progetto accentato — cioè metà dei progetti di questa casa — le due
 * misure divergono, Discord legge una lunghezza corta, e da lì in poi ogni
 * frame successivo è disallineato di qualche byte. Il filo non muore: diventa
 * spazzatura silenziosa.
 */
export function encodeFrame(op: IpcOp, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * Lo scompositore: gli si danno i chunk come arrivano, restituisce i frame
 * COMPLETI che ha potuto ricavare.
 *
 * Un socket non consegna messaggi, consegna byte: un frame può arrivare in tre
 * pezzi e tre frame possono arrivare in un pezzo solo. Chi legge `chunk` come
 * se fosse un messaggio funziona finché i payload sono corti — cioè finché non
 * si aggiunge un campo.
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

// ── Dove sta il socket ─────────────────────────────────────────────────────

/**
 * I posti in cui può stare il filo, in ordine di probabilità.
 *
 * Discord numera le istanze: la prima prende `discord-ipc-0`, una seconda (un
 * canary aperto accanto allo stable) prende la `-1`. Provarne una sola
 * significa non trovare Discord quando è aperto, che dall'interfaccia si legge
 * «Discord non c'è» — la diagnosi sbagliata.
 *
 * Su Linux, con Flatpak o Snap, la radice non è `$XDG_RUNTIME_DIR` ma una
 * sottocartella; su Windows non è un file ma una named pipe, e lì `existsSync`
 * non risponde — per questo il filtro «esiste» sta nel chiamante e non qui.
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
  const roots = [base, ...["snap.discord", "app/com.discordapp.Discord", ".flatpak/dev.vencord.Vesktop/xdg-run"].map((s) => path.join(base, s))];
  const out: string[] = [];
  for (const root of roots) {
    for (let i = 0; i < 10; i++) out.push(path.join(root, `discord-ipc-${i}`));
  }
  return out;
}

/** I candidati che ESISTONO adesso. Su Windows non si filtra: una named pipe
 *  non è un file, e `existsSync` la dichiarerebbe assente sempre. */
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

// ── Trasporto ──────────────────────────────────────────────────────────────

/** La forma minima di socket che serve a questo modulo: la usano sia `net` sia
 *  il finto Discord dei test. */
export interface IpcSocket {
  write(data: Uint8Array): unknown;
  destroy(): unknown;
  on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: string, cb: (...args: never[]) => void): unknown;
}

export type IpcConnector = (socketPath: string) => IpcSocket;

/** Il connettore vero. Iniettabile perché i test non aprono l'app Discord. */
export const netConnector: IpcConnector = (socketPath: string) =>
  net.createConnection(socketPath) as unknown as IpcSocket;

export interface HandshakeResult {
  socket: IpcSocket;
  /** Il path che ha risposto: serve a dirlo nella diagnostica. */
  socketPath: string;
  /** Chi sei per Discord. Non lo mostriamo per vanità: è l'unica conferma che
   *  la presence sta finendo sul profilo GIUSTO quando su una macchina ci sono
   *  due account. */
  user: { id?: string; username?: string; global_name?: string } | null;
}

export interface HandshakeOptions {
  clientId: string;
  connect?: IpcConnector;
  candidates?: string[];
  /** Quanto si aspetta il READY prima di dichiarare morto quel candidato. */
  timeoutMs?: number;
  /** Dove finiscono i frame che arrivano DOPO l'handshake (errori di Discord,
   *  CLOSE). Chi chiama decide se ricollegarsi. */
  onFrame?: (frame: IpcFrame) => void;
  onClose?: (reason: string) => void;
}

/**
 * Apre il filo e completa l'handshake, provando i candidati in ordine.
 *
 * Rifiuta con un messaggio che DISTINGUE i due fallimenti che l'interfaccia
 * deve saper raccontare in modo diverso: «Discord non è aperto» (nessun socket)
 * e «Discord c'è ma rifiuta questa applicazione» (socket sì, READY no) — il
 * secondo di solito è un Application ID sbagliato, e mandare qualcuno a
 * riavviare Discord per un id sbagliato è farlo girare a vuoto.
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
      // Un candidato che non risponde non è un errore da mostrare: è il motivo
      // per cui esiste una lista. Si propaga solo l'ULTIMO.
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
      try { socket.destroy(); } catch { /* già morto */ }
      reject(new DiscordIpcError("timeout", `${socketPath}: nessun READY entro ${timeoutMs}ms`));
    }, timeoutMs);
    // Il timer non deve tenere sveglio il processo: se il server sta chiudendo,
    // un handshake in volo non è una ragione per restare vivi.
    (timer as unknown as { unref?: () => void }).unref?.();

    const fail = (err: DiscordIpcError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* già morto */ }
      reject(err);
    };

    socket.on("data", (chunk: Uint8Array) => {
      for (const frame of decode(chunk)) {
        if (settled) {
          // Dopo l'handshake i frame appartengono a chi ha chiesto il filo.
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
 * Il nome dell'applicazione, come lo conosce Discord.
 *
 * Non arriva col READY — verificato leggendo il frame: li' ci sono solo `v`,
 * `config` e `user`. Arriva invece nella risposta a un SET_ACTIVITY, dove
 * Discord rimanda l'activity come l'ha salvata, con dentro `name`.
 *
 * Serve perche' quel nome lo decide il portale sviluppatori e nessuno puo'
 * indovinarlo dal codice: l'anteprima nel pannello scriveva «Topics» a mano
 * mentre la card vera diceva «Jarvis».
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
        cb({ applicationName: null, error: String((p.data as any)?.message ?? "SET_ACTIVITY rifiutato") });
        continue;
      }
      const nome = (p.data as any)?.name;
      cb({ applicationName: typeof nome === "string" ? nome : null, error: null });
    }
  });
}

/**
 * Scrive un SET_ACTIVITY. `activity: null` PULISCE la presence — che è ciò che
 * deve succedere quando l'ultima sessione si chiude: uno stato appeso è peggio
 * di nessuno stato, perché dice una cosa falsa a tempo indeterminato.
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
