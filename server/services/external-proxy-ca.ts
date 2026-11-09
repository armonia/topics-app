/**
 * Local CA for the external-sessions proxy (`external-proxy.ts`).
 *
 * The proxy has to read the requests that Claude Code sessions opened OUTSIDE
 * Topics (the Claude desktop app) send to api.anthropic.com, so it terminates
 * the TLS with a certificate signed by a CA of ours. That CA is trusted ONLY by
 * the process that receives it through `NODE_EXTRA_CA_CERTS`: it never enters
 * the system keychain, and it carries a name constraint (permitted
 * DNS:api.anthropic.com) that a verifier enforces, so even a leaked key would
 * sign nothing for any other site.
 *
 * Node cannot build X.509 certificates, and a package for a file generated once
 * is not worth its weight: the `openssl` binary does it (every Mac has one).
 * Keys are born in a 0700 directory and closed to 0600 right away; they never
 * reach a log or git.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTERNAL_PROXY_CA_NAME = "Topics External Proxy CA";
const CA_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEW_BEFORE_DAYS = 30;
const DAY_MS = 86_400_000;
/** The only host the CA may sign for, and the only one the proxy opens. */
export const INTERCEPTED_HOST = "api.anthropic.com";

export interface ExternalProxyLeaf {
  caPem: string;
  certFile: string;
  keyFile: string;
  key: Buffer;
  cert: Buffer;
}

/** Where the CA lives inside the Topics state directory. */
export function externalProxyCaDir(stateDir: string): string {
  return join(stateDir, "external-proxy-ca");
}

function findOpenssl(): string {
  for (const p of ["/opt/homebrew/bin/openssl", "/usr/bin/openssl", "/usr/local/bin/openssl"]) {
    if (existsSync(p)) return p;
  }
  return "openssl";
}

function runOpenssl(args: string[], cwd: string): void {
  try {
    execFileSync(findOpenssl(), args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr;
    const detail = String(stderr ?? (e as Error).message).trim().split("\n").slice(-2).join(" ");
    throw new Error(`openssl ${args[0]} failed: ${detail}`);
  }
}

function readCert(file: string): X509Certificate | null {
  try {
    return new X509Certificate(readFileSync(file));
  } catch {
    return null;
  }
}

function daysLeft(cert: X509Certificate): number {
  return (new Date(cert.validTo).getTime() - Date.now()) / DAY_MS;
}

const CA_CNF = `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = ${EXTERNAL_PROXY_CA_NAME}
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;DNS:${INTERCEPTED_HOST}
`;

const leafCnf = (host: string): string => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${host}
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:${host}
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
`;

/** Creates the directory (0700) and the CA when they are missing or about to expire. */
export function ensureExternalProxyCa(dir: string): { caPem: string; caKey: string; created: boolean } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const caPem = join(dir, "ca.pem");
  const caKey = join(dir, "ca-key.pem");
  const existing = readCert(caPem);
  if (existing && existsSync(caKey) && daysLeft(existing) > RENEW_BEFORE_DAYS) {
    chmodSync(caKey, 0o600);
    return { caPem, caKey, created: false };
  }
  const cnf = join(dir, ".ca.cnf");
  writeFileSync(cnf, CA_CNF, { mode: 0o600 });
  try {
    runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKey], dir);
    chmodSync(caKey, 0o600);
    runOpenssl(["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", String(CA_DAYS), "-config", cnf, "-out", caPem], dir);
    chmodSync(caPem, 0o644); // the app has to read it: it is public
  } finally {
    rmSync(cnf, { force: true });
  }
  return { caPem, caKey, created: true };
}

/**
 * The certificate for `host` signed by the CA. It is rebuilt when it is missing,
 * expires within 30 days, or is no longer a child of this CA (the CA was renewed).
 */
export function ensureExternalProxyLeaf(dir: string, host: string = INTERCEPTED_HOST): ExternalProxyLeaf {
  const { caPem, caKey, created } = ensureExternalProxyCa(dir);
  const certFile = join(dir, `leaf-${host}.pem`);
  const keyFile = join(dir, `leaf-${host}-key.pem`);
  const ca = readCert(caPem);
  const leaf = readCert(certFile);
  const fresh = !!ca && !!leaf && existsSync(keyFile) && !created
    && leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && daysLeft(leaf) > RENEW_BEFORE_DAYS;
  if (!fresh) {
    const cnf = join(dir, ".leaf.cnf");
    const csr = join(dir, ".leaf.csr");
    const srl = join(dir, "ca.srl");
    writeFileSync(cnf, leafCnf(host), { mode: 0o600 });
    try {
      runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyFile], dir);
      chmodSync(keyFile, 0o600);
      runOpenssl(["req", "-new", "-key", keyFile, "-config", cnf, "-out", csr], dir);
      runOpenssl(["x509", "-req", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial", "-days", String(LEAF_DAYS),
        "-sha256", "-extfile", cnf, "-extensions", "v3_leaf", "-out", certFile], dir);
      chmodSync(certFile, 0o644);
    } finally {
      for (const f of [cnf, csr, srl]) rmSync(f, { force: true });
    }
  }
  return { caPem, certFile, keyFile, key: readFileSync(keyFile), cert: readFileSync(certFile) };
}
