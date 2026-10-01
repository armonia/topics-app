/**
 * THE LISTENING TCP PORTS OF THE MACHINE, one cached `lsof` shared by every
 * reader (the Processes panel, the status dropdown, the detection of servers
 * started in a PTY, the server watch of BGVIS-08). Moved out of
 * `routes/processes.ts` as it was, with the address kept beside each port: the
 * chat's server row writes `127.0.0.1:8777`, not just `8777`.
 */

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

async function readListeningPorts(now: number): Promise<typeof cachedPorts> {
  try {
    const output = await readProcessProbe(["/usr/sbin/lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]);

    const ports: ListeningPort[] = [];
    const seen = new Set<number>();
    for (const line of output.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const cmd = parts[0];
      const pid = parseInt(parts[1], 10);
      const nameField = parts[8] || "";
      const portMatch = nameField.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push({ port, pid, command: cmd, host: nameField.slice(0, -portMatch[0].length) || "*" });
    }
    ports.sort((a, b) => a.port - b.port);
    cachedPorts = ports;
    cachedPortsAt = now;
    return ports;
  } catch {
    return cachedPorts;
  }
}

/** The listening addresses of each tracked pid's process tree, from one port list. */
export async function listenersOf(
  pids: number[],
  ports: ReadonlyArray<ListeningPort>,
  treeOf: (pid: number) => Promise<Set<number>>,
): Promise<Map<number, Array<{ host: string; port: number }>>> {
  const out = new Map<number, Array<{ host: string; port: number }>>();
  for (const pid of pids) {
    const tree = await treeOf(pid);
    out.set(pid, ports.filter((lp) => tree.has(lp.pid)).map((lp) => ({ host: lp.host, port: lp.port })));
  }
  return out;
}
