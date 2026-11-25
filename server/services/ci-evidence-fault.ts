/** A push runs the repo's pre-push hooks, which take minutes on a loaded machine: 60s cut them off and the push never landed. */
export const CI_PUSH_TIMEOUT_MS = 300_000;

/** `git push --porcelain` refused the ref because the remote moved on. */
export function pushRejectedAsNonFastForward(porcelainOut: string): boolean {
  return /\[rejected\] \((non-fast-forward|fetch first)\)/.test(porcelainOut);
}

export type CiStep = "push" | "draft-pr";

/**
 * A step that failed for the board's own machinery: the call was cut by its cap (exit 137, "killed after"),
 * the network or the host did not answer, or the credentials were refused. Anything else (a pre-push hook
 * that declines the content, a rule of the remote) can come from the code being measured: the integration
 * tree runs ITS hooks, so a card that breaks them must not be passed off as the board's fault.
 */
const BOARD_FAULT = new RegExp([
  "exited 137", "killed after",
  "could not resolve host", "unable to access", "failed to connect", "connection (?:timed out|refused|reset)",
  "operation timed out", "network is unreachable", "remote end hung up", "early eof",
  "ssl certificate", "schannel", "gnutls", "tls handshake",
  "authentication failed", "permission denied \\(publickey", "could not read username", "http 401", "http 403",
  "http 5\\d\\d", "error connecting to", "gh auth login", "not logged in",
].join("|"), "i");

export function isBoardFault(error: string): boolean {
  return BOARD_FAULT.test(error);
}

/**
 * A step of ours that failed: always said in the server log (it used to vanish into a row's tail). The caller
 * hears of it only when the cause is the board's machinery, never when a hook refused the content.
 */
export function reportStepFault(
  who: { taskId: string; sha: string },
  step: CiStep,
  reason: string,
  onFault?: (step: CiStep, error: string) => void,
): void {
  console.warn(`[ci-evidence] ${who.taskId.slice(0, 8)} ${step} failed on ${who.sha.slice(0, 8)}: ${reason}`);
  if (!isBoardFault(reason)) return;
  try { onFault?.(step, reason); } catch { /* a report must never change the outcome */ }
}
