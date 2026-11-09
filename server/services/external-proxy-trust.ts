/**
 * Is the proxy CA trusted by the system store?
 *
 * The Claude desktop app does not hand `NODE_EXTRA_CA_CERTS` down to the `claude`
 * processes it spawns: it sets `NODE_USE_SYSTEM_CA=1`, so a CA that only lives in
 * a file is rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE) on every session. Terminating
 * TLS with an untrusted CA breaks the app, so the proxy checks the trust at every
 * boot and, when it is missing, does NOT intercept (fail-open: a byte tunnel).
 * The check is on the exact certificate file, so a regenerated CA is untrusted
 * again until the person trusts the new one.
 */
import { execFile } from "node:child_process";

export type CaTrustCheck = (caCertificatePath: string) => Promise<boolean>;

const VERIFY_TIMEOUT_MS = 10_000;

/**
 * macOS: `security verify-cert` evaluates the certificate against the keychains'
 * trust settings and exits 0 only when it is trusted for SSL. Other platforms do
 * not have the app that drops the extra-CA variable, so the file is enough there.
 */
export const systemCaTrusted: CaTrustCheck = (caCertificatePath) => {
  if (process.platform !== "darwin") return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["verify-cert", "-c", caCertificatePath, "-p", "ssl"], { timeout: VERIFY_TIMEOUT_MS }, (err) => resolve(!err));
  });
};
