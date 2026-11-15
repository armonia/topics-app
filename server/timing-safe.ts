import { timingSafeEqual } from "crypto";

/**
 * Constant-time string compare for secrets (gateway tokens). Avoids leaking the
 * token length/prefix via early-exit timing on `===`. Returns false on any
 * length mismatch (timingSafeEqual throws on unequal-length buffers).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
