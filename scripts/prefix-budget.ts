#!/usr/bin/env bun
/**
 * Quanto pesa il PREFISSO di una chat, e quanto Topics costa in più della CLI nuda.
 *
 * ── Perché esiste ───────────────────────────────────────────────────────────
 * Il prefisso è la parte del prompt che viaggia IDENTICA a ogni richiesta del
 * turno. Un turno agentico con N round-trip lo paga N volte, quindi ogni token
 * qui dentro è moltiplicato per N. È la voce che decide la bolletta, ed era
 * l'unica senza un numero: si discuteva di «troppi tool» senza sapere quanti
 * token fossero.
 *
 * ── Le due modalità ─────────────────────────────────────────────────────────
 *   bun run scripts/prefix-budget.ts
 *     Conta i tool e i BYTE degli schemi, offline, in ~2 secondi. Nessuna
 *     chiamata al modello, nessun costo. Serve a vedere una deriva («il bridge
 *     è passato da 43 a 51 tool») e a sapere quale server pesa cosa.
 *
 *   bun run scripts/prefix-budget.ts --probe
 *     Misura il prefisso VERO facendo girare `claude -p` con una domanda che
 *     non chiama nessun tool, e leggendo `cache_creation_input_tokens` della
 *     prima richiesta dal transcript. Costa qualche richiesta reale. È l'unico
 *     numero non stimato: i byte/4 sbagliano di parecchio sugli schemi JSON
 *     (misurato: il bridge Topics stimato 8.989, reale 12.555, +40%).
 *
 * ── Riferimento misurato, 8 agosto 2026, CLI 2.1.226, opus-5[1m], cwd=$HOME ──
 *   CLI nuda, cartella vuota .................  108.829
 *   CLI nuda, cwd $HOME ......................  114.518   <- la baseline onesta
 *   CLI + bridge Topics ......................  127.073   (bridge = +12.555)
 *   Topics vero (chat dec44329) ..............  131.398   (+16.880 sulla CLI)
 *   solo bridge Topics, --strict ..............  64.916
 *   bridge + exa + context7, --strict .........  69.598   (exa+context7 = 4.682)
 *   => gateway da solo ....................... ~57.475   (44% del prefisso)
 *   => base CLI senza MCP .................... ~52.361
 *
 * Il gateway lo pagano ENTRAMBI (sta in ~/.claude.json, scope utente): non è la
 * differenza fra i due, è il costo che condividono. La differenza di Topics è
 * il suo bridge più il blocco <context>.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir, tmpdir } from "os";
import { mkdtempSync, readdirSync, statSync } from "fs";

/** Byte→token: rapporto MISURATO sugli schemi di tool reali, non il 4 canonico.
 *  Il bridge Topics pesa 35.955 byte e costa 12.555 token di prefisso: 2,86
 *  byte/token. Gli schemi JSON tokenizzano molto peggio della prosa perché sono
 *  fatti di punteggiatura e nomi in snake_case: usare 4 sottostima del 40%.
 *
 *  ATTENZIONE, il rapporto NON è costante fra server: il gateway pesa 134.552
 *  byte e costa 57.475 token misurati, cioè 2,34 byte/token — con 2,86 lo si
 *  sottostima del 18%. Questa colonna serve a vedere le PROPORZIONI e la deriva,
 *  non a preventivare la bolletta: per quella c'è `--probe`, che non stima. */
const BYTES_PER_TOKEN_SCHEMA = 2.86;

const est = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN_SCHEMA);
const fmt = (n: number) => n.toLocaleString("it-IT");

type Surface = { name: string; tools: number; bytes: number; note?: string };

// ── 1. Il bridge di Topics, letto dal codice vero ────────────────────────────
async function topicsBridge(): Promise<Surface[]> {
  const mod = await import(join(import.meta.dir, "..", "server", "mcp", "topics-mcp-server.ts"));
  const out: Surface[] = [];
  for (const [label, profile] of [["topics (chat)", undefined], ["topics (dispatch)", "dispatch"]] as const) {
    const tools = mod.toolsForProfile(profile);
    out.push({ name: label, tools: tools.length, bytes: JSON.stringify(tools).length });
  }
  return out;
}

// ── 2. I server MCP globali che una sessione eredita ─────────────────────────
function globalServers(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8"));
    return (parsed?.mcpServers as Record<string, unknown>) || {};
  } catch { return {}; }
}

/** Una POST JSON-RPC verso un server MCP «streamable http». La risposta può
 *  arrivare come JSON secco o come stream SSE (`data: {...}`): si accettano
 *  entrambe, perché quale dei due usi è una scelta del server, non nostra. */
async function rpc(url: string, body: unknown, sessionId?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: any = null;
  for (const line of text.split("\n")) {
    const s = line.replace(/^data:\s*/, "").trim();
    if (!s.startsWith("{")) continue;
    try { const j = JSON.parse(s); if (j.result || j.error) { parsed = j; break; } } catch { /* riga non-JSON */ }
  }
  return { json: parsed, sessionId: res.headers.get("mcp-session-id") || sessionId };
}

/** Interroga un server MCP http con `tools/list`. Null se non risponde: un
 *  server spento non è un errore dello script, è un dato (non pesa nulla).
 *
 *  Due tentativi di proposito: alcuni server rispondono a `tools/list` nudo,
 *  altri pretendono l'handshake `initialize` + `notifications/initialized` e la
 *  sessione negli header. Il gateway è del secondo tipo, e senza handshake
 *  risultava «non raggiungibile» — cioè 0 token per il server che ne pesa di più. */
async function httpToolsList(url: string): Promise<Array<Record<string, unknown>> | null> {
  const list = (j: any) => (Array.isArray(j?.result?.tools) ? j.result.tools : null);
  try {
    const bare = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const direct = list(bare.json);
    if (direct) return direct;

    const init = await rpc(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "topics-prefix-budget", version: "1" },
      },
    });
    if (!init.json?.result) return null;
    await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId ?? undefined);
    const after = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId ?? undefined);
    return list(after.json);
  } catch { /* server spento o non http */ }
  return null;
}

/** Dentro il gateway ci sono figli: il nome del tool è `<figlio>__<tool>`.
 *  Spezzarlo è l'unico modo per sapere QUALE figlio pesa. */
function byGatewayChild(tools: Array<Record<string, unknown>>): Surface[] {
  const agg = new Map<string, Surface>();
  for (const t of tools) {
    const n = String(t.name ?? "");
    const child = n.includes("__") ? n.split("__")[0] : "(gateway core)";
    const row = agg.get(child) ?? { name: `  └ ${child}`, tools: 0, bytes: 0 };
    row.tools++; row.bytes += JSON.stringify(t).length;
    agg.set(child, row);
  }
  return [...agg.values()].sort((a, b) => b.bytes - a.bytes);
}

// ── 3. La probe vera: quanto vale il prefisso, in token, sul campo ───────────
function probePrefix(label: string, extraArgs: string[], cwd: string): number | null {
  const before = new Set(transcriptFiles(cwd));
  const r = spawnSync("claude", ["-p", "--model", "claude-opus-5[1m]", ...extraArgs], {
    input: "rispondi solo con la parola ok",
    cwd, encoding: "utf-8", timeout: 180_000,
  });
  if (r.status !== 0) { console.error(`  ${label}: claude è uscito ${r.status} — ${(r.stderr || "").slice(0, 200)}`); return null; }
  const fresh = transcriptFiles(cwd).filter((f) => !before.has(f));
  const file = fresh.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file) { console.error(`  ${label}: nessun transcript nuovo`); return null; }
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "assistant") continue;
    const u = d?.message?.usage;
    if (!u) continue;
    // Il prompt totale della PRIMA richiesta: fresco + scritto in cache + letto.
    return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  return null;
}

/** I transcript che la CLI scrive per una cwd: il path diventa il nome cartella
 *  con ogni `/` sostituito da `-`. */
function transcriptFiles(cwd: string): string[] {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
  try { return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); }
  catch { return []; }
}

// ── main ─────────────────────────────────────────────────────────────────────
const rows: Surface[] = await topicsBridge();
const servers = globalServers();

for (const [name, def] of Object.entries(servers)) {
  const url = (def as any)?.url;
  if (typeof url !== "string") { rows.push({ name, tools: 0, bytes: 0, note: "stdio — non interrogato" }); continue; }
  const tools = await httpToolsList(url);
  if (!tools) { rows.push({ name, tools: 0, bytes: 0, note: "non raggiungibile" }); continue; }
  rows.push({ name, tools: tools.length, bytes: JSON.stringify(tools).length });
  if (name === "gateway") rows.push(...byGatewayChild(tools));
}

console.log("\nSuperficie dei tool — conteggio e peso degli schemi\n");
console.log("  server                     tool      byte     ~token");
console.log("  " + "-".repeat(52));
for (const r of rows) {
  const note = r.note ? `  (${r.note})` : "";
  console.log(`  ${r.name.padEnd(24)} ${String(r.tools).padStart(4)} ${fmt(r.bytes).padStart(9)} ${fmt(est(r.bytes)).padStart(9)}${note}`);
}
console.log(`\n  Stima con ${BYTES_PER_TOKEN_SCHEMA} byte/token, tarato sul bridge Topics (35.955 B = 12.555 tok misurati).`);
console.log("  I figli del gateway (└) sono già dentro la riga `gateway`, non si sommano.\n");

if (!process.argv.includes("--probe")) {
  console.log("  Per i token VERI (spende qualche richiesta reale):  bun run scripts/prefix-budget.ts --probe\n");
  process.exit(0);
}

console.log("Probe reali — prefisso in token, prima richiesta di una sessione fredda\n");
const home = homedir();
const empty = mkdtempSync(join(tmpdir(), "prefix-probe-"));
const bridgeCfg = join(empty, "topics-only.json");
Bun.write(bridgeCfg, JSON.stringify({
  mcpServers: { topics: { command: process.execPath, args: ["run", join(import.meta.dir, "..", "server", "mcp", "topics-mcp-server.ts"), "--base-url=http://127.0.0.1:3333", "--session-key=probe:prefix"] } },
}));

const probes: Array<[string, string[], string]> = [
  ["CLI nuda, cartella vuota", [], empty],
  ["CLI nuda, cwd $HOME", [], home],
  ["CLI + bridge Topics", ["--mcp-config", bridgeCfg], home],
  ["solo bridge, --strict", ["--mcp-config", bridgeCfg, "--strict-mcp-config"], home],
];
const measured: Record<string, number> = {};
for (const [label, args, cwd] of probes) {
  const n = probePrefix(label, args, cwd);
  if (n != null) { measured[label] = n; console.log(`  ${label.padEnd(30)} ${fmt(n).padStart(9)}`); }
}
const bare = measured["CLI nuda, cwd $HOME"];
const withBridge = measured["CLI + bridge Topics"];
if (bare && withBridge) {
  console.log(`\n  Bridge Topics: +${fmt(withBridge - bare)} token su ogni richiesta.`);
  console.log(`  Flotta MCP globale: ${fmt(withBridge - (measured["solo bridge, --strict"] ?? 0))} token — la pagano SIA Topics SIA la CLI nuda.\n`);
}
