/**
 * LA SCALA: di cosa sono fatti i 32k di prefisso, misurati UNO ALLA VOLTA.
 *
 * ── Perché serve, dopo la sonda ─────────────────────────────────────────────
 * `prefix-probe.ts` dice quanto pesa il prefisso INTERO (32.052 token a HOME
 * pulita, 34.696 a HOME reale) e quanto vale il differimento degli schemi
 * (−21.405, −40%). Non dice cosa siano i 32k che restano — e finché non lo si
 * sa, ogni taglio è un'ipotesi.
 *
 * Il prefisso non si legge: non è nel transcript e la CLI non lo stampa. Si
 * misura per DIFFERENZA. Ogni voce si toglie da sola, con lo stesso identico
 * contorno, e il delta è il suo peso.
 *
 * ── Le due trappole, e come sono chiuse ─────────────────────────────────────
 *  1. Il registro dei tool NON è stabile fra processi (misurato: 30 vs 35 tool
 *     fra due sonde di fila, ~5.400 token di scarto). Confrontare due misure
 *     prese a momenti diversi misura quella deriva. Qui ogni scalino porta il
 *     suo `toolsAtBoot`, e il rapporto DICHIARA la differenza rispetto alla
 *     base: se un rung che non doveva toccare il registro lo ha toccato, la
 *     riga è marcata NON APPAIATA e il suo delta non vale.
 *  2. La deriva nel tempo (versione della CLI, cache, macchina). La base si
 *     rimisura all'INIZIO e alla FINE della scala: lo scarto fra le due è il
 *     rumore di fondo, e un delta più piccolo di quello non è un risultato.
 *
 * ── Cosa NON misura ─────────────────────────────────────────────────────────
 * La capacità. Un taglio che leva 4.000 token e rende l'agente incapace di
 * fare una cosa non ha risparmiato niente: ha spostato il costo sui turni
 * sprecati. Ogni scalino porta scritto cosa TOGLIE (`costa`), e la verifica
 * sta nel banco (`bench.ts`), non qui.
 *
 *     bun scripts/mcp-cap-bench/prefix-ladder.ts [--model <id>] [--clean-home]
 *                                                [--only <id,id>] [--repeat 1]
 *
 * Di default gira a HOME REALE, perché è lì che vive il prefisso di
 * produzione: CLAUDE.md dell'utente, catalogo delle skill, elenco degli
 * agenti. A HOME pulita quelle voci valgono zero e la scala misura un mondo
 * che nessun agente abita.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, rmSync } from "node:fs";
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
const CLEAN_HOME = argv.includes("--clean-home");
const ONLY = (flag("--only") ?? "").split(",").filter(Boolean);
const REPEAT = Number(flag("--repeat", "1"));

/** Il prompt di sistema che Topics appende davvero a un agente del board. */
const TOPICS_APPEND =
  "Sei un agent che lavora UN SOLO task di un board Kanban, nella working directory corrente, " +
  "fino allo stato `review`. Comunicazione minima: brevi commenti di stato ai milestone. " +
  "Non puoi portare il task a `done` (serve l'ok umano).";

/** Un prompt che non chiama tool: quel che resta È il prefisso. */
const MINIMO = "Rispondi con una sola parola: ok";

/**
 * Una HOME che è la HOME vera MENO qualcosa.
 *
 * Ogni voce di `~/.claude` diventa un symlink, tranne quelle in `omit`. È
 * l'unico modo di togliere UNA voce (CLAUDE.md, le skill) lasciando tutto il
 * resto identico — credenziali comprese, senza le quali la CLI non parte.
 */
function mirrorHome(tag: string, omit: string[]): string {
  const home = join(tmpdir(), `prefix-ladder-${tag}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const real = homedir();
  for (const entry of readdirSync(join(real, ".claude"))) {
    if (omit.includes(entry)) continue;
    try { symlinkSync(join(real, ".claude", entry), join(home, ".claude", entry)); } catch {}
  }
  for (const entry of [".claude.json"]) {
    try { symlinkSync(join(real, entry), join(home, entry)); } catch {}
  }
  return home;
}

/** La HOME sterile del banco: nessuna skill, nessun CLAUDE.md, nessun agente. */
function cleanHome(): string {
  const home = join(tmpdir(), "mcp-cap-bench-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const cred = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(cred)) {
    try { symlinkSync(cred, join(home, ".claude", ".credentials.json")); } catch {}
  }
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }) + "\n",
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({}) + "\n");
  return home;
}

interface Rung {
  id: string;
  /** La voce del prefisso che questo scalino toglie. */
  voce: string;
  /** Cosa l'agente NON sa più fare dopo il taglio. Vuoto = niente. */
  costa: string;
  /** Argomenti in coda all'argv di produzione (variadici compresi: lo stdin regge il prompt). */
  extra?: string[];
  /** Override dei parametri di `buildClaudeArgs`. */
  over?: Record<string, unknown>;
  /** Voci di `~/.claude` da NON montare nella HOME di questo scalino. */
  omitHome?: string[];
  /** Vero se lo scalino cambia il registro dei tool APPOSTA (il gate non deve lamentarsi). */
  cambiaRegistro?: boolean;
}

/**
 * I tool che un agente del board usa davvero, misurati sui suoi turni: leggere,
 * scrivere, cercare, lanciare comandi, chiamare i tool MCP di Topics. Tutto il
 * resto (Cron*, Task*, LSP, Monitor, DesignSync, RemoteTrigger, PushNotification,
 * Artifact, EnterWorktree/ExitWorktree, EnterPlanMode/ExitPlanMode, SendMessage,
 * Workflow) è già differito o non lo tocca mai.
 */
const TOOL_ESSENZIALI = [
  "Bash", "Read", "Edit", "Write", "Skill", "ToolSearch", "Task", "AskUserQuestion",
];

const RUNGS: Rung[] = [
  {
    id: "base",
    voce: "— la misura di riferimento (argv di produzione)",
    costa: "",
  },
  {
    id: "skill-slim",
    voce: "descrizioni del catalogo skill (skillListingMaxDescChars: 1)",
    costa: "il modello vede i NOMI delle skill ma non cosa fanno: le sceglie peggio quando nessuno gliele nomina",
    over: { slimSkillListing: true },
  },
  {
    id: "skill-off",
    voce: "catalogo skill INTERO (--disable-slash-commands)",
    costa: "nessuna skill è invocabile — /commit, /spec, le skill Jarvis: sparite",
    extra: ["--disable-slash-commands"],
    cambiaRegistro: true,
  },
  {
    id: "agents-off",
    voce: "elenco degli agenti disponibili (--agents '{}')",
    costa: "il modello non sa che esistono gli agent type custom; il tool Agent resta ma spara al buio",
    extra: ["--agents", "{}"],
  },
  {
    id: "claudemd-off",
    voce: "CLAUDE.md dell'utente (~/.claude/CLAUDE.md)",
    costa: "identità, lingua, regole globali, mappa dei tool: l'agente torna generico",
    omitHome: ["CLAUDE.md"],
  },
  {
    id: "append-off",
    voce: "prompt di sistema che Topics appende",
    costa: "l'agente non sa di lavorare un task del board né dove si ferma",
    over: { appendSystemPrompt: "" },
  },
  {
    id: "tools-min",
    voce: "schemi dei tool integrati NON differiti, oltre gli essenziali",
    costa: "restano solo " + TOOL_ESSENZIALI.join(", ") + " più i tool MCP: niente Workflow, niente Cron, niente Artifact",
    extra: ["--tools", ...TOOL_ESSENZIALI],
    cambiaRegistro: true,
  },
  {
    id: "workflow-off",
    voce: "schema del solo tool Workflow (la descrizione più lunga del registro)",
    costa: "niente orchestrazione multi-agente deterministica (un agente del board non la usa mai)",
    extra: ["--disallowed-tools", "Workflow"],
    cambiaRegistro: true,
  },
  // I tool integrati che il differimento NON tocca (restano con lo schema intero
  // in testa a ogni richiesta), pesati uno per uno. `--disallowed-tools` toglie
  // il tool SENZA toccare gli altri né i tool MCP — che è la differenza con
  // `--tools`, il quale è una allowlist e si porta via anche `mcp__*`.
  {
    id: "artifact-off",
    voce: "schema del solo tool Artifact",
    costa: "niente artefatti/documenti generati: un agente del board consegna file e commenti",
    extra: ["--disallowed-tools", "Artifact"],
    cambiaRegistro: true,
  },
  {
    id: "findings-off",
    voce: "schema del solo tool ReportFindings",
    costa: "la code review non può più riportare i findings in forma tipizzata (torna a testo)",
    extra: ["--disallowed-tools", "ReportFindings"],
    cambiaRegistro: true,
  },
  {
    id: "listagents-off",
    voce: "schema del solo tool ListAgents",
    costa: "niente elenco degli agenti raggiungibili con SendMessage",
    extra: ["--disallowed-tools", "ListAgents"],
    cambiaRegistro: true,
  },
  {
    id: "task-off",
    voce: "schema del solo tool Task (sotto-agenti)",
    costa: "niente sotto-agenti — un agente del board li usa per le ricerche larghe",
    extra: ["--disallowed-tools", "Task"],
    cambiaRegistro: true,
  },
  {
    id: "taglio-proposto",
    voce: "IL TAGLIO PROPOSTO: Workflow + Artifact + ReportFindings + ListAgents, catalogo skill ai soli nomi",
    costa: "niente orchestrazione multi-agente, niente artefatti, findings a testo, niente elenco agenti — nessuno dei quattro compare nei turni di un agente del board",
    extra: ["--disallowed-tools", "Workflow", "Artifact", "ReportFindings", "ListAgents"],
    over: { slimSkillListing: true },
    cambiaRegistro: true,
  },
  {
    // Stesso taglio, ma in UN argomento separato da virgole invece che
    // variadico. È la forma che va in produzione — un variadico in mezzo
    // all'argv si mangia la flag dopo — e va verificata, non supposta: una
    // deny ignorata in silenzio darebbe un risparmio di zero travestito da
    // configurazione corretta. Deve dare lo stesso numero di `taglio-proposto`.
    // I QUATTRO SCHEMI DA SOLI, senza toccare il catalogo delle skill — che in
    // produzione è già slim per gli agenti del board. È il «dopo» rispetto al
    // «prima» VERO, ed è il numero che il banco usa come previsione: prenderlo
    // dal taglio combinato la renderebbe circolare.
    id: "tool-trim",
    voce: "i quattro schemi inline da soli, catalogo skill invariato",
    costa: "niente orchestrazione multi-agente, niente artefatti, findings a testo, niente elenco agenti",
    extra: ["--disallowed-tools", "Workflow,Artifact,ReportFindings,ListAgents"],
    cambiaRegistro: true,
  },
  {
    id: "taglio-virgola",
    voce: "IL TAGLIO PROPOSTO, forma a virgole (quella che va in produzione)",
    costa: "identico a taglio-proposto",
    extra: ["--disallowed-tools", "Workflow,Artifact,ReportFindings,ListAgents"],
    over: { slimSkillListing: true },
    cambiaRegistro: true,
  },
  {
    id: "dyn-excl",
    voce: "sezioni per-macchina SPOSTATE dal system prompt al primo messaggio (--exclude-dynamic-system-prompt-sections)",
    costa: "niente — è uno spostamento, e la scala serve a dire se sposta anche i token o solo la cache",
    extra: ["--exclude-dynamic-system-prompt-sections"],
  },
  {
    id: "pavimento",
    voce: "TUTTO insieme — quel che resta è il prompt di sistema della CLI",
    costa: "somma di tutti i costi qui sopra",
    extra: ["--disable-slash-commands", "--agents", "{}", "--tools", ...TOOL_ESSENZIALI],
    over: { appendSystemPrompt: "" },
    omitHome: ["CLAUDE.md"],
    cambiaRegistro: true,
  },
];

interface Misura {
  id: string;
  prefix: number;
  toolCount: number;
  tools: string[];
  attachments: { type: string; chars: number }[];
  /** Indice della corsa: la base si rimisura in testa e in coda. */
  giro: number;
}

async function misura(rung: Rung, giro: number, cfg: string): Promise<Misura> {
  const home = CLEAN_HOME
    ? cleanHome()
    : rung.omitHome?.length
      ? mirrorHome(rung.id, rung.omitHome)
      : mirrorHome("base", []);

  const args = [
    ...buildClaudeArgs({
      permissionMode: "bypassPermissions",
      model: MODEL,
      mcpConfigPath: cfg,
      mcpStrict: true,
      permissionPromptTool: "mcp__bench__noop",
      appendSystemPrompt: TOPICS_APPEND,
      claudeSessionId: crypto.randomUUID(),
      isNewSession: true,
      toolSearch: "1",
      mcpOutputTokens: null,
      ...(rung.over ?? {}),
    } as Parameters<typeof buildClaudeArgs>[0]),
    ...(rung.extra ?? []),
  ];

  const child = spawn("claude", args, {
    cwd: BENCH_DIR,
    env: { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: "bench" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: MINIMO }] } }) + "\n",
  );

  let prefix = 0, tools: string[] = [], buf = "", err = "";
  const raw: string[] = [];
  child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
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
        // `message_delta` è l'unico usage DEFINITIVO: gli eventi `assistant`
        // portano snapshot a metà generazione.
        if (ev.type === "stream_event" && ev.event?.type === "message_delta" && !prefix) {
          const u = ev.event.usage ?? {};
          prefix = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        if (ev.type === "system" && ev.subtype === "init") tools = (ev.tools ?? []) as string[];
        if (ev.type === "result") { child.kill(); resolve(); }
      }
    });
    child.on("exit", () => resolve());
  });
  mkdirSync(join(BENCH_DIR, "ladder"), { recursive: true });
  writeFileSync(join(BENCH_DIR, "ladder", `${rung.id}-${giro}.jsonl`), raw.join(""));
  if (!prefix) writeFileSync(join(BENCH_DIR, "ladder", `${rung.id}-${giro}.stderr.log`), err);

  return { id: rung.id, prefix, toolCount: tools.length, tools, attachments: attachmentsOf(home), giro };
}

/**
 * Gli `attachment` che la CLI registra nel proprio transcript: elenco skill,
 * elenco agenti, tool differiti. Non sono tutto il prefisso — il prompt di
 * sistema non è lì — ma sono la parte che dipende dalla MACCHINA, e servono a
 * controllare che l'ablazione abbia davvero morso.
 */
function attachmentsOf(home: string): { type: string; chars: number }[] {
  const dir = join(home, ".claude", "projects", BENCH_DIR.replace(/[/.]/g, "-"));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (!files.length) return [];
  const newest = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f;
  const out: { type: string; chars: number }[] = [];
  for (const line of readFileSync(join(dir, newest), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "attachment" && e.attachment) out.push({ type: e.attachment.type, chars: JSON.stringify(e.attachment).length });
  }
  return out;
}

// ── la corsa ────────────────────────────────────────────────────────────────
const cfg = join(BENCH_DIR, "mcp-config.json");
if (!existsSync(cfg)) { console.error("Manca mcp-config.json: gira prima il banco."); process.exit(1); }
mkdirSync(BENCH_DIR, { recursive: true });

const scelti = RUNGS.filter((r) => !ONLY.length || ONLY.includes(r.id) || r.id === "base");
console.log(`scala: model=${MODEL} home=${CLEAN_HOME ? "PULITA" : "REALE"} rung=${scelti.length} giri=${REPEAT}\n`);

const misure: Misura[] = [];
for (let giro = 1; giro <= REPEAT; giro++) {
  for (const r of scelti) {
    const m = await misura(r, giro, cfg);
    misure.push(m);
    console.log(`  ${r.id.padEnd(14)} ${m.prefix.toLocaleString("it-IT").padStart(8)} token · ${m.toolCount} tool`);
  }
  // La base si rimisura in coda: lo scarto fra le due è il rumore di fondo.
  const coda = await misura(RUNGS[0]!, giro + 100, cfg);
  misure.push(coda);
  console.log(`  ${"base (coda)".padEnd(14)} ${coda.prefix.toLocaleString("it-IT").padStart(8)} token · ${coda.toolCount} tool`);
}

const basi = misure.filter((m) => m.id === "base" && m.prefix > 0);
const base = basi.length ? Math.round(basi.reduce((s, m) => s + m.prefix, 0) / basi.length) : 0;
const rumore = basi.length > 1 ? Math.max(...basi.map((m) => m.prefix)) - Math.min(...basi.map((m) => m.prefix)) : 0;
const baseTools = new Set(basi[0]?.tools ?? []);

console.log(`\n  BASE ${base.toLocaleString("it-IT")} token · rumore di fondo fra le corse della base: ${rumore} token\n`);
console.log("  voce                                                        risparmio   %   registro");
const righe: any[] = [];
for (const r of scelti) {
  if (r.id === "base") continue;
  const mine = misure.filter((m) => m.id === r.id && m.prefix > 0);
  if (!mine.length) { console.log(`  ${r.id.padEnd(14)} MISURA FALLITA (vedi ladder/${r.id}-*.stderr.log)`); continue; }
  const val = Math.round(mine.reduce((s, m) => s + m.prefix, 0) / mine.length);
  const saved = base - val;
  const tools = new Set(mine[0]!.tools);
  const spariti = [...baseTools].filter((t) => !tools.has(t));
  const nuovi = [...tools].filter((t) => !baseTools.has(t));
  const mosso = spariti.length + nuovi.length;
  const appaiata = r.cambiaRegistro ? `atteso (−${spariti.length})` : mosso === 0 ? "identico" : `⚠ NON APPAIATA (${mosso} tool)`;
  const sotto = Math.abs(saved) <= rumore ? "  ≤ rumore" : "";
  console.log(
    `  ${r.voce.slice(0, 58).padEnd(58)} ${saved.toLocaleString("it-IT").padStart(8)} ${((saved / base) * 100).toFixed(1).padStart(5)}%  ${appaiata}${sotto}`,
  );
  righe.push({ id: r.id, voce: r.voce, costa: r.costa, prefix: val, saved, pct: (saved / base) * 100, spariti, nuovi, appaiata, sottoRumore: Math.abs(saved) <= rumore, attachments: mine[0]!.attachments });
}

const dove = join(BENCH_DIR, CLEAN_HOME ? "ladder-clean.json" : "ladder.json");
writeFileSync(dove, JSON.stringify({ model: MODEL, cleanHome: CLEAN_HOME, base, rumore, righe, misure }, null, 2) + "\n");
console.log(`\n  risultati → ${dove}`);
