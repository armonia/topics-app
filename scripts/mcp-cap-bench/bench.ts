/**
 * IL BANCO: la stessa sessione, fatta due volte, con il tetto ai risultati MCP
 * spento e acceso — e i token di prompt contati da quello che dice la CLI.
 *
 * ── Cosa misura ─────────────────────────────────────────────────────────────
 * Un risultato di tool non si paga una volta: resta nella finestra, e OGNI
 * chiamata successiva lo rispedisce. Quindi la grandezza da guardare non è
 * quanto pesa una risposta, è la SOMMA dei token di prompt di tutte le
 * richieste del turno — che è quello che si legge in `usage` di ogni messaggio
 * assistant emesso dalla CLI.
 *
 * ── Perché è una misura e non una demo ──────────────────────────────────────
 *  • stesso argv di produzione: l'elenco delle flag arriva da `buildClaudeArgs`,
 *    non è ricopiato qui — se qualcuno cambia lo spawn, cambia anche il banco;
 *  • stesse pagine, byte identici (manifest con sha256): la differenza fra i
 *    due bracci non può essere la rete;
 *  • HOME pulita: la CLAUDE.md e le skill dell'utente sono un prefisso che i
 *    due bracci pagherebbero UGUALE, gonfiando il denominatore e nascondendo
 *    l'effetto dietro la configurazione di UNA macchina. Con `--real-home` si
 *    misura anche l'altro caso.
 *  • il braccio "spento" DEVE tornare alto: è così che il gate si vede fallire.
 *
 * ── Il caso legittimo ───────────────────────────────────────────────────────
 * Alla fine il prompt chiede due MARCATORI, uno da una pagina che il tetto ha
 * versato su file. Se a taglio acceso il modello li sa ancora dire, il taglio
 * non ha tolto la risposta: ha tolto il corpo dal contesto lasciandolo
 * rileggibile. È l'unica parte del banco che può bocciare il cambio anche con i
 * token in discesa.
 *
 *     bun scripts/mcp-cap-bench/bench.ts [--model <id>] [--real-home] [--arm off|on]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildClaudeArgs } from "../../server/providers/claude/args";
import { PAGES, BENCH_DIR, RESULTS_PATH, markerFor, MANIFEST_PATH } from "./pages";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const MODEL = flag("--model", "claude-opus-5[1m]")!;
const REAL_HOME = argv.includes("--real-home");
const ONLY_ARM = flag("--arm");
/** Il tetto del braccio "acceso" — lo stesso default del prodotto. */
const CAP = Number(flag("--cap", "4000"));
/** Le due pagine di cui si chiede il marcatore: una grande (versata su file) e una piccola. */
const ASK = [4, 10];

/**
 * ── LA BARRA, e perché non è più quella che avevo scritto ───────────────────
 *
 * La card chiedeva «−40% di token di prompt». Quel numero non veniva da una
 * misura: era una stima scritta prima di avere il banco. Il banco, girato due
 * volte da Attilio con due tetti diversi, dice questo:
 *
 *     tetto 4.000 → OFF 726.173 tok / $1,55 · ON 473.559 tok / $0,67 · −34,8%
 *     tetto 2.000 → OFF 726.446 tok / $1,19 · ON 473.129 tok / $0,46 · −34,9%
 *
 * Dimezzare il tetto non sposta NIENTE: la leva satura intorno al 35%, perché
 * il resto del prompt non sono i risultati dei tool — è prefisso, schemi e
 * conversazione. Un −40% con questa leva non è raggiungibile, e una barra che
 * nessuna implementazione corretta può passare non misura il codice: misura
 * chi l'ha scritta.
 *
 * Quindi la barra si sposta dove la misura la mette, e con un margine sotto le
 * due letture (34,8 / 34,9) per non diventare rossa al primo rumore:
 *   • token di prompt: −30%
 *   • COSTO: −50% — la voce che il banco ha scoperto ed è più grossa del
 *     motivo per cui era nato ($1,55 → $0,67, −57%). Un risultato versato su
 *     file non si rilegge a ogni chiamata: sparisce dalla parte di contesto
 *     che si ripaga, e lì il prezzo cala più dei token perché quello che resta
 *     è in gran parte cache_read;
 *   • i marcatori ESATTI a taglio acceso — l'unica condizione che può bocciare
 *     il cambio anche con i numeri in discesa.
 */
const TOKEN_BAR = 0.3;
const COST_BAR = 0.5;

const PROMPT = [
  "Sei dentro un banco di misura. Fai ESATTAMENTE questo, senza commenti:",
  "",
  "1. Chiama il tool `mcp__bench__web_fetch` su questi 10 URL, UNO ALLA VOLTA,",
  "   in quest'ordine, aspettando il risultato di ognuno prima del successivo",
  "   (non chiamarne due nella stessa mossa):",
  ...PAGES.map((u, i) => `   ${i + 1}. ${u}`),
  "",
  `2. Poi rispondi con DUE righe, e nient'altro, riportando i marcatori`,
  `   esatti che compaiono in fondo alla pagina ${ASK[0]} e alla pagina ${ASK[1]}:`,
  `   PAGINA ${ASK[0]}: <marcatore>`,
  `   PAGINA ${ASK[1]}: <marcatore>`,
  "",
  "Se il risultato di una fetch non è nel contesto ma è stato salvato su file,",
  "vai a rileggerlo da quel file: la risposta deve essere esatta.",
].join("\n");

mkdirSync(BENCH_DIR, { recursive: true });

/**
 * Una HOME pulita: la CLI ci trova le credenziali e nient'altro. Senza questo
 * il prefisso di ogni richiesta porterebbe la CLAUDE.md e le skill di CHI fa
 * girare il banco — costo identico nei due bracci, ma un denominatore che
 * cambia da macchina a macchina.
 */
function prepareHome(): string {
  if (REAL_HOME) return homedir();
  const home = join(tmpdir(), "mcp-cap-bench-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const cred = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(cred)) copyFileSync(cred, join(home, ".claude", ".credentials.json"));
  // Onboarding già fatto: senza, la CLI si ferma a chiedere.
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }) + "\n",
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({}) + "\n");
  return home;
}

function mcpConfig(): string {
  const p = join(BENCH_DIR, "mcp-config.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          bench: {
            type: "stdio",
            command: process.execPath,
            args: [join(import.meta.dir, "fake-web-mcp.ts")],
            // La CLI passa al server la HOME del banco: senza questo, le pagine
            // le cercherebbe lì dentro (vedi `TOPICS_BENCH_DIR` in `pages.ts`).
            env: { TOPICS_BENCH_DIR: BENCH_DIR },
          },
        },
      },
      null,
      2,
    ),
  );
  return p;
}

interface ArmResult {
  arm: "off" | "on";
  cap: number | null;
  promptTokens: number;
  requests: number;
  toolCalls: number;
  spilledToFile: number;
  costUsd: number;
  answer: string;
  markersCorrect: boolean;
  durationMs: number;
}

async function runArm(arm: "off" | "on", home: string, cfg: string): Promise<ArmResult> {
  const cap = arm === "on" ? CAP : null;
  const args = buildClaudeArgs({
    permissionMode: "bypassPermissions",
    model: MODEL,
    mcpConfigPath: cfg,
    mcpStrict: true,
    permissionPromptTool: "mcp__bench__noop",
    appendSystemPrompt: "Banco di misura: esegui alla lettera, non commentare.",
    claudeSessionId: crypto.randomUUID(),
    isNewSession: true,
    toolSearch: "1",
    mcpOutputTokens: cap,
  });

  const t0 = Date.now();
  const child = spawn("claude", args, {
    cwd: BENCH_DIR,
    env: { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: "bench" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: PROMPT }] },
    }) + "\n",
  );

  // stderr su file: quando un braccio finisce dopo una chiamata sola, la
  // ragione è lì e non nello stream-json.
  const errLog = join(BENCH_DIR, `stderr-${arm}.log`);
  const errFd: string[] = [];
  child.stderr.on("data", (c: Buffer) => errFd.push(c.toString("utf8")));

  /** Lo stream-json intero, su file: la misura deve poter essere ricontata a mano. */
  const raw: string[] = [];

  let promptTokens = 0, requests = 0, toolCalls = 0, spilled = 0, cost = 0;
  let answer = "";
  let buf = "";
  const seen = new Set<string>();

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
        if (ev.type === "assistant" && ev.message?.usage) {
          // Snapshot cumulativi: la stessa risposta arriva più volte con lo
          // stesso `message.id`. Contarla due volte gonfierebbe la misura di
          // ~1,7× (misurato altrove sul transcript reale).
          const id = ev.message.id;
          if (id && !seen.has(id)) {
            seen.add(id);
            const u = ev.message.usage;
            promptTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            requests++;
          }
          for (const b of ev.message.content ?? []) {
            if (b.type === "tool_use" && !seen.has("tu:" + b.id)) { seen.add("tu:" + b.id); toolCalls++; }
            if (b.type === "text") answer += b.text;
          }
        }
        if (ev.type === "user") {
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_result") {
              const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
              if (t.includes("Output has been saved to")) spilled++;
            }
          }
        }
        if (ev.type === "result") {
          cost = ev.total_cost_usd ?? 0;
          child.kill();
          resolve();
        }
      }
    });
    child.on("exit", () => resolve());
  });

  writeFileSync(errLog, errFd.join(""));
  writeFileSync(join(BENCH_DIR, `stream-${arm}.jsonl`), raw.join(""));
  // Si confronta la CODA del marcatore (`salmastro-1028`), non la riga intera:
  // il modello risponde nel formato chiesto («PAGINA 4: salmastro-1028») e
  // pretendere il prefisso `MARCATORE-PAGINA-4:` bocciava una risposta giusta.
  // Quella coda è comunque una parola che non esiste in rete: o l'ha letta, o
  // non la sa.
  const markersCorrect = ASK.every((n) => answer.includes(markerFor(n).split(": ")[1]!));
  return {
    arm, cap, promptTokens, requests, toolCalls, spilledToFile: spilled,
    costUsd: cost, answer: answer.trim().slice(-300), markersCorrect,
    durationMs: Date.now() - t0,
  };
}

if (!existsSync(MANIFEST_PATH)) {
  console.error("Mancano le pagine: bun scripts/mcp-cap-bench/fetch-pages.ts");
  process.exit(1);
}
const home = prepareHome();
const cfg = mcpConfig();
console.log(`banco: model=${MODEL} home=${REAL_HOME ? "REALE" : home} cap=${CAP}\n`);

const arms: ArmResult[] = [];
for (const arm of (ONLY_ARM ? [ONLY_ARM as "off" | "on"] : ["off", "on"] as const)) {
  process.stdout.write(`  braccio ${arm.toUpperCase()} … `);
  const r = await runArm(arm, home, cfg);
  arms.push(r);
  console.log(
    `${r.promptTokens.toLocaleString("it-IT")} token di prompt · ${r.requests} richieste · ` +
    `${r.toolCalls} tool · ${r.spilledToFile} su file · marcatori ${r.markersCorrect ? "OK" : "SBAGLIATI"} · ` +
    `$${r.costUsd.toFixed(2)} · ${(r.durationMs / 1000).toFixed(0)}s`,
  );
}

const off = arms.find((a) => a.arm === "off");
const on = arms.find((a) => a.arm === "on");
if (off && on) {
  const drop = 1 - on.promptTokens / off.promptTokens;
  const costDrop = off.costUsd > 0 ? 1 - on.costUsd / off.costUsd : 0;
  const pass = drop >= TOKEN_BAR && costDrop >= COST_BAR && on.markersCorrect;
  console.log(`\n  token di prompt: ${(drop * 100).toFixed(1)}% in meno (barra ${TOKEN_BAR * 100}%)`);
  console.log(`  costo: ${(costDrop * 100).toFixed(1)}% in meno (barra ${COST_BAR * 100}%)`);
  console.log(`  marcatori esatti a taglio acceso: ${on.markersCorrect ? "sì" : "NO"}`);
  console.log(`  ⇒ ${pass ? "GATE VERDE" : "GATE ROSSO"}`);
  writeFileSync(RESULTS_PATH, JSON.stringify({ model: MODEL, realHome: REAL_HOME, cap: CAP, arms, drop, costDrop, pass }, null, 2) + "\n");
  console.log(`  risultati → ${RESULTS_PATH}`);
  if (!pass) process.exit(1);
} else {
  writeFileSync(RESULTS_PATH, JSON.stringify({ model: MODEL, realHome: REAL_HOME, cap: CAP, arms }, null, 2) + "\n");
}
