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

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null when it is not
 * one. Spelling is why this exists: the same address has many, and a guard that
 * matches on text rather than on value only refuses the spellings it imagined.
 */
function ipv6Groups(ip: string): number[] | null {
  // A trailing dotted quad is legal IPv6 syntax (`::ffff:1.2.3.4`). Fold it
  // into two groups first, so the rest of the parser sees one shape only.
  let text = ip;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const quad = ipv4ToInt(dotted[2]!);
    if (quad === null) return null;
    text = `${dotted[1]}${(quad >>> 16).toString(16)}:${(quad & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 1 : gap !== 0) return null;
  return [...head, ...new Array<number>(halves.length === 2 ? gap : 0).fill(0), ...tail];
}

export function isForbiddenEndpointIpv6(ip: string): boolean {
  const parts = ipv6Groups(ip.toLowerCase().replace(/^\[|\]$/g, ""));
  if (parts === null) return true; // unparseable, so unusable
  if (parts.every((group) => group === 0)) return true; // the unspecified address
  // An IPv4-MAPPED address dials the IPv4 host, so it has to answer to the IPv4
  // rules. It cannot be recognised by its dotted spelling: `new URL()` folds
  // `[::ffff:169.254.169.254]` down to `[::ffff:a9fe:a9fe]` before this function
  // is ever called, so a check written against the dotted form never fires on
  // the one path that matters and the metadata address walks straight through.
  if (parts.slice(0, 5).every((group) => group === 0) && parts[5] === 0xffff) {
    const high = parts[6]!;
    const low = parts[7]!;
    return isForbiddenEndpointIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  if ((parts[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((parts[0]! & 0xff00) === 0xff00) return true; // multicast
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
  let carried = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await checkEndpointUrl(target, resolver);
    if (!verdict.ok) throw new EndpointUrlError(verdict.error);
    const response = await doFetch(verdict.url.toString(), { ...carried, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, verdict.url);
    // The guard clears a hop's ADDRESS; it does not vouch for who answers
    // there, and most of the internet is an address it allows. So credentials
    // stop at the origin they were meant for: otherwise one `302` is all an
    // endpoint needs to hand a user's bearer token to a host of its choosing.
    if (next.origin !== verdict.url.origin) carried = withoutCredentials(carried);
    target = next.toString();
  }
  throw new EndpointUrlError("The endpoint redirected too many times.");
}

/** The same request with nothing on it that authenticates the caller. */
function withoutCredentials(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return { ...init, headers };
}
