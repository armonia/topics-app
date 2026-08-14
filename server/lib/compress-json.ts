/**
 * JSON responses leave this server UNCOMPRESSED. On loopback nobody notices;
 * from a phone they are seconds of empty screen.
 *
 * Measured on 2026-08-14 on this machine, with `curl --compressed`: no response
 * carries `Content-Encoding`, that is, the server ignores `Accept-Encoding` and
 * ships the bytes as they were. And the JSON of this app compresses well,
 * because it is made of keys that repeat on every row:
 *
 *   GET /api/history/:key?limit=0   5.17 MB → 1.39 MB   (3.8×)   60 ms
 *   GET /api/all-boards/tasks       1.37 MB →  339 KB   (4.1×)   13 ms
 *
 * On a LAN of ~20 effective Mbit those 3.8 MB less are about a second and a
 * half in which the chat is not there.
 *
 * ## Why only for peers that are NOT local
 *
 * Compressing costs 60 ms of CPU on the biggest payload. Towards a loopback
 * peer (the Tauri shell on the same machine, the CLI, the test harness) those
 * 60 ms are a delay that buys ZERO: the transfer over loopback is already free.
 * Towards a phone on the LAN they buy a second and a half.
 *
 * The question is therefore "is there a network in between", and it is answered
 * with the address of the peer: loopback = raw, everything else = compressed.
 * It is NOT the same question as `isLocalTransport` (server/lib/tunnel.ts),
 * which asks "who do I trust" and for which the tunnel is remote even with the
 * peer at 127.0.0.1. On the tunnel there is no network: at the other end of the
 * socket sits `relay-client.ts`, on this very machine, which replays the
 * request with `fetch` and inflates it right away (measured: Bun inflates by
 * itself), and indeed `intestazioniRisposta` strips `content-encoding` because
 * the body that leaves again towards the guest is text once more. Compressing
 * there means paying twice to deliver the same bytes.
 *
 * ## What is NOT touched
 *
 * · `text/event-stream`: it is the streaming of the chat. Compressing it would
 *   mean buffering it, that is, turning a stream into a block: the reason why
 *   it exists. Here we only look at `application/json`, and streaming is not.
 * · The responses already encoded (`Content-Encoding` present).
 * · `HEAD`: the body is emptied by `Bun.serve` itself, and a compressed length
 *   on an empty body would be a lie.
 * · Everything that sits under the threshold: one MTU. Below one packet you do
 *   not save a round trip, you only spend CPU.
 */

/** One packet. Below it, compressing does not remove even one network round trip. */
export const MIN_COMPRESS_BYTES = 1400;

/**
 * Bytes over a NON shared buffer: `Bun.gzipSync` and the body of a `Response`
 * both reject a `SharedArrayBuffer`, and `Uint8Array` on its own would admit
 * both.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** The statuses that by spec cannot have a body. */
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Should this response be compressed?
 *
 * A pure function, kept apart from the application, because it is HERE that the
 * decisions to be tested one by one live, and testing them would otherwise
 * require a real server.
 */
export function shouldCompress(args: {
  method: string;
  status?: number;
  acceptEncoding: string | null;
  contentType: string | null;
  contentEncoding: string | null;
  /** `false` for loopback: see the note at the top of the file. */
  remote: boolean;
  /** Bytes of the body, when already known. `null` = still to be read. */
  bytes: number | null;
  threshold?: number;
}): boolean {
  const threshold = args.threshold ?? MIN_COMPRESS_BYTES;
  if (!args.remote) return false;
  if (args.method === "HEAD") return false;
  // The statuses that by spec have NO body. On Bun rebuilding them does not
  // throw (verified: `new Response(new Uint8Array(0), {status: 304})` passes),
  // so today the branch would be harmless, but a 304 rewritten with
  // `Content-Length: 20` and `Content-Encoding: gzip` would tell of a body that
  // is not there, and this function runs on EVERY response of the server. We
  // bail out earlier and that is the end of it.
  if (args.status !== undefined && BODYLESS_STATUSES.has(args.status)) return false;
  if (args.contentEncoding) return false;
  if (!(args.contentType ?? "").toLowerCase().startsWith("application/json")) return false;
  // `gzip` as a token, not as a substring: `Accept-Encoding: gzipx` is not gzip,
  // and `x-gzip` is another name for the same scheme that we do not promise here.
  if (!/(^|[\s,])gzip\s*(;|,|$)/i.test(args.acceptEncoding ?? "")) return false;
  if (args.bytes !== null && args.bytes < threshold) return false;
  return true;
}

/**
 * The same response, compressed when it is worth it.
 *
 * The body is read exactly once: a `Response` that has been read is consumed,
 * so even the "too small, leave it alone" branch has to rebuild it from the
 * bytes already read. Reading it whole is fine only because we get here solely
 * for `application/json`, which is already a whole string in memory.
 */
export async function compressJson(
  req: Request,
  res: Response,
  remote: boolean,
  opts?: { threshold?: number; gzip?: (b: Bytes) => Bytes },
): Promise<Response> {
  const firstPass = shouldCompress({
    method: req.method,
    status: res.status,
    acceptEncoding: req.headers.get("accept-encoding"),
    contentType: res.headers.get("content-type"),
    contentEncoding: res.headers.get("content-encoding"),
    remote,
    bytes: null,
    threshold: opts?.threshold,
  });
  if (!firstPass) return res;

  const raw = new Uint8Array(await res.arrayBuffer()) as Bytes;
  if (raw.byteLength < (opts?.threshold ?? MIN_COMPRESS_BYTES)) {
    return new Response(raw, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const gzip = opts?.gzip ?? ((b: Bytes) => Bun.gzipSync(b) as Bytes);
  const compressed = gzip(raw);
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  // Without `Vary`, an intermediate cache would serve the compressed response
  // to a client that cannot inflate it.
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Accept-Encoding");
  else if (!/\baccept-encoding\b/i.test(vary)) headers.set("Vary", `${vary}, Accept-Encoding`);
  return new Response(compressed, { status: res.status, statusText: res.statusText, headers });
}
