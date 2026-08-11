/**
 * LA SONDA: quanto pesa il PREFISSO da solo, e cosa succede al primo tool.
 *
 * Il banco misura la somma dei token di prompt di un turno intero. Dentro quella
 * somma, il primo segmento — il contesto della PRIMA richiesta — è
 * `prefisso + prompt utente` in un blocco solo, e a occhio non si separa: il
 * prefisso non è nel transcript, la CLI non lo stampa.
 *
 * Si separa MISURANDOLO. Stesso argv, stessa HOME, stesso server MCP del banco,
 * ma un prompt di una parola: quel che resta È il prefisso.
 *
 *   sonda A  «ok»                        → contesto = prefisso + ~1 token
 *   sonda B  «ok», ma prima un ToolSearch → il salto dice quanto costa
 *            materializzare lo schema di UN tool differito
 *   sonda C  «ok» con i tool NON differiti (`toolSearch: "0"`)
 *   sonda D  «ok» di nuovo, differiti — appaiata a C
 *
 * La sonda B esiste perché nel braccio OFF il primo salto (richiesta 1 → 2) è di
 * 4.798 token con un `tool_result` da 63 caratteri: o lo schema differito costa
 * quanto una pagina intera, o il conto ha un buco. In entrambi i casi va guardato
 * e non stimato, perché quel segmento lo si rilegge 11 volte.
 *
 * C e D vanno in coppia e in quest'ordine perché il registro dei tool NON è
 * stabile fra un processo e l'altro: fra la sonda A e la B la CLI è passata da 30
 * a 35 tool da sola. Confrontare due prefissi presi a distanza misura quella
 * deriva, non il differimento. Appaiate, la differenza C − D è la leva.
 *
 *     bun scripts/mcp-cap-bench/prefix-probe.ts [--model <id>] [--real-home]
 *
 * ── E poi? ──────────────────────────────────────────────────────────────────
 * Questa sonda dice quanto pesa il prefisso INTERO e quanto vale il
 * differimento degli schemi. NON dice di cosa sia fatto ciò che resta: per
 * quello c'è `prefix-ladder.ts`, che toglie una voce alla volta e misura il
 * delta. La risposta, misurata l'11/08/2026: il pezzo più grosso dei ~35k che
 * restano è la descrizione di UN TOOL — `Workflow`, 7.856 token su opus.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildClaudeArgs } from "../../server/providers/claude/args";
import { BENCH_DIR } from "./pages";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const MODEL = flag("--model", "claude-opus-5[1m]")!;
const REAL_HOME = argv.includes("--real-home");

/** Identica a quella del banco: la sonda deve stare nello stesso mondo. */
function prepareHome(): string {
  if (REAL_HOME) return homedir();
  const home = join(tmpdir(), "mcp-cap-bench-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const cred = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(cred)) copyFileSync(cred, join(home, ".claude", ".credentials.json"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }) + "\n",
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({}) + "\n");
  return home;
}

interface Probe {
  name: string;
  prompt: string;
  /** `"1"` = schemi dei tool differiti (come in produzione), `"0"` = tutti inline. */
  toolSearch: string;
  /** Quanti tool la CLI dichiara nell'evento `init` — il registro non è stabile. */
  toolCount: number;
  /** Contesto di ogni richiesta, in ordine: `input + cache_read + cache_creation`. */
  contexts: number[];
  /** Token di output FINALI per richiesta — dal `message_delta`, non dagli snapshot. */
  outputs: number[];
  /** Cosa la CLI ha appeso al prompt oltre al testo dell'utente. */
  attachments: { type: string; chars: number }[];
}

async function probe(name: string, prompt: string, home: string, cfg: string, toolSearch = "1"): Promise<Probe> {
  const args = buildClaudeArgs({
    permissionMode: "bypassPermissions",
    model: MODEL,
    mcpConfigPath: cfg,
    mcpStrict: true,
    permissionPromptTool: "mcp__bench__noop",
    appendSystemPrompt: "Banco di misura: esegui alla lettera, non commentare.",
    claudeSessionId: crypto.randomUUID(),
    isNewSession: true,
    toolSearch,
    mcpOutputTokens: null,
  });

  const child = spawn("claude", args, {
    cwd: BENCH_DIR,
    env: { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: "bench" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n",
  );

  const contexts: number[] = [];
  const outputs: number[] = [];
  const raw: string[] = [];
  let toolCount = 0;
  let buf = "";
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      raw.push(c.toString("utf8"));
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        // `message_delta` è l'unico posto dove l'usage è DEFINITIVO: gli eventi
        // `assistant` portano snapshot a metà generazione (out=4 su 98).
        if (ev.type === "stream_event" && ev.event?.type === "message_delta") {
          const u = ev.event.usage ?? {};
          contexts.push((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
          outputs.push(u.output_tokens ?? 0);
        }
        if (ev.type === "system" && ev.subtype === "init") toolCount = (ev.tools ?? []).length;
        if (ev.type === "result") { child.kill(); resolve(); }
      }
    });
    child.on("exit", () => resolve());
  });
  writeFileSync(join(BENCH_DIR, `probe-${name}.jsonl`), raw.join(""));
  return { name, prompt, toolSearch, toolCount, contexts, outputs, attachments: [] };
}

/**
 * Di cosa è fatto il prefisso: la CLI registra nel proprio transcript gli
 * `attachment` che appende al primo messaggio (elenco skill, elenco agenti,
 * tool differiti). Non è tutto il prefisso — il prompt di sistema non è lì — ma
 * è la parte che dipende dalla MACCHINA, ed è quella che una HOME pulita
 * dovrebbe aver tolto.
 */
function attachmentsOf(home: string, sessionCwd: string): { type: string; chars: number }[] {
  const dir = join(home, ".claude", "projects", sessionCwd.replace(/[/.]/g, "-"));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (!files.length) return [];
  const newest = files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]!.f;
  const out: { type: string; chars: number }[] = [];
  for (const line of readFileSync(join(dir, newest), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "attachment" && e.attachment) {
      out.push({ type: e.attachment.type, chars: JSON.stringify(e.attachment).length });
    }
  }
  return out;
}

const cfg = join(BENCH_DIR, "mcp-config.json");
if (!existsSync(cfg)) { console.error("Manca mcp-config.json: gira prima il banco."); process.exit(1); }
const home = prepareHome();
mkdirSync(BENCH_DIR, { recursive: true });

console.log(`sonda: model=${MODEL} home=${REAL_HOME ? "REALE" : home}\n`);

const MINIMO = "Rispondi con una sola parola: ok";
const say = (p: Probe, cosa: string) =>
  console.log(
    `  ${p.name} (${cosa}): contesti ${p.contexts.join(", ")} · output ${p.outputs.join(", ")} · ${p.toolCount} tool`,
  );

const A = await probe("A", MINIMO, home, cfg);
A.attachments = attachmentsOf(home, BENCH_DIR);
say(A, "prompt di una riga");
for (const a of A.attachments) console.log(`      allegato ${a.type}: ${a.chars} caratteri`);

const B = await probe(
  "B",
  "Fai ESATTAMENTE questo: 1) chiama il tool `ToolSearch` con query " +
    "`select:mcp__bench__web_fetch`; 2) poi rispondi con una sola parola: ok. " +
    "Non chiamare altri tool.",
  home,
  cfg,
);
B.attachments = attachmentsOf(home, BENCH_DIR);
say(B, "un ToolSearch e basta");

// C e D appaiate, in quest'ordine: fra due processi il registro dei tool si
// muove, e un confronto non appaiato misurerebbe quello.
const C = await probe("C", MINIMO, home, cfg, "0");
say(C, "schemi TUTTI inline");
const D = await probe("D", MINIMO, home, cfg, "1");
say(D, "schemi differiti, appaiata a C");

const prefix = A.contexts[0] ?? 0;
console.log(`\n  PREFISSO (prompt di sistema + schemi + elenchi della macchina) ≈ ${prefix.toLocaleString("it-IT")} token`);
if (B.contexts.length >= 2) {
  const jump = B.contexts[1]! - B.contexts[0]!;
  console.log(
    `  salto al primo ToolSearch: ${jump.toLocaleString("it-IT")} token ` +
      `(di cui ${B.outputs[0]} sono l'output della richiesta 1 riletto)`,
  );
}
const inline = C.contexts[0] ?? 0;
const deferred = D.contexts[0] ?? 0;
if (inline && deferred) {
  const saved = inline - deferred;
  const nota = C.toolCount === D.toolCount ? "" : `  ⚠ registri diversi (${C.toolCount} vs ${D.toolCount}): non appaiate`;
  console.log(
    `  differimento degli schemi: ${inline.toLocaleString("it-IT")} → ${deferred.toLocaleString("it-IT")} token ` +
      `(−${((saved / inline) * 100).toFixed(1)}%, ${saved.toLocaleString("it-IT")} token per OGNI richiesta)${nota}`,
  );
}

// Due file distinti: la misura a HOME pulita è quella che `decompose.ts` usa
// per dividere il primo blocco del banco, e non va sovrascritta da una corsa
// con la HOME vera — che risponde a un'altra domanda (quanto costa il prefisso
// in PRODUZIONE, con CLAUDE.md, skill e server MCP dell'utente).
const dove = join(BENCH_DIR, REAL_HOME ? "probe-results-real.json" : "probe-results.json");
writeFileSync(dove, JSON.stringify({ model: MODEL, realHome: REAL_HOME, prefix, probes: [A, B, C, D] }, null, 2) + "\n");
console.log(`  risultati → ${dove}`);
