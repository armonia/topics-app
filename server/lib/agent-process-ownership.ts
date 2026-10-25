export const AGENT_OWNER_ENV = "TOPICS_OWNER";
export const AGENT_PROCESS_GRACE_MS = 10_000;
const PROCESS_SCAN_TIMEOUT_MS = 3_000;
const PROC_ARGS2_MAX_BYTES = 16 * 1024 * 1024;

let procArgsSysctl: ((pid: number) => Uint8Array | null) | undefined;

export interface OwnerProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  owner: string | null;
}

export interface OwnerProcessTargets {
  pids: number[];
  pgids: number[];
}

export interface OwnerProcessStopDeps {
  scan?: (owners?: ReadonlySet<string>) => Promise<string | null>;
  signal?: (pidOrGroup: number, signal: "SIGTERM" | "SIGKILL") => void;
  wait?: (ms: number) => Promise<void>;
  serverPid?: number;
  graceMs?: number;
}

export function withAgentProcessOwner<T extends Record<string, string | undefined | null>>(
  env: T,
  sessionKey: string,
): T & Record<typeof AGENT_OWNER_ENV, string> {
  return { ...env, [AGENT_OWNER_ENV]: sessionKey } as T & Record<typeof AGENT_OWNER_ENV, string>;
}

export function parseOwnerProcessTable(output: string): OwnerProcessRow[] {
  return parsePsProcessRows(output).map(({ pid, ppid, pgid, owner }) => ({ pid, ppid, pgid, owner }));
}

interface PsProcessRow extends OwnerProcessRow {
  command: string;
}

function ownerCandidates(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s,])TOPICS_OWNER=([^\s,]+)/g)].map((match) => match[1]!);
}

function parsePsProcessRows(output: string): PsProcessRow[] {
  const rows: PsProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const owner = ownerCandidates(match[4]!)[0] ?? null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), owner, command: match[4]! });
  }
  return rows;
}

export function ownerFromProcArgs2(data: Uint8Array): string | null {
  if (data.byteLength < 8) return null;
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const argumentCount = bytes.readInt32LE(0);
  if (argumentCount < 1 || argumentCount > 4096) return null;

  let cursor = bytes.indexOf(0, 4);
  if (cursor < 0) return null;
  cursor++;
  while (cursor < bytes.length && bytes[cursor] === 0) cursor++;

  for (let index = 0; index < argumentCount; index++) {
    const end = bytes.indexOf(0, cursor);
    if (end < 0) return null;
    cursor = end + 1;
  }

  const owners = new Set<string>();
  while (cursor < bytes.length && bytes[cursor] !== 0) {
    const end = bytes.indexOf(0, cursor);
    if (end < 0) return null;
    const entry = bytes.toString("utf8", cursor, end);
    const prefix = `${AGENT_OWNER_ENV}=`;
    if (entry.startsWith(prefix) && entry.length > prefix.length) owners.add(entry.slice(prefix.length));
    cursor = end + 1;
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

export async function verifyOwnerProcessTable(
  output: string,
  readEnvironmentOwner: (pid: number) => Promise<string | null>,
  owners?: ReadonlySet<string>,
): Promise<string> {
  const rows = parsePsProcessRows(output);
  const candidates = rows.filter((row) => ownerCandidates(row.command).length > 0
    && (!owners || ownerCandidates(row.command).some((owner) => owners.has(owner))));
  const verified = new Map<number, string>();
  let unavailable = 0;
  await Promise.all(candidates.map(async (row) => {
    try {
      const owner = await readEnvironmentOwner(row.pid);
      if (owner) verified.set(row.pid, owner);
    } catch {
      unavailable++;
    }
  }));
  if (unavailable) {
    console.warn(`[process-ownership] environment verification unavailable for ${unavailable} candidate process(es); those rows were skipped`);
  }
  return rows.map((row) => {
    const command = row.command.replace(/(?:^|[\s,])TOPICS_OWNER=[^\s,]+/g, " ").replace(/\s+/g, " ").trim();
    const owner = verified.get(row.pid);
    return `${row.pid} ${row.ppid} ${row.pgid} ${command}${owner ? ` TOPICS_OWNER=${owner}` : ""}`;
  }).join("\n");
}

function protectedProcessIds(rows: OwnerProcessRow[], serverPid: number): { pids: Set<number>; pgids: Set<number> } | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const pids = new Set<number>();
  const pgids = new Set<number>();
  let current = byPid.get(serverPid);
  if (!current) return null;
  while (current && !pids.has(current.pid)) {
    pids.add(current.pid);
    if (current.pgid > 0) pgids.add(current.pgid);
    current = current.ppid > 1 ? byPid.get(current.ppid) : undefined;
  }
  return { pids, pgids };
}

export function ownedProcessTargetsFromPs(
  output: string,
  owners: ReadonlySet<string>,
  serverPid = process.pid,
): OwnerProcessTargets | null {
  const rows = parseOwnerProcessTable(output);
  const protectedIds = protectedProcessIds(rows, serverPid);
  if (!protectedIds) return null;
  const owned = rows.filter((row) => row.owner !== null && owners.has(row.owner)
    && !protectedIds.pids.has(row.pid));
  return {
    pids: [...new Set(owned.map((row) => row.pid))],
    pgids: [...new Set(owned.map((row) => row.pgid).filter((pgid) => pgid > 0 && !protectedIds.pgids.has(pgid)))],
  };
}

export function closedOwnersFromPs(
  output: string,
  sessionIsAlive: (sessionKey: string) => boolean,
  serverPid = process.pid,
): string[] | null {
  const rows = parseOwnerProcessTable(output);
  const protectedIds = protectedProcessIds(rows, serverPid);
  if (!protectedIds) return null;
  return [...new Set(rows
    .filter((row) => row.owner !== null && !protectedIds.pids.has(row.pid))
    .map((row) => row.owner!)
    .filter((owner) => !sessionIsAlive(owner)))];
}

function readProcArgs2(pid: number): Uint8Array | null {
  if (!procArgsSysctl) {
    // KERN_PROCARGS2 is MIB [CTL_KERN, KERN_PROCARGS2, pid] on macOS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- bun:ffi is optional in packaged runtimes; failure skips ownership safely
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    procArgsSysctl = (targetPid) => {
      const mib = new Int32Array([1, 49, targetPid]);
      const size = new BigUint64Array(1);
      if (library.symbols.sysctl(ptr(mib), mib.length, null, ptr(size), null, 0) !== 0) return null;
      const byteLength = Number(size[0]);
      if (!Number.isSafeInteger(byteLength) || byteLength < 8 || byteLength > PROC_ARGS2_MAX_BYTES) return null;
      const data = Buffer.alloc(byteLength);
      size[0] = BigInt(byteLength);
      if (library.symbols.sysctl(ptr(mib), mib.length, ptr(data), ptr(size), null, 0) !== 0) return null;
      return data.subarray(0, Number(size[0]));
    };
  }
  return procArgsSysctl(pid);
}

async function readEnvironmentOwner(pid: number): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("KERN_PROCARGS2 is available only on macOS");
  const data = readProcArgs2(pid);
  if (!data) throw new Error("KERN_PROCARGS2 did not return process arguments");
  return ownerFromProcArgs2(data);
}

export async function readOwnerProcessTable(owners?: ReadonlySet<string>): Promise<string | null> {
  if (process.platform !== "darwin") {
    console.warn(`[process-ownership] ps -E unavailable on ${process.platform}; no processes signalled`);
    return null;
  }
  const userId = process.getuid?.();
  if (userId === undefined) {
    console.warn("[process-ownership] current uid unavailable; no processes signalled");
    return null;
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["ps", "-E", "-ww", "-u", String(userId), "-x", "-o", "pid=,ppid=,pgid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROCESS_SCAN_TIMEOUT_MS + 1_000,
    });
  } catch (error) {
    console.warn(`[process-ownership] ps scan could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, _stderr, exitCode]) => ({ stdout, exitCode, timeout: false }))
    .catch(() => ({ stdout: "", exitCode: -1, timeout: false }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    completed,
    new Promise<{ stdout: string; exitCode: number; timeout: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ stdout: "", exitCode: -1, timeout: true }), PROCESS_SCAN_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (result.timeout) {
    try { child.kill("SIGKILL"); } catch { /* The scan already exited. */ }
    void completed.catch(() => {});
    console.warn(`[process-ownership] ps scan timed out after ${PROCESS_SCAN_TIMEOUT_MS} ms; no processes signalled`);
    return null;
  }
  if (result.exitCode !== 0) {
    console.warn(`[process-ownership] ps scan exited ${result.exitCode}; no processes signalled`);
    return null;
  }
  return verifyOwnerProcessTable(result.stdout, readEnvironmentOwner, owners);
}

function signalTargets(
  targets: OwnerProcessTargets,
  signal: "SIGTERM" | "SIGKILL",
  send: (pidOrGroup: number, signal: "SIGTERM" | "SIGKILL") => void,
): void {
  for (const pgid of targets.pgids) {
    try { send(-pgid, signal); } catch { /* The group exited after the scan. */ }
  }
  for (const pid of targets.pids) {
    try { send(pid, signal); } catch { /* The process exited after the scan. */ }
  }
}

export async function stopOwnedAgentProcesses(
  owners: ReadonlySet<string>,
  deps: OwnerProcessStopDeps = {},
): Promise<number> {
  if (!owners.size) return 0;
  const scan = deps.scan ?? readOwnerProcessTable;
  const signal = deps.signal ?? ((pidOrGroup, value) => process.kill(pidOrGroup, value));
  const wait = deps.wait ?? ((ms) => Bun.sleep(ms));
  const serverPid = deps.serverPid ?? process.pid;
  let first: string | null;
  try { first = await scan(owners); } catch (error) {
    console.warn(`[process-ownership] ps scan failed: ${error instanceof Error ? error.message : String(error)}; no processes signalled`);
    return 0;
  }
  if (first === null) return 0;
  const targets = ownedProcessTargetsFromPs(first, owners, serverPid);
  if (!targets) {
    console.warn("[process-ownership] server process missing from ps scan; no processes signalled");
    return 0;
  }
  if (!targets.pids.length) return 0;

  signalTargets(targets, "SIGTERM", signal);
  await wait(deps.graceMs ?? AGENT_PROCESS_GRACE_MS);

  let second: string | null;
  try { second = await scan(owners); } catch (error) {
    console.warn(`[process-ownership] escalation scan failed: ${error instanceof Error ? error.message : String(error)}; SIGKILL skipped`);
    return targets.pids.length;
  }
  if (second === null) return targets.pids.length;
  const stillOwned = ownedProcessTargetsFromPs(second, owners, serverPid);
  if (!stillOwned) {
    console.warn("[process-ownership] server process missing from escalation scan; SIGKILL skipped");
    return targets.pids.length;
  }
  signalTargets(stillOwned, "SIGKILL", signal);
  return targets.pids.length;
}

export async function reconcileOwnedAgentProcesses(
  sessionIsAlive: (sessionKey: string) => boolean,
  deps: OwnerProcessStopDeps = {},
): Promise<number> {
  const scan = deps.scan ?? readOwnerProcessTable;
  let first: string | null;
  try { first = await scan(); } catch (error) {
    console.warn(`[process-ownership] boot scan failed: ${error instanceof Error ? error.message : String(error)}; no processes signalled`);
    return 0;
  }
  if (first === null) return 0;
  const owners = closedOwnersFromPs(first, sessionIsAlive, deps.serverPid ?? process.pid);
  if (!owners) {
    console.warn("[process-ownership] server process missing from boot scan; no processes signalled");
    return 0;
  }
  return stopOwnedAgentProcesses(new Set(owners), { ...deps, scan });
}
