/**
 * WHERE the knock comes from: the home network, or the internet.
 *
 * ── THE QUESTION THE CARD COULD NOT ASK ─────────────────────────────────────
 * The approval card shows the raw address: `192.168.1.7` or `95.253.69.40`.
 * Those are two very different facts and they read the same, because telling
 * them apart requires knowing what `192.168.` means, which is not something a
 * Mac owner should have to know in order to decide whether to let somebody in.
 *
 * The difference matters: a device on the local network is somebody already
 * inside the house, and in this product's model that is nearly always a
 * request you were expecting. Something arriving through the relay may be your
 * own phone away from home, and may be anyone who received a link. Those are
 * the two cases you want to look at the code with different attention.
 *
 * ── WHY LOOKING AT THE ADDRESS IS NOT ENOUGH ────────────────────────────────
 * Because through the relay the peer is ALWAYS loopback, and the real address
 * arrives in a forwarding header that `clientIpOf` reads only for what came
 * through the tunnel (`lib/tunnel.ts`). This module classifies what that
 * function already established, and does not try to guess again.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is not an access decision: no authorisation branch looks at it. Its job
 * is to put a sentence next to a number, so whoever approves reads a fact
 * instead of having to deduce one. The decision stays with whoever holds the
 * Mac.
 */

/** Where the knocker is, as told to whoever approves. */
export type Provenienza =
  /** This very machine. */
  | "locale"
  /** The home or office network: the knocker is already inside. */
  | "lan"
  /** Outside: it came through the relay, and could be anywhere. */
  | "internet"
  /** We do not know: the address is missing or unrecognised. */
  | "ignota";

/** Strips the IPv4-in-IPv6 wrapper, which is noise to any reader. */
function nudo(ip: string): string {
  return ip.toLowerCase().replace(/^::ffff:/, "");
}

/**
 * Is this the machine itself?
 *
 * A deliberate duplicate of `isLoopbackAddress` (auth-gate): that one holds a
 * GATE and must not be able to change for presentation reasons. This one
 * describes, and the two are kept apart precisely because the second is the
 * one somebody will be tempted to widen.
 */
function loopback(a: string): boolean {
  return a === "::1" || a === "localhost" || /^127\./.test(a);
}

/**
 * An address on the local network.
 *
 * The RFC 1918 private ranges, IPv4 link-local, and the two IPv6 forms a home
 * network actually uses: `fe80::/10` (link-local) and `fc00::/7` (unique
 * local).
 *
 * `172.16.0.0/12` is checked on the second octet and not with a text prefix:
 * `172.1` and `172.200` are not private, and a `startsWith("172.1")` would
 * catch both.
 */
function privato(a: string): boolean {
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  const m = /^172\.(\d{1,3})\./.exec(a);
  if (m) {
    const secondo = Number(m[1]);
    if (secondo >= 16 && secondo <= 31) return true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;
  return false;
}

/**
 * Where this request comes from.
 *
 * `null` and strings that do not look like an address give `ignota`, not
 * `internet`: saying "it comes from outside" when we do not know is telling a
 * fact we do not have, in the direction that frightens most.
 */
export function provenienzaDi(ip: string | null | undefined): Provenienza {
  if (!ip) return "ignota";
  const a = nudo(ip.trim());
  if (a.length === 0) return "ignota";
  if (loopback(a)) return "locale";
  if (privato(a)) return "lan";
  // A real public address looks like an address: four numbers, or something
  // with colons. What is not stays unknown, instead of becoming "internet" by
  // elimination.
  const paIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(a);
  const paIPv6 = a.includes(":");
  return paIPv4 || paIPv6 ? "internet" : "ignota";
}
