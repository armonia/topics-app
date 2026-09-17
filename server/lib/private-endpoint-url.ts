/**
 * Is this address one a configured endpoint is allowed to talk to?
 *
 * This is NOT `isSafePublicUrl` (server/browser-framing.ts) with the sign
 * flipped. That guard exists to keep the framing browser OUT of the private
 * network; here the private network is the whole point, because the endpoint a
 * user configures is a llama-server on their desk or a box on their tailnet.
 * What stays forbidden is the narrow set that is dangerous regardless of who
 * asked: link-local (cloud metadata sits on 169.254.169.254), the unspecified
 * range, and multicast.
 *
 * The check runs per request, not once at save time: a name that resolved to
 * loopback yesterday can resolve anywhere today, and the redirect chain is
 * re-checked hop by hop.
 */
import { lookup } from "node:dns/promises";

export type AddressResolver = (host: string) => Promise<{ address: string; family: number }[]>;

const MAX_REDIRECTS = 5;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || (part.length > 1 && part[0] === "0")) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n >>> 0;
}

function inRange(value: number, base: string, bits: number): boolean {
  const start = ipv4ToInt(base);
  if (start === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (start & mask);
}

/** Addresses no endpoint may point at, however the user configured it. */
export function isForbiddenEndpointIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable, so unusable
  return (
    inRange(n, "0.0.0.0", 8) ||        // "this" network
    inRange(n, "169.254.0.0", 16) ||   // link-local, and cloud metadata with it
    inRange(n, "224.0.0.0", 4) ||      // multicast
    inRange(n, "240.0.0.0", 4)         // reserved
  );
}

export function isForbiddenEndpointIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isForbiddenEndpointIpv4(mapped[1]);
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^ff/.test(lower)) return true;       // multicast
  return false;
}

function isForbiddenAddress(address: string, family: number): boolean {
  return family === 6 ? isForbiddenEndpointIpv6(address) : isForbiddenEndpointIpv4(address);
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; error: string };

const defaultResolver: AddressResolver = (host) => lookup(host, { all: true });

/**
 * Check one URL, resolving its host now. A literal address is checked as it is;
 * a name is checked on every address it resolves to, because one poisoned
 * answer among several is still a way in.
 */
export async function checkEndpointUrl(
  raw: string,
  resolver: AddressResolver = defaultResolver,
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "The endpoint address is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "An endpoint must be reached over http or https." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "The endpoint address must not carry a user name or a password." };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 4 : host.includes(":") ? 6 : 0;
  if (literalFamily) {
    return isForbiddenAddress(host, literalFamily)
      ? { ok: false, error: `The endpoint address ${host} is not reachable from this server.` }
      : { ok: true, url };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, error: `The endpoint name ${host} does not resolve.` };
  }
  if (!addresses.length) return { ok: false, error: `The endpoint name ${host} does not resolve.` };
  for (const entry of addresses) {
    if (isForbiddenAddress(entry.address, entry.family)) {
      return { ok: false, error: `The endpoint name ${host} resolves to an address this server refuses to call.` };
    }
  }
  return { ok: true, url };
}

/** Raised when a destination, or a hop of its redirect chain, is refused. */
export class EndpointUrlError extends Error {}

/**
 * Fetch an endpoint with the guard in front of every hop.
 *
 * `redirect: "manual"` is what makes the per-hop check possible at all: with
 * the default the runtime follows the chain itself, and a 302 towards the
 * metadata address would be fetched before anybody could look at it.
 */
export async function fetchCheckedEndpoint(
  raw: string,
  init: RequestInit = {},
  resolver: AddressResolver = defaultResolver,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await checkEndpointUrl(target, resolver);
    if (!verdict.ok) throw new EndpointUrlError(verdict.error);
    const response = await doFetch(verdict.url.toString(), { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, verdict.url).toString();
  }
  throw new EndpointUrlError("The endpoint redirected too many times.");
}
