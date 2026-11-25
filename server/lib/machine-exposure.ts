/**
 * Which ports of a cloud node answer from OUTSIDE.
 *
 * The node's own probe sees `ufw` off and every listening port, but a cloud
 * provider can put a firewall in front of the machine (the fixed Hetzner server
 * lets only 22 in). The computer that collects the data, which is not on the
 * node's network, opens a TCP connection to each port the node says it listens
 * on and that measure wins over `ufw`.
 *
 * Reliability rule: the measure counts only if port 22 answers in the same
 * round. A refused or silent 22 means this computer cannot reach the machine
 * (VPN, no network), so "nothing answers" would prove nothing and the report
 * stays as the node wrote it.
 */
import { connect } from "node:net";
import type { AccessFacts, MachineSecurityReport } from "../../shared/machine-health";
import { composeAccess, worstStatus } from "./machine-security";

export const EXPOSURE_TIMEOUT_MS = 3_000;
/** The control port gets more tries: one lost SYN must not discard the whole measure. */
export const CONTROL_ATTEMPTS = 3;
export const PORT_ATTEMPTS = 2;
/** How long the last good measure of a host stands in for a round where 22 did not answer. */
export const LAST_MEASURE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

type MeasureMemory = Map<string, { open: number[]; at: number }>;

const sharedMemory: MeasureMemory = new Map();

/** `true` if a TCP connection to `host:port` is accepted within the deadline. */
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpPortProbe: PortProbe = (host, port, timeoutMs) => new Promise((resolve) => {
  const socket = connect({ host, port });
  let settled = false;
  const done = (answered: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(answered);
  };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

/** A routable IPv4: not private, loopback, link-local, CGNAT (Tailscale) or multicast. */
export function isPublicIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** The public address of a machine, from the node pool's state file (`slots.<n>.machine_id` and `.ip`). */
export function poolIpOf(stateText: string, machineId: string): string | null {
  try {
    const slots = (JSON.parse(stateText) as { slots?: Record<string, { machine_id?: string; ip?: string }> }).slots ?? {};
    for (const slot of Object.values(slots)) {
      if (slot.machine_id === machineId && typeof slot.ip === "string" && isPublicIpv4(slot.ip)) return slot.ip;
    }
  } catch { /* not the pool's file: no address */ }
  return null;
}

/** `true` if any of `attempts` tries connects: a single lost packet is not an answer. */
async function answersWithin(probe: PortProbe, host: string, port: number, timeoutMs: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probe(host, port, timeoutMs).catch(() => false)) return true;
  }
  return false;
}

/** The ports among `declared` that accept a connection from here; `null` if 22 does not answer (the measure proves nothing). */
export async function measureOpenPorts(host: string, declared: number[], probe: PortProbe = tcpPortProbe, timeoutMs = EXPOSURE_TIMEOUT_MS): Promise<number[] | null> {
  const ports = [...new Set(declared)].filter((p) => p !== 22);
  const [control, ...answers] = await Promise.all([22, ...ports].map((p) => answersWithin(probe, host, p, timeoutMs, p === 22 ? CONTROL_ATTEMPTS : PORT_ATTEMPTS)));
  if (!control) return null;
  return ports.filter((_, i) => answers[i]).sort((a, b) => a - b);
}

/** The same report with the access sentence rebuilt on the measured ports; unchanged if the node sent no facts. */
export function withProviderFirewall(report: MachineSecurityReport, open: number[]): MachineSecurityReport {
  const facts = report.access_facts;
  if (!facts) return report;
  const rebuilt: AccessFacts = { ...facts, providerFirewall: { open } };
  const checks = report.checks.map((c) => (c.key === "access" ? composeAccess(rebuilt) : c));
  return { ...report, status: worstStatus(checks), checks, access_facts: rebuilt };
}

/**
 * Measures `host` and applies the result. When the round is unreliable (22 silent) the last good
 * measure of the same host is reused while it is younger than LAST_MEASURE_MAX_AGE_MS; with none,
 * the report stays as the node wrote it.
 */
export async function applyExposure(report: MachineSecurityReport, host: string | null, probe: PortProbe = tcpPortProbe, now: number = Date.now(), memory: MeasureMemory = sharedMemory): Promise<MachineSecurityReport> {
  const declared = report.access_facts?.ports;
  if (!host || !declared) return report;
  const open = await measureOpenPorts(host, declared, probe);
  if (open !== null) {
    memory.set(host, { open, at: now });
    return withProviderFirewall(report, open);
  }
  const kept = memory.get(host);
  if (!kept || now - kept.at > LAST_MEASURE_MAX_AGE_MS) return report;
  return withProviderFirewall(report, kept.open.filter((p) => declared.includes(p)));
}
