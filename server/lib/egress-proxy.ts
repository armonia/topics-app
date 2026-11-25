/**
 * Local CONNECT proxy that dials every address of a host and keeps the first
 * one that answers (Happy Eyeballs, RFC 8305).
 *
 * Why it exists: an ISP can drop port 443 on ONE of a host's addresses while
 * the others work (22/11/2026: one Cloudflare address of chatgpt.com dead,
 * another fine). The Codex CLI tries addresses one after the other and its routing
 * discovery times out on the dead one first, so a ChatGPT chat sat on
 * "Reconnecting... N/5" about every other DNS answer. Pointing the CLI's
 * HTTPS_PROXY here makes the dead address invisible, without sudo or
 * /etc/hosts, for anyone on any network.
 *
 * Bound to 127.0.0.1 and gated by a per-process secret: only the children we
 * hand the URL to can tunnel through it.
 */
import net from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 8305 §5 "Connection Attempt Delay": start the next address after this. */
export const ATTEMPT_DELAY_MS = 250;
/** Give up on a host when no address connected within this. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** A client must finish its CONNECT header within this. */
const HEADER_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 8 * 1024;
const PROXY_USER = "topics";

export type Resolve = (host: string) => Promise<string[]>;
export type Dial = (ip: string, port: number) => net.Socket;

export interface DialOptions {
  resolve?: Resolve;
  dial?: Dial;
  attemptDelayMs?: number;
  timeoutMs?: number;
}

/** RFC 8305 §4: alternate the families so a dead one costs a single attempt delay. */
export function interleaveFamilies(addrs: ReadonlyArray<{ address: string; family: number }>): string[] {
  const v6 = addrs.filter((a) => a.family === 6).map((a) => a.address);
  const v4 = addrs.filter((a) => a.family !== 6).map((a) => a.address);
  const out: string[] = [];
  for (let i = 0; i < Math.max(v6.length, v4.length); i++) {
    if (i < v6.length) out.push(v6[i]!);
    if (i < v4.length) out.push(v4[i]!);
  }
  return out;
}

// The system resolver, so /etc/hosts and split DNS (Tailscale, VPNs) still apply.
const systemResolve: Resolve = async (host) => {
  if (net.isIP(host)) return [host];
  return interleaveFamilies(await lookup(host, { all: true }));
};

const systemDial: Dial = (ip, port) => net.connect({ host: ip, port });

// One log line per host whose preferred address lost the race, not one per connection.
const reportedDetours = new Set<string>();

/**
 * Race the host's addresses, staggered by `attemptDelayMs`; a refused address
 * hands over to the next at once. Resolves with the first connected socket and
 * destroys the others.
 */
export async function connectFirstReachable(host: string, port: number, opts: DialOptions = {}): Promise<net.Socket> {
  const addresses = await (opts.resolve ?? systemResolve)(host);
  const dial = opts.dial ?? systemDial;
  const attemptDelayMs = opts.attemptDelayMs ?? ATTEMPT_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  if (addresses.length === 0) throw new Error(`${host}: the resolver returned no address`);

  return new Promise<net.Socket>((resolve, reject) => {
    const pending = new Set<net.Socket>();
    const failures: string[] = [];
    let next = 0;
    let settled = false;
    let stagger: ReturnType<typeof setTimeout> | undefined;

    const finish = (winner: net.Socket | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(stagger);
      for (const s of pending) if (s !== winner) s.destroy();
      if (winner) resolve(winner);
      else reject(err);
    };

    const deadline = setTimeout(() => {
      finish(null, new Error(`${host}:${port}: no address answered within ${timeoutMs} ms (${addresses.join(", ")})`));
    }, timeoutMs);

    const attempt = () => {
      clearTimeout(stagger);
      if (settled || next >= addresses.length) return;
      const ip = addresses[next++]!;
      const socket = dial(ip, port);
      pending.add(socket);
      socket.once("connect", () => {
        if (ip !== addresses[0] && !reportedDetours.has(host)) {
          reportedDetours.add(host);
          console.warn(`[egress-proxy] ${host}:${port}: first address ${addresses[0]} failed or was slow, connected through ${ip}`);
        }
        finish(socket);
      });
      socket.once("error", (e) => {
        pending.delete(socket);
        failures.push(`${ip}: ${e.message}`);
        if (pending.size === 0 && next >= addresses.length) {
          finish(null, new Error(`${host}:${port}: every address failed (${failures.join("; ")})`));
        } else {
          attempt();
        }
      });
      if (next < addresses.length) stagger = setTimeout(attempt, attemptDelayMs);
    };

    attempt();
  });
}

const CONNECT_LINE = /^CONNECT (\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/;

/** The parsed target of a CONNECT request, or null when the request line is not one. */
export function parseConnectTarget(requestLine: string): { host: string; port: number } | null {
  const m = CONNECT_LINE.exec(requestLine);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = m[1]!.startsWith("[") ? m[1]!.slice(1, -1) : m[1]!;
  return { host, port };
}

function headerValue(lines: string[], name: string): string | null {
  const prefix = name.toLowerCase() + ":";
  const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function sameSecret(got: string | null, expected: string): boolean {
  if (got == null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function handleClient(client: net.Socket, expectedAuth: string, dialOpts: DialOptions | undefined): void {
  let buffered = Buffer.alloc(0);
  const headerTimer = setTimeout(() => client.destroy(), HEADER_TIMEOUT_MS);
  client.on("error", () => client.destroy());

  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length > MAX_HEADER_BYTES) {
        clearTimeout(headerTimer);
        client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
      }
      return;
    }
    client.off("data", onData);
    clearTimeout(headerTimer);
    const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
    const early = buffered.subarray(end + 4);

    const target = parseConnectTarget(lines[0] ?? "");
    if (!target) {
      client.end("HTTP/1.1 405 Method Not Allowed\r\nAllow: CONNECT\r\n\r\n");
      return;
    }
    if (!sameSecret(headerValue(lines, "Proxy-Authorization"), expectedAuth)) {
      client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_USER}"\r\n\r\n`);
      return;
    }

    client.pause();
    connectFirstReachable(target.host, target.port, dialOpts).then(
      (upstream) => {
        if (client.destroyed) { upstream.destroy(); return; }
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (early.length > 0) upstream.write(early);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      },
      (err: Error) => {
        console.warn(`[egress-proxy] ${err.message}`);
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      },
    );
  };
  client.on("data", onData);
}

export interface EgressProxy {
  /** `http://user:secret@127.0.0.1:port`, ready for HTTPS_PROXY. */
  url: string;
  close(): Promise<void>;
}

export function startEgressProxy(opts: { dial?: DialOptions } = {}): Promise<EgressProxy> {
  const secret = randomBytes(18).toString("base64url");
  const expectedAuth = "Basic " + Buffer.from(`${PROXY_USER}:${secret}`).toString("base64");
  const server = net.createServer((client) => handleClient(client, expectedAuth, opts.dial));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (e) => console.warn(`[egress-proxy] server error: ${e.message}`));
      server.unref();
      const { port } = server.address() as net.AddressInfo;
      // Built field by field: the secret is generated here and lives only in memory.
      const url = new URL(`http://127.0.0.1:${port}`);
      url.username = PROXY_USER;
      url.password = secret;
      resolve({
        url: url.href.replace(/\/$/, ""),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const LOOPBACK = "localhost,127.0.0.1,::1";

/**
 * The variables that send a child's HTTPS through `proxyUrl`. Empty when the
 * user already configured a proxy: they know their network better than we do.
 */
export function egressProxyEnv(proxyUrl: string, inherited: Record<string, string | undefined>): Record<string, string> {
  const userProxy = inherited.HTTPS_PROXY || inherited.https_proxy || inherited.ALL_PROXY || inherited.all_proxy;
  if (userProxy) return {};
  const noProxy = [inherited.NO_PROXY || inherited.no_proxy, LOOPBACK].filter(Boolean).join(",");
  return { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: noProxy, no_proxy: noProxy };
}

let shared: EgressProxy | null = null;
let starting: Promise<void> | null = null;

/**
 * The process-wide proxy's child env, starting the proxy on first call. Sync on
 * purpose: spawn paths must not gain an await. Until the listener is up (a few
 * ms after the first call), or if it could not start, children dial directly as
 * they always did.
 */
export function sharedEgressProxyEnv(inherited: Record<string, string | undefined> = process.env): Record<string, string> {
  if (shared) return egressProxyEnv(shared.url, inherited);
  if (!starting) {
    starting = startEgressProxy().then(
      (p) => { shared = p; },
      (e: Error) => {
        console.warn(`[egress-proxy] could not start, agent CLIs dial directly: ${e.message}`);
        starting = null;
      },
    );
  }
  return {};
}
