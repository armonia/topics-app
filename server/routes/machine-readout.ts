/**
 * GET /api/system/machine-readout[?machine=<id>]: the load screen's process
 * list and sleep countdown (`server/lib/machine-readout.ts`).
 *
 * Without `machine`, or with the local row's id, it reads THIS machine. With a
 * paired node's id it asks that node's Topics the same question through the
 * node channel the dispatcher already uses: the base URL of the machine row
 * and the device token in the state dir, sent as the device cookie. Read-only
 * both ways, and the token never leaves this server.
 *
 * The answer is always 200 with `{ machine, readout, error }`: «the node does
 * not answer» is something the screen says, not a transport failure.
 */
import os from "os";
import { readFile } from "fs/promises";
import { join } from "path";
import type { AppContext } from "../types";
import { createMachineReadout, WINDOWS_PS_SCRIPT, type MachineReadout } from "../lib/machine-readout";
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";
import { machineCores } from "../lib/machine-cores";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";

const REMOTE_TIMEOUT_MS = 5_000;
/** A node's answer is kept this long: every screen polling the Mac does not become a call to the PC. */
const REMOTE_TTL_MS = 15_000;

async function runText(argv: string[]): Promise<string> {
  const proc = spawnBounded(argv, { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/** Where the Windows sleep keeper keeps its files; null on a machine without one. */
function winfleetDir(): string | null {
  const env = process.env.TOPICS_WINFLEET_DIR;
  if (env && env.trim()) return env.trim();
  return process.platform === "win32" ? "C:\\winfleet" : null;
}

const localReadout = createMachineReadout({
  platform: process.platform,
  cores: () => machineCores(),
  memTotalMB: () => Math.round(os.totalmem() / (1024 * 1024)),
  listProcesses: () => process.platform === "win32"
    ? runText(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PS_SCRIPT])
    : runText(["ps", "-axo", "pid=,rss=,%cpu=,comm="]),
  readScreenFile: async () => {
    const dir = winfleetDir();
    if (!dir) return null;
    try { return await readFile(join(dir, "schermo", "stato.js"), "utf8"); } catch { return null; }
  },
  now: () => Date.now(),
});

interface ReadoutAnswer {
  machine: { id: string | null; name: string; local: boolean };
  readout: MachineReadout | null;
  error: string | null;
}

export function createMachineReadoutRoute(ctx: AppContext): (url: URL) => Promise<Response> {
  const remoteCache = new Map<string, { at: number; answer: ReadoutAnswer }>();

  async function remote(id: string, name: string, baseUrl: string): Promise<ReadoutAnswer> {
    const hit = remoteCache.get(id);
    if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.answer;
    const token = readNodeToken(ctx.STATE_DIR, id);
    let answer: ReadoutAnswer;
    if (!token) {
      answer = { machine: { id, name, local: false }, readout: null, error: "not_paired" };
    } else {
      try {
        const res = await fetch(`${baseUrl}/api/system/machine-readout`, {
          headers: { Accept: "application/json", Cookie: `${NODE_SESSION_COOKIE}=${token}` },
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        const body = res.ok ? (await res.json()) as Partial<ReadoutAnswer> : null;
        answer = { machine: { id, name, local: false }, readout: body?.readout ?? null, error: res.ok ? (body?.readout ? null : "empty") : `http_${res.status}` };
      } catch {
        answer = { machine: { id, name, local: false }, readout: null, error: "unreachable" };
      }
    }
    remoteCache.set(id, { at: Date.now(), answer });
    return answer;
  }

  return async (url: URL) => {
    const wanted = url.searchParams.get("machine");
    const local = (() => { try { return ctx.machineStore.upsertLocal(); } catch { return null; } })();
    if (wanted && wanted !== local?.id) {
      const row = ctx.machineStore.get(wanted);
      if (!row) return Response.json({ machine: { id: wanted, name: wanted, local: false }, readout: null, error: "unknown_machine" } satisfies ReadoutAnswer);
      if (!row.baseUrl || isCloudBaseUrl(row.baseUrl)) {
        return Response.json({ machine: { id: row.id, name: row.name, local: false }, readout: null, error: "not_a_node" } satisfies ReadoutAnswer);
      }
      return Response.json(await remote(row.id, row.name, row.baseUrl));
    }
    const readout = await localReadout();
    return Response.json({ machine: { id: local?.id ?? null, name: local?.name ?? os.hostname(), local: true }, readout, error: null } satisfies ReadoutAnswer);
  };
}
