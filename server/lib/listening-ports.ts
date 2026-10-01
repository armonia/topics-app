/**
 * THE LISTENING TCP PORTS OF THE MACHINE, one cached `lsof` shared by every
 * reader (the Processes panel, the status dropdown, the detection of servers
 * started in a PTY, the server watch of BGVIS-08). Moved out of
 * `routes/processes.ts` as it was, with the address kept beside each port: the
 * chat's server row writes `127.0.0.1:8777`, not just `8777`.
 */

import { existsSync } from "node:fs";

export type ListeningPort = { port: number; pid: number; command: string; host: string };

// Cache lsof results for a short time to avoid running it on every request
let cachedPorts: ListeningPort[] = [];
let cachedPortsAt = 0;
let pendingPorts: Promise<typeof cachedPorts> | null = null;
const PORT_CACHE_TTL = 5000;

/** A shared probe must settle even if the operating-system command stalls. */
export async function readProcessProbe(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* The owned probe may already have exited. */ }
      reject(new Error(`Process probe timed out: ${command[0]}`));
    }, 5000);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    const output = (async () => {
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text;
    })();
    return await Promise.race([output, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `maxAgeMs`: how old a cached answer may be (the server watch of BGVIS-08 asks for a fresher one). */
export async function getListeningPorts(maxAgeMs = PORT_CACHE_TTL): Promise<ListeningPort[]> {
  const now = Date.now();
  if (now - cachedPortsAt < maxAgeMs) return cachedPorts;
  if (pendingPorts) return pendingPorts;
  pendingPorts = readListeningPorts(now).finally(() => { pendingPorts = null; });
  return pendingPorts;
}

/**
 * The probe that lists listening sockets with their process. `lsof` sits in
 * /usr/sbin on macOS (launchd's PATH may not reach it, hence the fixed spot)
 * and is not always installed on Linux, where `ss` (iproute2) always is.
 * Null where neither exists (Windows): no ports, as before.
 */
let probe: { cmd: string[]; parse: (output: string) => ListeningPort[] } | null | undefined;
function listeningProbe(): typeof probe {
  if (probe !== undefined) return probe;
  const lsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);
  const ss = process.platform === "linux" ? Bun.which("ss") : null;
  probe = lsof
    ? { cmd: [lsof, "-iTCP", "-sTCP:LISTEN", "-P", "-n"], parse: parseLsof }
    : ss
      ? { cmd: [ss, "-ltnpH"], parse: parseSs }
      : null;
  return probe;
}

/** A listening address as the rows write it: any-address spellings become `*`, as lsof writes them. */
function hostOf(local: string, portText: string): string {
  const host = local.slice(0, -(portText.length + 1));
  return host === "" || host === "0.0.0.0" || host === "[::]" || host === "*" ? "*" : host;
}

/** One port once, lowest first: the first process seen on a port keeps it. */
function uniqueSorted(entries: ListeningPort[]): ListeningPort[] {
  const seen = new Set<number>();
  const ports = entries.filter((e) => (seen.has(e.port) ? false : (seen.add(e.port), true)));
  return ports.sort((a, b) => a.port - b.port);
}

/** `lsof -iTCP -sTCP:LISTEN -P -n`: COMMAND PID ... NAME, after a header line. */
export function parseLsof(output: string): ListeningPort[] {
  const entries: ListeningPort[] = [];
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = parseInt(parts[1]!, 10);
    const name = parts[8] || "";
    const m = name.match(/:(\d+)$/);
    if (!m || !Number.isFinite(pid)) continue;
    entries.push({ port: parseInt(m[1]!, 10), pid, command: parts[0]!, host: hostOf(name, m[1]!) });
  }
  return uniqueSorted(entries);
}

/** `ss -ltnpH`: State Recv-Q Send-Q Local Peer users:(("cmd",pid=N,fd=M)); sockets of other users carry no process. */
export function parseSs(output: string): ListeningPort[] {
  const entries: ListeningPort[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const local = parts[3]!;
    const m = local.match(/:(\d+)$/);
    const proc = parts.slice(5).join(" ").match(/\("([^"]+)",pid=(\d+)/);
    if (!m || !proc) continue;
    entries.push({ port: parseInt(m[1]!, 10), pid: parseInt(proc[2]!, 10), command: proc[1]!, host: hostOf(local, m[1]!) });
  }
  return uniqueSorted(entries);
}

async function readListeningPorts(now: number): Promise<typeof cachedPorts> {
  const p = listeningProbe();
  if (!p) return cachedPorts;
  try {
    const ports = p.parse(await readProcessProbe(p.cmd));
    cachedPorts = ports;
    cachedPortsAt = now;
    return ports;
  } catch {
    return cachedPorts;
  }
}
