/**
 * What THIS installation is called, and why the question exists.
 *
 * ── THE GAP IT FILLS ────────────────────────────────────────────────────────
 * A phone asking for access sees "Authorise this device" and a code. It does
 * not see WHO it is asking. While only one Topics exists the question does not
 * arise; the moment there are two (a laptop and a desktop, the test install
 * next to the real one, two people on the same network) "authorise" becomes a
 * request with no subject, and the person at the screen has no way to know
 * where they are walking in.
 *
 * It is also the prerequisite for everything else: a screen asking "do you
 * want to connect to this computer or another one?" cannot even be written
 * until installations have a name a human can read.
 *
 * ── WHY THE COMPUTER'S NAME, AND NOT A NEW ONE ──────────────────────────────
 * Because it is already chosen, and it is already what a person would say out
 * loud: "Attilio's MacBook". Asking for another one at first launch would be
 * one more question for a value the system already knows, and a field that
 * stays empty in nine cases out of ten.
 *
 * On macOS `ComputerName` is the name shown in Settings, spaces and accents
 * included; `hostname()` is its network form (`MacBook-Pro-di-Attilio.local`).
 * The first is preferred and the second is the fallback, cleaned up: a
 * technical name still beats silence.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is not a credential and takes no part in any access decision. It is a
 * label, and it is treated as one: shown to whoever is already knocking, who
 * by definition already has this machine's address.
 */
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * The readable name of the computer.
 *
 * Process-wide cache: `scutil` is a subprocess, and this question arrives on
 * every `/api/auth/session`, meaning on every tab that opens. A computer name
 * changes about once never, and whoever changes it restarts the server.
 */
let memoria: string | null = null;

/** How long it may be, before it becomes a problem for whoever shows it. */
const MAX = 64;

/**
 * Cleans up what the system hands over.
 *
 * Not untrusted-input paranoia (it comes from the machine itself) but the name
 * ends up inside a JSON response a browser paints, and a control character in
 * the middle of an interface is a defect discovered late and badly.
 *
 * EXPORTED on purpose, and the reason is worth writing down. On any given
 * machine only ONE of the two sources runs: this Mac answers from `scutil`, so
 * the hostname branch and this cleanup are never exercised by calling
 * `nomeInstallazione()`. Tests that only call the public function pass
 * identically with the trimming removed, which means they prove nothing about
 * it. The rule is not to work around the source, it is to test the decision
 * where the decision lives.
 */
export function pulisciNome(grezzo: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are EXACTLY what must go
  const senzaControlli = grezzo.replace(/[\u0000-\u001f\u007f]/g, " ");
  const compatto = senzaControlli.replace(/\s+/g, " ").trim();
  return compatto.slice(0, MAX);
}

/**
 * The network name made readable: `foo.local` becomes `foo`.
 *
 * Also exported for the reason above: on a Mac this branch is the fallback,
 * so it only ever runs when the primary source fails, which is exactly when
 * nobody is watching.
 */
export function daHostname(grezzo: string): string {
  return pulisciNome(grezzo.replace(/\.local$/i, ""));
}

/**
 * This installation's name, or `null` when the system does not say.
 *
 * `null` and not a fallback string: whoever shows the name must be able to
 * decide what to do when there is none, and an invented "Unknown computer"
 * here would be a sentence living inside the server, which is the very thing
 * `shared/auth-codes.ts` exists to prevent.
 */
export function nomeInstallazione(): string | null {
  if (memoria !== null) return memoria;

  // The name the person sees in Settings. macOS only: elsewhere `scutil` does
  // not exist and we move on without noise.
  if (process.platform === "darwin") {
    try {
      const v = pulisciNome(execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2_000,
      }));
      if (v.length > 0) { memoria = v; return memoria; }
    } catch {
      // Missing, unresponsive, or not a Mac: fall through.
    }
  }

  try {
    // `MacBook-Pro-di-Attilio.local` becomes `MacBook-Pro-di-Attilio`. The
    // suffix is network plumbing and says nothing to whoever reads it.
    const v = daHostname(hostname());
    if (v.length > 0) { memoria = v; return memoria; }
  } catch {
    // Not even the network name: silence remains, and callers handle it.
  }

  return null;
}

/** Test-only: empties the cache, so two cases never share a name. */
export function __scordaNomeInstallazione(): void {
  memoria = null;
}
