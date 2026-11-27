/**
 * The token file for a paired node (split out of node-client.ts to keep that
 * file under the bloat gate's line threshold): path shape, read and write,
 * with the `0600`/`0700` discipline `relay-secret` also uses.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";

/** The subset of `node:fs` the token helpers touch, so a test can watch it. */
export interface TokenFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  writeFileSync: (p: string, data: string, opts: { mode: number }) => void;
  mkdirSync: (p: string, opts: { recursive: true; mode: number }) => unknown;
  chmodSync: (p: string, mode: number) => void;
  unlinkSync?: (p: string) => void;
}

const MACHINE_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** `<stateDir>/nodes/<machineId>.token`; a machine id that is not a plain name is refused, it is a file name. */
export function nodeTokenPath(stateDir: string, machineId: string): string {
  if (!MACHINE_ID_SHAPE.test(machineId)) throw new Error(`nodeTokenPath: machine id "${machineId}" is not a file name`);
  return join(stateDir, "nodes", `${machineId}.token`);
}

/** A confined pairing token never overwrites or reuses the machine owner's token. */
export function delegatedNodeTokenPath(stateDir: string, machineId: string, capabilityId: string): string {
  if (!MACHINE_ID_SHAPE.test(machineId) || !MACHINE_ID_SHAPE.test(capabilityId)) {
    throw new Error("delegatedNodeTokenPath: machine and capability ids must be file names");
  }
  return join(stateDir, "nodes", "delegated", machineId, `${capabilityId}.token`);
}

/** `null` = never paired, or the file was tampered into a shape no cookie has. */
export function readNodeToken(stateDir: string, machineId: string, fs: TokenFs = nodeFs): string | null {
  const f = nodeTokenPath(stateDir, machineId);
  try {
    if (!fs.existsSync(f)) return null;
    const v = fs.readFileSync(f, "utf8").trim();
    return /^[A-Za-z0-9_.-]{16,1024}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function readDelegatedNodeToken(
  stateDir: string,
  machineId: string,
  capabilityId: string,
  fs: TokenFs = nodeFs,
): string | null {
  const file = delegatedNodeTokenPath(stateDir, machineId, capabilityId);
  try {
    if (!fs.existsSync(file)) return null;
    const value = fs.readFileSync(file, "utf8").trim();
    return /^[A-Za-z0-9_.-]{16,1024}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Same discipline as `relay-secret` (server/services/relay-config.ts): a file
 * of its own, `0600`, in a `0700` folder. The `chmod` after the write is not
 * redundant: `writeFileSync`'s mode applies only when the file is CREATED, so
 * a re-pairing over an old file left at a wider mode would keep that mode.
 */
export function writeNodeToken(stateDir: string, machineId: string, token: string, fs: TokenFs = nodeFs): string {
  const f = nodeTokenPath(stateDir, machineId);
  const dir = join(stateDir, "nodes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(f, token + "\n", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}

export function writeDelegatedNodeToken(
  stateDir: string,
  machineId: string,
  capabilityId: string,
  token: string,
  fs: TokenFs = nodeFs,
): string {
  const file = delegatedNodeTokenPath(stateDir, machineId, capabilityId);
  const dir = join(stateDir, "nodes", "delegated", machineId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function removeDelegatedNodeToken(
  stateDir: string,
  machineId: string,
  capabilityId: string,
  fs: TokenFs = nodeFs,
): void {
  const file = delegatedNodeTokenPath(stateDir, machineId, capabilityId);
  try {
    if (fs.existsSync(file)) (fs.unlinkSync ?? nodeFs.unlinkSync)(file);
  } catch {
    // Revocation in the database is authoritative. A stale file contains a
    // credential the node has already invalidated and is retried on reissue.
  }
}
