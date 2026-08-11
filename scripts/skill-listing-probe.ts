#!/usr/bin/env bun
/**
 * Quanto pesa il CATALOGO delle skill nel prefisso di un agente dispacciato.
 *
 * ── Perché esiste ───────────────────────────────────────────────────────────
 * Le skill dell'utente entrano nella sessione da `--setting-sources user,…` e
 * il loro elenco viaggia nel PREFISSO: non si paga una volta, si ripaga a ogni
 * richiesta del turno. Su un task da ~40 turni fanno ~170k token di cache-read
 * per una lista che l'agente non legge (i suoi ordini stanno nel task).
 *
 * `slimSkillListing` in `server/providers/claude/args.ts` manda l'elenco coi
 * soli NOMI. Questo script è il modo di rimisurare quel numero quando esce una
 * release della CLI, senza fidarsi del commento: costruisce l'argv VERO con
 * `buildClaudeArgs`, fa partire due sessioni identiche tranne quella opzione, e
 * legge dai transcript il prefisso della prima richiesta e i byte
 * dell'attachment `skill_listing`.
 *
 *   bun run scripts/skill-listing-probe.ts            # due sessioni opus
 *   PROBE_MODEL=claude-haiku-4-5-20251001 bun run …   # più economico: i BYTE
 *                                                     # dell'elenco bastano a
 *                                                     # vedere se la leva morde
 *   PROBE_SEED=820 bun run …                          # OBBLIGATORIO dalla
 *                                                     # SECONDA corsa in poi: gli
 *                                                     # uuid sono derivati dal
 *                                                     # seed, e la CLI rifiuta un
 *                                                     # `--session-id` già speso
 *                                                     # («already in use», uscita
 *                                                     # 1). Una misura si conferma
 *                                                     # ripetendola: serve un seed
 *                                                     # nuovo ogni volta.
 *
 * ── Riferimento misurato, 10 agosto 2026, CLI 2.1.226, opus-5[1m] ───────────
 *   catalogo intero ....  37.867 token di prefisso    (skill_listing 14.067 B)
 *   soli nomi ..........  33.657 token   (−4.210)     (skill_listing  2.130 B)
 *
 * Il numero assoluto dipende da quante skill ha l'utente e da quali server MCP
 * gli girano: è la DIFFERENZA fra le due righe il dato che conta.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { buildClaudeArgs } from "../server/providers/claude/args";

/** La cwd decide quali skill di PROGETTO entrano nell'elenco: si misura dove si
 *  lavora, non in una cartella vuota. */
const CWD = process.env.PROBE_CWD || process.cwd();
const MODEL = process.env.PROBE_MODEL || "claude-opus-5[1m]";

/** Il bridge Topics col profilo di dispatch: è la superficie che vede un agente
 *  del board. La session-key è finta di proposito — qui non si tocca un topic,
 *  si misura un prefisso. */
function mcpConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-listing-probe-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      topics: {
        command: process.execPath,
        args: [
          "run", join(import.meta.dir, "..", "server", "mcp", "topics-mcp-server.ts"),
          "--base-url=https://127.0.0.1:3333",
          "--session-key=probe:skill-listing",
          "--profile=dispatch",
        ],
      },
    },
  }));
  return path;
}

function transcriptDir(): string {
  // La CLI nomina la cartella con la cwd, ogni `/` e ogni `.` diventano `-`.
  return join(homedir(), ".claude", "projects", CWD.replace(/[/.]/g, "-"));
}

function transcripts(): string[] {
  try { return readdirSync(transcriptDir()).filter((f) => f.endsWith(".jsonl")).map((f) => join(transcriptDir(), f)); }
  catch { return []; }
}

type Reading = { prefix: number | null; listing: number };

/** Una sessione vera, un turno solo, con l'argv del dispatch. */
function probe(label: string, slim: boolean, mcpConfigPath: string, seed: number): Reading | null {
  const args = buildClaudeArgs({
    permissionMode: "bypassPermissions",
    model: MODEL,
    effort: "high",
    mcpConfigPath,
    mcpStrict: true,
    permissionPromptTool: "mcp__topics__approval_prompt",
    appendSystemPrompt: "<probe>",
    claudeSessionId: `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
    isNewSession: true,
    toolSearch: "1",
    slimSkillListing: slim,
  });
  const before = new Set(transcripts());
  // `--input-format stream-json` (lo usa il dispatch) vuole un messaggio JSONL,
  // non testo secco. La domanda non deve chiamare tool: si misura il PREFISSO.
  const input = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "rispondi solo con la parola ok" }] },
  }) + "\n";
  const r = spawnSync("claude", args, { input, cwd: CWD, encoding: "utf-8", timeout: 300_000 });
  if (r.status !== 0) { console.error(`  ${label}: claude è uscito ${r.status} — ${(r.stderr || "").slice(0, 200)}`); return null; }
  const fresh = transcripts().filter((f) => !before.has(f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!fresh[0]) { console.error(`  ${label}: nessun transcript nuovo`); return null; }

  let prefix: number | null = null;
  let listing = 0;
  for (const line of readFileSync(fresh[0], "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, any>;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "attachment" && d.attachment?.type === "skill_listing") listing += JSON.stringify(d.attachment).length;
    if (d.type === "assistant" && prefix === null) {
      const u = d.message?.usage;
      // Il prompt INTERO della prima richiesta: fresco + scritto in cache + letto.
      if (u) prefix = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
  }
  return { prefix, listing };
}

const fmt = (n: number) => n.toLocaleString("it-IT");
const cfg = mcpConfig();
const seed = Number(process.env.PROBE_SEED ?? 700);

console.log(`\nCatalogo delle skill nel prefisso — ${MODEL}, cwd ${CWD}\n`);
const full = probe("catalogo intero", false, cfg, seed);
const slim = probe("soli nomi", true, cfg, seed + 1);
for (const [label, r] of [["catalogo intero", full], ["soli nomi", slim]] as const) {
  if (!r) continue;
  console.log(`  ${label.padEnd(18)} prefisso ${fmt(r.prefix ?? 0).padStart(8)} token   skill_listing ${fmt(r.listing).padStart(7)} B`);
}
if (full?.prefix && slim?.prefix) {
  console.log(`\n  Differenza: ${fmt(full.prefix - slim.prefix)} token di prefisso per OGNI richiesta.\n`);
}
