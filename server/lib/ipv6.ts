/**
 * Reading an IPv6 address, for the guards that have to decide about one.
 *
 * WHY THIS IS SHARED AND NOT COPIED. Two guards ask the same question about an
 * address and answer it with different policies: `isSafePublicUrl`
 * (`server/browser-framing.ts`) keeps the framing browser OUT of the private
 * network, `checkEndpointUrl` (`server/lib/private-endpoint-url.ts`) lets a
 * configured endpoint INTO it and refuses only what is dangerous regardless.
 * Opposite policies, identical parsing — and when the parsing was copied into
 * both, so was its blind spot: each matched an IPv4-mapped address by the
 * DOTTED spelling `::ffff:1.2.3.4`, which `new URL()` has already folded into
 * `::ffff:102:304` by the time either guard is called. Both branches were
 * therefore dead on the only path that reaches them, and both guards let
 * `[::ffff:169.254.169.254]` through while refusing `169.254.169.254`.
 *
 * So the policy stays in the guards and the reading lives here, once: a
 * spelling nobody thought of is then a bug in one place rather than in two.
 */

/** Dotted-quad text to a 32-bit number, or null when it is not one. */
export function ipv4ToInt(ip: string): number | null {
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

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null when it is not
 * one. Brackets and letter case are accepted, because that is how addresses
 * actually arrive.
 */
export function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // A trailing dotted quad is legal IPv6 syntax (`::ffff:1.2.3.4`). Fold it
  // into two groups first, so the rest of the parser sees one shape only.
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

/**
 * The IPv4 address an IPv6 literal really dials, in dotted form, or null when
 * it dials no IPv4 address. Only `::ffff:0:0/96` qualifies: it is the form that
 * actually reaches the IPv4 host (measured — a listener on `127.0.0.1` answers
 * `http://[::ffff:7f00:1]/`). IPv4-compatible `::a.b.c.d` and NAT64 do not
 * reach it without infrastructure that is not here, so they are left alone
 * rather than guessed at.
 */
export function ipv4MappedAddress(groups: number[]): string | null {
  if (groups.length !== 8) return null;
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return null;
  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
