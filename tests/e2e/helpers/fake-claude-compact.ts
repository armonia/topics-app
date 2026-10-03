#!/usr/bin/env bun
/**
 * UNA CLI FINTA CHE COMPATTA — e basta.
 *
 * Riproduce, riga per riga, la sequenza che la CLI vera (Claude Code 2.1.237)
 * emette su `/compact`, REGISTRATA dal vivo il 20/08/2026:
 *
 *   {"type":"system","subtype":"init",...}
 *   {"type":"system","subtype":"compact_boundary",...}   ← l'esito vero
 *   {"type":"result","subtype":"success","result":"", "num_turns":0}  ← la FINE
 *
 * Il terzo frame è il punto: una compattazione non produce testo, quindi il suo
 * `result` è vuoto — e finché il provider scartava ogni result senza testo, il
 * turno non finiva mai e moriva al watchdog dei 30 minuti (vedi
 * `server/providers/claude-code-compaction-result.test.ts`).
 *
 * Su un messaggio qualsiasi risponde normalmente, così la stessa CLI serve a
 * provare anche cosa succede DOPO: che la coda dei messaggi scritti nel
 * frattempo riparta davvero, visto che il drain è appeso alla fine di uno
 * stream.
 *
 * Parla `--input-format stream-json` su stdin e `--output-format stream-json`
 * su stdout: è tutto ciò che il provider si aspetta.
 *
 * ON AN EMPTY SESSION IT FAILS, like the real one. Claude Code 2.1.288 answers
 * `/compact` with no conversation behind it with this sequence, recorded on
 * 2026-10-03:
 *
 *   {"type":"system","subtype":"status","status":"compacting"}
 *   {"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"Not enough messages to compact."}
 *   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not enough messages to compact."}]}}
 *   {"type":"result","subtype":"success","result":"Not enough messages to compact.","num_turns":0,"total_cost_usd":0}
 *
 * No `compact_boundary`: the only outcome is the end of the turn.
 */

const ARGV = process.argv.slice(2);
const flagOf = (name: string): string | undefined => {
  const at = ARGV.indexOf(name);
  return at >= 0 ? ARGV[at + 1] : undefined;
};

// The server also runs the CLI for its version and for one-shot titles; those
// are answered and closed here, the same way the other fakes do.
if (ARGV.includes("--version") || ARGV.includes("-v")) {
  process.stdout.write("claude 2.1.288-e2e-compact\n");
  process.exit(0);
}
if (flagOf("--output-format") === "json") {
  process.stdin.on("data", () => {});
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Titolo" }) + "\n");
    process.exit(0);
  }, 50);
}

const SESSION_ID = flagOf("--session-id") ?? flagOf("--resume") ?? "00000000-0000-4000-8000-000000000000";

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: "claude-finto",
    tools: [],
    fast_mode_state: "off",
  });
}

/** La sequenza di una compattazione riuscita: boundary + result VUOTO. */
function compact(): void {
  init();
  out({
    type: "system",
    subtype: "compact_boundary",
    session_id: SESSION_ID,
    compact_metadata: { trigger: "manual", pre_tokens: 574474 },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    stop_reason: null,
    session_id: SESSION_ID,
    result: "",
    duration_ms: 120,
    total_cost_usd: 0,
  });
}

/** The recorded failure of `/compact` on a session with nothing to compact. */
function compactFails(): void {
  init();
  out({ type: "system", subtype: "status", status: "compacting", session_id: SESSION_ID });
  out({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact.", session_id: SESSION_ID });
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Not enough messages to compact." }] },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    stop_reason: null,
    session_id: SESSION_ID,
    result: "Not enough messages to compact.",
    duration_ms: 40,
    total_cost_usd: 0,
  });
}

/** Un turno normale: un po' di testo e il suo result. */
function rispondi(testo: string): void {
  init();
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      role: "assistant",
      content: [{ type: "text", text: testo }],
      usage: { input_tokens: 10, output_tokens: 4 },
      model: "claude-finto",
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: SESSION_ID,
    result: testo,
    duration_ms: 90,
    total_cost_usd: 0,
  });
}

function testoDi(riga: string): string | null {
  try {
    const o = JSON.parse(riga) as { message?: { content?: unknown } };
    const c = o?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
        .map((b) => (b.type === "text" ? b.text ?? "" : ""))
        .join("");
    }
  } catch { /* riga non JSON: si ignora */ }
  return null;
}

/** Ordinary turns answered so far: with none, there is nothing to compact. */
let turns = 0;
let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const riga = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!riga) continue;
    const testo = testoDi(riga);
    if (testo === null) continue;
    if (testo.trim() === "/compact") {
      if (turns === 0) compactFails();
      else compact();
    } else {
      turns++;
      rispondi(`ricevuto: ${testo.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
