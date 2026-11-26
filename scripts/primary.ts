#!/usr/bin/env bun
/**
 * `bun run primary switch <machine> [--drain-minutes N]`: hands the primary of
 * this computer over to a paired machine (track T4 of
 * `openspec/changes/nodo-principale-a-mano`). The work happens in the running
 * server (`POST /__daemon/primary-switch`); this prints its report.
 * Exit 0 switched, 1 refused (nothing changed), 2 uncertain (this server stays
 * fenced and is no longer the primary: check the other computer), 64 bad usage.
 *
 * `bun run primary reclaim`: after an uncertain switch, and only once the other
 * computer is known NOT to have taken over, makes this server the primary again
 * at a higher epoch and restarts it (`POST /__daemon/primary-reclaim`).
 * Exit 0 reclaimed, 1 refused.
 */
import { readState } from "../server/services/daemon-state";

const [command, machine, ...rest] = process.argv.slice(2);
if (!(command === "switch" && machine) && command !== "reclaim") {
  console.error("usage: bun run primary switch <machine id, name or hostname> [--drain-minutes N]\n       bun run primary reclaim");
  process.exit(64);
}
const at = rest.indexOf("--drain-minutes");
const minutes = at >= 0 ? Number(rest[at + 1]) : NaN;
const state = readState();
if (!state) {
  console.error("no running Topics server found on this computer");
  process.exit(1);
}

let res: Response | null = null;
let lastError = "";
// The server answers TLS or plain HTTP depending on its certificates, as `server-watch.sh` tries.
for (const scheme of ["https", "http"]) {
  try {
    res = await fetch(`${scheme}://127.0.0.1:${state.port}/__daemon/primary-${command}`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify(command === "switch" ? { machine, ...(Number.isFinite(minutes) ? { drainTimeoutMs: minutes * 60_000 } : {}) } : {}),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    break;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}
if (!res) {
  console.error(`the server did not answer: ${lastError}`);
  process.exit(1);
}
const report = await res.json().catch(() => null) as Record<string, unknown> | null;
if (!report) {
  console.error(`unreadable answer, HTTP ${res.status}`);
  process.exit(1);
}
if (command === "reclaim") {
  console.log(report.ok ? `reclaimed at epoch ${report.epoch}: restarting as the primary` : `refused: ${report.error}`);
  process.exit(report.ok ? 0 : 1);
}
for (const key of ["outcome", "step", "error", "epoch", "counts", "parked", "files", "transcripts", "bytes"]) {
  if (report[key] !== undefined) console.log(`${key}: ${typeof report[key] === "object" ? JSON.stringify(report[key]) : report[key]}`);
}
process.exit(report.outcome === "switched" ? 0 : report.outcome === "uncertain" ? 2 : 1);
