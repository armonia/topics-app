#!/usr/bin/env bun
/**
 * `bun run primary switch <machine> [--drain-minutes N]`: hands the primary of
 * this computer over to a paired machine (track T4 of
 * `openspec/changes/nodo-principale-a-mano`). The work happens in the running
 * server (`POST /__daemon/primary-switch`); this prints its report.
 *
 * Exit 0 switched, 1 refused (nothing changed), 2 uncertain (this server stays
 * fenced: check the other computer before anything else), 64 bad usage.
 */
import { readState } from "../server/services/daemon-state";

const [command, machine, ...rest] = process.argv.slice(2);
if (command !== "switch" || !machine) {
  console.error("usage: bun run primary switch <machine id, name or hostname> [--drain-minutes N]");
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
    res = await fetch(`${scheme}://127.0.0.1:${state.port}/__daemon/primary-switch`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ machine, ...(Number.isFinite(minutes) ? { drainTimeoutMs: minutes * 60_000 } : {}) }),
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
for (const key of ["outcome", "step", "error", "epoch", "counts", "parked", "files", "transcripts", "bytes"]) {
  if (report[key] !== undefined) console.log(`${key}: ${typeof report[key] === "object" ? JSON.stringify(report[key]) : report[key]}`);
}
process.exit(report.outcome === "switched" ? 0 : report.outcome === "uncertain" ? 2 : 1);
