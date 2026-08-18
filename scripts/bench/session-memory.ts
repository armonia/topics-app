#!/usr/bin/env bun
/**
 * QUANTO COSTA LA SESSIONE N-esima, in memoria.
 *
 * PERCHÉ ESISTE, e la ragione è un mio errore. In un commit ho scritto «1,8 MB
 * di RSS» per il server che aveva appena servito un turno nativo: era il
 * campione di un processo che stava MORENDO, letto un istante prima che
 * uscisse. Un server Bun vivo ne pesa ~80. Il numero era assurdo e l'ho
 * pubblicato lo stesso, perché l'avevo letto una volta sola e mi piaceva.
 *
 * La grandezza giusta non è comunque il totale del server: è il COSTO
 * MARGINALE della sessione N-esima, che è quello che decide quanti agenti
 * stanno su una macchina prima che cominci a paginare.
 *
 * COME SI MISURA, senza barare. Si apre una sessione per volta sulla rotta
 * vera (`POST /api/chat`), e dopo ognuna si guarda:
 *
 *   • l'RSS del SERVER, che è dove vive una sessione nativa;
 *   • l'RSS dei PROCESSI CLI vivi, che è dove vive una sessione CLI.
 *
 * Sommare solo il server darebbe torto alla CLI in modo grottesco (le sue
 * sessioni non sono lì dentro), e contare solo i processi non vedrebbe affatto
 * quelle native. Le due strade pagano in posti diversi, e il confronto onesto
 * è la somma di ciò che ognuna aggiunge alla MACCHINA.
 *
 * COSTA SOLDI: apre turni veri su entrambe le strade.
 *
 * USAGE
 *   bun run scripts/bench/session-memory.ts --base https://127.0.0.1:39430
 *   bun run scripts/bench/session-memory.ts --base ... --sessions 4
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = flag("base", "https://127.0.0.1:3333")!.replace(/\/$/, "");
const SESSIONS = Number(flag("sessions", "4"));
const MODEL = flag("model", "claude-sonnet-4-6")!;
const tls = { tls: { rejectUnauthorized: false } } as unknown as RequestInit;

function sh(cmd: string): string {
  return spawnSync("/bin/bash", ["-lc", cmd], { encoding: "utf-8" }).stdout?.trim() ?? "";
}

/** L'RSS di un pid, in MB. */
function rssMb(pid: string): number {
  const kb = Number(sh(`ps -o rss= -p ${pid} 2>/dev/null | tr -d ' '`) || 0);
  return kb / 1024;
}

/** La somma degli RSS di tutte le CLI `claude` in modalità stream. */
function cliTotalMb(): { mb: number; count: number } {
  const pids = sh(`pgrep -f 'claude.*--output-format' 2>/dev/null`).split("\n").filter(Boolean);
  let kb = 0;
  for (const p of pids) kb += Number(sh(`ps -o rss= -p ${p} 2>/dev/null | tr -d ' '`) || 0);
  return { mb: kb / 1024, count: pids.length };
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { ...tls, ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

/** Il pid del server che stiamo misurando: lo dice lui stesso. */
async function serverPid(): Promise<string> {
  const s = await api("/api/status");
  const pid = s?.pid ?? s?.server?.pid;
  if (pid) return String(pid);
  // Ripiego: il lock del demone nella casa che quel server usa.
  const p = sh(`lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep ':${new URL(BASE).port}' | awk '{print $2}' | head -1`);
  if (!p) throw new Error("non riesco a identificare il pid del server");
  return p;
}

const pid = await serverPid();
const rows: any[] = [];

console.log(`\nserver ${BASE} (pid ${pid}), ${SESSIONS} sessioni per strada, modello ${MODEL}\n`);

for (const provider of ["topics", "claude-code"]) {
  const label = provider === "topics" ? "native" : "cli";
  const base = { server: rssMb(pid), cli: cliTotalMb() };
  for (let i = 0; i < SESSIONS; i++) {
    const t = await api("/api/topics", { method: "POST", body: JSON.stringify({ name: `mem ${label} ${i} ${Date.now()}` }) });
    await fetch(`${BASE}/api/chat`, {
      ...tls, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: t.sessionKey, provider, model: MODEL, messages: [{ role: "user", content: "Rispondi solo: OK" }], contextMode: "full" }),
    }).then((r) => r.text());
  }
  const after = { server: rssMb(pid), cli: cliTotalMb() };
  // Ciò che questa strada ha aggiunto alla MACCHINA: il server più i processi.
  const added = (after.server - base.server) + (after.cli.mb - base.cli.mb);
  const perSession = added / SESSIONS;
  console.log(
    `${label.padEnd(8)} +${added.toFixed(0).padStart(5)} MB in totale  =  ${perSession.toFixed(1).padStart(6)} MB per sessione` +
    `   (processi CLI vivi: ${base.cli.count} → ${after.cli.count})`,
  );
  rows.push({ label, provider, sessions: SESSIONS, addedMb: added, perSessionMb: perSession, cliProcesses: { before: base.cli.count, after: after.cli.count } });
}

const outPath = join(import.meta.dir, "..", "..", "bench", "results", "session-memory.json");
writeFileSync(outPath, JSON.stringify({
  schema: "bench-session-memory-v1",
  measured_at: new Date().toISOString(),
  base: BASE,
  model: MODEL,
  metric: "RSS del server + RSS di tutte le CLI vive, prima e dopo N sessioni",
  caveats: [
    "RSS e non phys_footprint: `memory.ts` usa il secondo, quindi i totali NON sono confrontabili con quel file. Qui interessa il DELTA, che è la stessa grandezza in entrambe le colonne.",
    "Le due strade pagano in posti diversi: il nativo dentro il server, la CLI in processi separati. Sommare solo uno dei due darebbe torto a una delle due in modo grottesco.",
    "Il turno è banale: si misura il costo RESIDENTE di una sessione, non il picco di lavoro.",
    "Chiama il modello vero su entrambe le strade: questo run è costato soldi.",
  ],
  rows,
}, null, 2));
console.log(`\nscritto ${outPath}\n`);
