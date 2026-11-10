/**
 * The fingerprints of the log: each line's hash is computed from its own
 * content and the hash of the line before, so a change made afterwards shows
 * on every line that follows. Deterministic (the same lines always give the
 * same fingerprints) and short; not a cryptographic claim, the preview only
 * has to show what the product does.
 */

/** A 53-bit string hash (cyrb53), as 14 hex digits. */
function hash53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

export interface ChainLine {
  at: string;
  who: string;
  what: string;
  subject: string;
  detail: string;
}

export const GENESIS = '0'.repeat(14);

/** The fingerprint of one line, given the one before. */
export const lineHash = (prev: string, l: ChainLine): string => hash53(`${prev}|${l.at}|${l.who}|${l.what}|${l.subject}|${l.detail}`);

/** The fingerprints of every line, oldest first. */
export function chainOf(lines: ChainLine[]): string[] {
  const out: string[] = [];
  let prev = GENESIS;
  for (const l of lines) {
    prev = lineHash(prev, l);
    out.push(prev);
  }
  return out;
}

/** Does every line's fingerprint follow from its content and the line before? */
export function chainIsIntact(lines: ChainLine[], hashes: string[]): boolean {
  if (lines.length !== hashes.length) return false;
  let prev = GENESIS;
  return lines.every((l, i) => {
    prev = lineHash(prev, l);
    return prev === hashes[i];
  });
}
