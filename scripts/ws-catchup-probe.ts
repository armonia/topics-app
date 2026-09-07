/**
 * What OPENING A SOCKET costs, in bytes, on a server with turns in flight.
 *
 * Run by hand against the test server (never against the one on 3333):
 *
 *   npx playwright test --list >/dev/null   # or any way you have of booting it
 *   bun run scripts/ws-catchup-probe.ts     # E2E_PORT to point it elsewhere
 *
 * It seeds `--streams` turns in flight through the E2E verb
 * `POST /api/test/streams/partial`, opens ONE socket, sends NOTHING, and reads
 * for a couple of seconds. Every frame is counted by `type`, so the table says
 * which frame is the fat one instead of giving a single total that could be
 * anything. Read-only in the sense that matters: it never writes on the socket.
 *
 * Why it exists: the audit of 2026-09-07 measured 2,828,244 B of
 * `stream:catchup` on a real instance with 4 turns in flight, paid again on
 * every refresh, second window and reconnect. The budget below is the shape of
 * that finding, and this probe is where the number is READ; the invariant that
 * keeps it there is tests/integration/catchup-payload-weight.test.ts.
 *
 * Exit 1 above the budget, so it can be run as a gate. Read on this machine
 * against the test server, 4 seeded turns of 7 tool calls each: 727,024 B in
 * the old shape (over budget, exit 1) against 83,092 B.
 */

export {}; // top-level await needs this file to be a module

const PORT = Number(process.env.E2E_PORT || 13334);
const BASE = `http://127.0.0.1:${PORT}`;
const STREAMS = Number(process.env.PROBE_STREAMS || 4);
const BUDGET_BYTES = 300 * 1024;
/** How long to listen. The catchup is written inside the open handler, so this is slack, not a wait for work. */
const LISTEN_MS = 2000;

async function seed(): Promise<void> {
  for (let i = 0; i < STREAMS; i++) {
    const resp = await fetch(`${BASE}/api/test/streams/partial`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: `topic:ws-catchup-probe-${i}`, finishedTools: 6, toolKb: 4 }),
    });
    if (!resp.ok) {
      throw new Error(`seed ${i}: HTTP ${resp.status} — is the TEST server up on ${PORT} with TOPICS_E2E=1?`);
    }
  }
}

function listen(): Promise<Map<string, { frames: number; bytes: number }>> {
  return new Promise((resolve, reject) => {
    const byType = new Map<string, { frames: number; bytes: number }>();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const stop = setTimeout(() => { ws.close(); resolve(byType); }, LISTEN_MS);
    ws.onerror = () => { clearTimeout(stop); reject(new Error(`cannot open ws://127.0.0.1:${PORT}/ws`)); };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const bytes = typeof ev.data === "string" ? Buffer.byteLength(raw, "utf8") : (ev.data as ArrayBuffer).byteLength;
      let type = "(binary)";
      if (raw) { try { type = String((JSON.parse(raw) as { type?: unknown }).type ?? "(untyped)"); } catch { type = "(unparsed)"; } }
      const row = byType.get(type) ?? { frames: 0, bytes: 0 };
      row.frames += 1; row.bytes += bytes;
      byType.set(type, row);
    };
  });
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

await seed();
const byType = await listen();
const rows = [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const total = rows.reduce((n, [, r]) => n + r.bytes, 0);

console.log(`ws open with ${STREAMS} turns in flight, on port ${PORT}`);
for (const [type, r] of rows) console.log(`  ${type.padEnd(28)} ${String(r.frames).padStart(3)} frames  ${kb(r.bytes).padStart(10)}`);
console.log(`  ${"TOTAL".padEnd(28)} ${String(rows.reduce((n, [, r]) => n + r.frames, 0)).padStart(3)} frames  ${kb(total).padStart(10)}`);

const catchup = byType.get("stream:catchup")?.bytes ?? 0;
console.log(`\nstream:catchup: ${catchup} B (budget ${BUDGET_BYTES} B for ${STREAMS} turns)`);
if (catchup === 0) {
  console.error("no catchup frame arrived: the seeding did not reach the registry, the measurement says nothing");
  process.exit(1);
}
if (catchup > BUDGET_BYTES) {
  console.error(`over budget by ${kb(catchup - BUDGET_BYTES)}`);
  process.exit(1);
}
process.exit(0);
