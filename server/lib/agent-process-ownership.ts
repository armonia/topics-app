export const AGENT_OWNER_ENV = "TOPICS_OWNER";
export const AGENT_PROCESS_GRACE_MS = 10_000;
const PROCESS_SCAN_TIMEOUT_MS = 3_000;

export interface OwnerProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  owner: string | null;
}

interface RawProcessRow extends Omit<OwnerProcessRow, "owner"> {
  command: string;
}

export interface OwnerProcessTargets {
  pids: number[];
  pgids: number[];
}

export interface OwnerProcessStopDeps {
  scan?: () => Promise<string | null>;
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
  const rows: OwnerProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const owner = /(?:^|[\s,])TOPICS_OWNER=([^\s,]+)/.exec(match[4]!)?.[1] ?? null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), owner });
  }
  return rows;
}

function parseRawProcessTable(output: string): RawProcessRow[] {
  const rows: RawProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! });
  }
  return rows;
}

export function verifiedOwnerProcessTable(
  output: string,
  ownersByPid: ReadonlyMap<number, string | null>,
): string {
  return parseRawProcessTable(output).map((row) => {
    const owner = ownersByPid.get(row.pid);
    return `${row.pid} ${row.ppid} ${row.pgid} ${owner ? `${AGENT_OWNER_ENV}=${owner}` : "-"}`;
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

export async function readOwnerProcessTable(): Promise<string | null> {
  if (process.platform !== "darwin") {
    console.warn(`[process-ownership] ps -E unavailable on ${process.platform}; no processes signalled`);
    return null;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    console.warn("[process-ownership] current uid unavailable; no processes signalled");
    return null;
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["ps", "-E", "-ww", "-u", String(uid), "-x", "-o", "pid=,ppid=,pgid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
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
  const rows = parseRawProcessTable(result.stdout);
  const candidates = rows.filter((row) => /(?:^|[\s,])TOPICS_OWNER=/.test(row.command)).map((row) => row.pid);
  if (!candidates.length) return verifiedOwnerProcessTable(result.stdout, new Map());
  const ownersByPid = await readExactOwnerEnvironments(candidates);
  if (!ownersByPid) return null;
  return verifiedOwnerProcessTable(result.stdout, ownersByPid);
}

const PROCARGS_PYTHON = [
  "import ctypes, errno, json, struct, sys",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "result = {}",
  "for raw_pid in sys.argv[1:]:",
  "    pid = int(raw_pid)",
  "    mib = (ctypes.c_int * 3)(1, 49, pid)",
  "    size = ctypes.c_size_t(0)",
  "    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:",
  "        code = ctypes.get_errno()",
  "        if code == errno.ESRCH:",
  "            continue",
  "        raise OSError(code, 'KERN_PROCARGS2 size query failed')",
  "    buffer = ctypes.create_string_buffer(size.value)",
  "    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:",
  "        code = ctypes.get_errno()",
  "        if code == errno.ESRCH:",
  "            continue",
  "        raise OSError(code, 'KERN_PROCARGS2 read failed')",
  "    raw = buffer.raw[:size.value]",
  "    if len(raw) < 4:",
  "        raise ValueError('KERN_PROCARGS2 response is truncated')",
  "    argc = struct.unpack_from('@i', raw)[0]",
  "    if argc < 0:",
  "        raise ValueError('KERN_PROCARGS2 argc is invalid')",
  "    index = raw.find(b'\\0', 4)",
  "    if index < 0:",
  "        raise ValueError('KERN_PROCARGS2 executable path is unterminated')",
  "    index += 1",
  "    while index < len(raw) and raw[index] == 0:",
  "        index += 1",
  "    for _ in range(argc):",
  "        end = raw.find(b'\\0', index)",
  "        if end < 0:",
  "            raise ValueError('KERN_PROCARGS2 argv is truncated')",
  "        index = end + 1",
  "    while index < len(raw) and raw[index] == 0:",
  "        index += 1",
  "    matches = []",
  "    while index < len(raw):",
  "        end = raw.find(b'\\0', index)",
  "        if end < 0:",
  "            raise ValueError('KERN_PROCARGS2 environment is truncated')",
  "        entry = raw[index:end]",
  "        if not entry:",
  "            break",
  "        if entry.startswith(b'TOPICS_OWNER='):",
  "            matches.append(entry[len(b'TOPICS_OWNER='):].decode('utf-8'))",
  "        index = end + 1",
  "    if len(matches) > 1:",
  "        raise ValueError('KERN_PROCARGS2 has duplicate TOPICS_OWNER entries')",
  "    result[str(pid)] = matches[0] if matches else None",
  "print(json.dumps(result))",
].join("\n");

async function readExactOwnerEnvironments(pids: number[]): Promise<Map<number, string | null> | null> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["python3", "-c", PROCARGS_PYTHON, ...pids.map(String)], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    console.warn(`[process-ownership] KERN_PROCARGS2 reader could not start: ${error instanceof Error ? error.message : String(error)}; no processes signalled`);
    return null;
  }
  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode, timeout: false }))
    .catch((error) => ({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: -1, timeout: false }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    completed,
    new Promise<{ stdout: string; stderr: string; exitCode: number; timeout: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ stdout: "", stderr: "", exitCode: -1, timeout: true }), PROCESS_SCAN_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (result.timeout) {
    try { child.kill("SIGKILL"); } catch { /* The reader already exited. */ }
    void completed.catch(() => {});
    console.warn(`[process-ownership] KERN_PROCARGS2 scan timed out after ${PROCESS_SCAN_TIMEOUT_MS} ms; no processes signalled`);
    return null;
  }
  if (result.exitCode !== 0) {
    console.warn(`[process-ownership] KERN_PROCARGS2 scan exited ${result.exitCode}; no processes signalled`);
    return null;
  }
  try {
    const decoded = JSON.parse(result.stdout) as Record<string, string | null>;
    return new Map(Object.entries(decoded).map(([pid, owner]) => [Number(pid), owner]));
  } catch (error) {
    console.warn(`[process-ownership] KERN_PROCARGS2 response was invalid; no processes signalled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
  try { first = await scan(); } catch (error) {
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
  try { second = await scan(); } catch (error) {
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
