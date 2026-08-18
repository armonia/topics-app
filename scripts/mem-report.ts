#!/usr/bin/env bun
/**
 * DOVE STANNO I MEGABYTE DI TOPICS, riga per riga.
 *
 * PERCHE' ESISTE. La status bar mostra due numeri — il dispositivo e il server —
 * e quando uno dei due sembra alto non c'e' modo di chiedergli "di cosa sei
 * fatto". Io stesso, davanti a "450 MB" riportati dall'utente, ne misuravo 65
 * con `ps` e ho finito per CHIEDERE invece di guardare: `ps` conta il processo
 * dell'app e non i WKWebView, che macOS attribuisce all'app senza renderli suoi
 * figli. Il numero giusto era gia' nel prodotto (`desktop-tauri/src-tauri`), solo
 * che si poteva leggere unicamente dalla UI.
 *
 * COME FA A VEDERE I WEBVIEW, che e' la parte non ovvia. Un processo di contenuto
 * WKWebView e' figlio di `launchd`, non dell'app: nessuna camminata sui ppid lo
 * trovera' mai. macOS pero' tiene un'altra relazione, la RESPONSABILITA', ed e'
 * quella che usa Monitoraggio Attivita' per raggruppare le righe sotto un'app.
 * Si legge con `responsibility_get_pid_responsible_for_pid`, in libsystem. Qui
 * la si chiama via FFI, esattamente come fa il guscio Tauri
 * (`scan_responsible_pids` in `lib.rs`).
 *
 * E LA METRICA E' `phys_footprint`, non RSS: e' la colonna "Memoria" di
 * Monitoraggio Attivita', e include cio' che il sistema ha compresso o mandato in
 * swap. Quella memoria e' ancora dell'app, e riportarla dentro e' precisamente
 * cio' che fa scattare la UI. Un confronto fatto con RSS su una macchina che
 * comprime 9 GB non descrive niente.
 *
 * USAGE
 *   bun run scripts/mem-report.ts                  tutto: app, server, agenti
 *   bun run scripts/mem-report.ts --json
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawnSync } from "child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const JSON_OUT = process.argv.includes("--json");

const libc = dlopen("libSystem.B.dylib", {
  responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

/** `(phys_footprint, resident)` in byte. Gli indici sono quelli di `lib.rs`. */
function procMemory(pid: number): { footprint: number; resident: number } | null {
  const buf = new BigUint64Array(64);
  const rc = libc.symbols.proc_pid_rusage(pid, 2, ptr(buf));
  if (rc !== 0) return null;
  return { footprint: Number(buf[9]), resident: Number(buf[8]) };
}

/** Tutti i pid della macchina. */
function allPids(): number[] {
  const needed = libc.symbols.proc_listpids(1, 0, null, 0);
  if (needed <= 0) return [];
  const cap = Math.floor(needed / 4) + 64;
  const buf = new Int32Array(cap);
  const written = libc.symbols.proc_listpids(1, 0, ptr(buf), cap * 4);
  if (written <= 0) return [];
  return [...buf.slice(0, Math.floor(written / 4))].filter((p) => p > 0);
}

/** I pid di cui `owner` e' RESPONSABILE secondo macOS, `owner` incluso. */
function responsiblePids(owner: number): number[] {
  const out = [owner];
  for (const pid of allPids()) {
    if (pid === owner) continue;
    try {
      if (libc.symbols.responsibility_get_pid_responsible_for_pid(pid) === owner) out.push(pid);
    } catch { /* pid morto fra la lista e la domanda */ }
  }
  return out;
}

function sh(cmd: string): string {
  return spawnSync("/bin/bash", ["-lc", cmd], { encoding: "utf-8" }).stdout?.trim() ?? "";
}

/** Batch comm lookup: una sola chiamata ps per tutti i pid. */
function commBatch(pids: number[]): Map<number, string> {
  if (pids.length === 0) return new Map();
  const out = spawnSync("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], { encoding: "utf-8" }).stdout ?? "";
  const m = new Map<number, string>();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const pid = Number(parts[0]);
      const name = parts.slice(1).join(" ").split("/").pop() ?? "?";
      if (pid > 0) m.set(pid, name);
    }
  }
  return m;
}

const MB = (b: number) => b / 1024 / 1024;

interface Row { pid: number; name: string; footprintMB: number; residentMB: number }

function rowsFor(pids: number[]): Row[] {
  const out: Row[] = [];
  const names = commBatch(pids);
  for (const pid of pids) {
    const m = procMemory(pid);
    if (!m) continue;
    out.push({ pid, name: names.get(pid) ?? "?", footprintMB: MB(m.footprint), residentMB: MB(m.resident) });
  }
  return out.sort((a, b) => b.footprintMB - a.footprintMB);
}

const total = (rows: Row[]) => rows.reduce((s, r) => s + r.footprintMB, 0);

// ── Il DISPOSITIVO: l'app desktop e tutto cio' di cui macOS la ritiene responsabile.
const appPid = Number(sh(`pgrep -f 'Topics.app/Contents/MacOS/app' | head -1`) || 0);
const appRows = appPid ? rowsFor(responsiblePids(appPid)) : [];

/**
 * Il SERVER e i suoi sidecar. Non sono figli dell'app: la barra li conta a
 * parte, e questo e' il loro conto.
 *
 * NON basta cercare `pty-bridge` fra i processi, ed e' il secondo difetto che
 * questo strumento ha avuto. I sidecar sono spawnati DETACHED: sopravvivono al
 * server che li ha creati e restano reparentati a pid 1. Su questa macchina ne
 * ho trovati di orfani vecchi di un giorno, appartenenti a server morti — piu'
 * un `fswatch` di un altro repo — e il totale usciva 252 MB contro i 154 che
 * l'API riporta. Un numero che non coincide con quello della barra non serve a
 * spiegarla: serve solo a litigarci.
 *
 * Si chiede quindi al SERVER, che e' l'unico a sapere quali sidecar sono suoi
 * (li riconosce dal path del socket, unico per istanza: vedi `fleet-usage.ts`).
 * Se non risponde si ripiega sulla scansione, dicendo che e' una stima.
 */
interface ScriptEntry {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: string;
  pid: number | null;
  startedAt: string;
  source: string;
  ports: number[];
}

interface ServerSideResult {
  rows: Row[];
  fromApi: boolean;
  apiTotalMB?: number;
  scripts: ScriptEntry[];
  baseUrl: string;
}

async function serverSide(): Promise<ServerSideResult> {
  const ports = process.env.TOPICS_STATUS_PORT
    ? [Number(process.env.TOPICS_STATUS_PORT)]
    : [3333, Number(process.env.PORT) || 0].filter(Boolean);
  for (const port of ports) {
    try {
      const base = `https://127.0.0.1:${port}`;
      const fetchOpts = { ...({ tls: { rejectUnauthorized: false } } as unknown as RequestInit), signal: AbortSignal.timeout(3000) };

      const [statusRes, scriptsRes] = await Promise.all([
        fetch(`${base}/api/system/status`, fetchOpts),
        fetch(`${base}/api/scripts`, fetchOpts),
      ]);

      const body = (await statusRes.json()) as any;
      const fleet = body?.server?.fleet;
      if (!fleet?.roots) continue;

      const pids = fleet.roots.map((r: any) => r.pid as number);
      const all = new Set<number>(pids);
      for (const p of pids) {
        for (const kid of sh(`pgrep -P ${p} 2>/dev/null`).split("\n").filter(Boolean)) all.add(Number(kid));
      }

      let scripts: ScriptEntry[] = [];
      if (scriptsRes.ok) {
        const sb = (await scriptsRes.json()) as any;
        scripts = (sb?.scripts ?? []).filter((s: ScriptEntry) => s.source === "script" && s.status === "running");
      }

      return { rows: rowsFor([...all]), fromApi: true, apiTotalMB: fleet.memoryMB, scripts, baseUrl: base };
    } catch { /* server non in ascolto su questa porta */ }
  }
  const scanned = sh(`pgrep -f 'topics-app/server.ts'`).split("\n").filter(Boolean).map(Number);
  const bridges = sh(`pgrep -f 'server/pty-bridge.mjs|ai-bridge'`).split("\n").filter(Boolean).map(Number);
  return { rows: rowsFor([...new Set([...scanned, ...bridges])]), fromApi: false, scripts: [], baseUrl: "" };
}

const server = await serverSide();
const serverRows = server.rows;

/**
 * Gli AGENTI, e solo quelli.
 *
 * La prima versione cercava `claude|codex|jcode` nella riga di comando e
 * pescava 988 MB di roba che non e' di Topics: i server MCP personali di Jarvis
 * vivono sotto `~/.claude/jarvis/`, sono `node` e `python`, e stavano li' da tre
 * giorni. Attribuirli a Topics era il modo perfetto per andare a caccia del
 * grasso nel posto sbagliato — cioe' esattamente cio' che questo strumento deve
 * impedire.
 *
 * Una CLI agente di Topics si riconosce per come Topics la lancia:
 * `--output-format stream-json` (claude-code), `codex ... --json`, o
 * `jcode acp`. Nessun percorso sotto `jarvis/` o `mcp-servers/`, che sono
 * strumenti dell'utente e non sessioni della board.
 */
const agentPattern = "claude.*--output-format|codex.*--json|jcode acp";
const cliPids = sh(`pgrep -f '${agentPattern}'`).split("\n").filter(Boolean).map(Number)
  .filter((pid) => {
    const cmd = sh(`ps -o command= -p ${pid} 2>/dev/null`);
    return !/jarvis|mcp-servers/.test(cmd);
  });
const cliRows = rowsFor([...new Set(cliPids)]);

// ── SCRIPT avviati da Topics (source:"script") ─────────────────────────────
const topicsScripts = server.scripts;

// ── PROCESSI non Topics: dev server avviati dall'utente ───────────────────
/**
 * Questi processi NON sono di Topics e NON vanno toccati. Sono elencati
 * perche' il modo in cui si sbaglia qui e' uccidere roba altrui: un dev server
 * avviato dall'utente dentro un worktree sembra "Topics" se si guarda la cwd,
 * ma appartiene all'utente, non a Topics.
 *
 * La stima e' conservativa: si cerca dev server comuni (node, bun, vite, webpack,
 * esbuild, next, nuxt) che hanno una porta aperta ma non sono fra i pid gia'
 * attribuiti a Topics.
 */
const topicsPids = new Set([
  appPid,
  ...appRows.map((r) => r.pid),
  ...serverRows.map((r) => r.pid),
  ...cliRows.map((r) => r.pid),
]);

// Una sola chiamata lsof per pid+porta di tutti i processi in ascolto TCP
const lsofTcpOut = spawnSync("/bin/bash", ["-lc", "lsof -i TCP -sTCP:LISTEN -nP -Fpn 2>/dev/null"], { encoding: "utf-8" }).stdout ?? "";
const pidToFirstPort = new Map<number, number>();
let curPid = 0;
for (const line of lsofTcpOut.split("\n")) {
  if (line.startsWith("p")) { curPid = Number(line.slice(1)); }
  else if (line.startsWith("n") && curPid > 0 && !pidToFirstPort.has(curPid)) {
    const port = Number(line.split(":").pop() ?? "0");
    if (port > 0) pidToFirstPort.set(curPid, port);
  }
}

const listeningPids = [...pidToFirstPort.keys()];

// Una sola chiamata ps per comm+command di tutti i pid in ascolto
const psOut = listeningPids.length > 0
  ? spawnSync("ps", ["-o", "pid=,comm=,command=", "-p", listeningPids.join(",")], { encoding: "utf-8" }).stdout ?? ""
  : "";

interface PsInfo { comm: string; command: string }
const psInfo = new Map<number, PsInfo>();
for (const line of psOut.split("\n")) {
  const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
  if (m) psInfo.set(Number(m[1]), { comm: m[2].split("/").pop() ?? m[2], command: m[3] });
}

// Una sola chiamata lsof per le cwd di tutti i pid candidati
const candidatePids = listeningPids.filter((pid) => {
  if (topicsPids.has(pid)) return false;
  const info = psInfo.get(pid);
  if (!info) return false;
  if (/^[A-Z]/.test(info.comm) && !/^Python/.test(info.comm)) return false;
  return /bun|node|vite|esbuild|webpack|next|nuxt|deno|python|ruby|php|cargo|workerd/.test(info.command);
});

const lsofCwdOut = candidatePids.length > 0
  ? spawnSync("/bin/bash", ["-lc", `lsof -a -d cwd -p ${candidatePids.join(",")} -Fpn 2>/dev/null`], { encoding: "utf-8" }).stdout ?? ""
  : "";

const pidToCwd = new Map<number, string>();
let cwdPid = 0;
for (const line of lsofCwdOut.split("\n")) {
  if (line.startsWith("p")) cwdPid = Number(line.slice(1));
  else if (line.startsWith("n") && cwdPid > 0 && !pidToCwd.has(cwdPid)) pidToCwd.set(cwdPid, line.slice(1));
}

interface ExtRow extends Row { port?: number; cwd?: string; isTopics: boolean }
const externalRows: ExtRow[] = [];

for (const pid of candidatePids) {
  const m = procMemory(pid);
  if (!m) continue;
  const info = psInfo.get(pid);
  externalRows.push({
    pid,
    name: info?.comm ?? "?",
    footprintMB: MB(m.footprint),
    residentMB: MB(m.resident),
    port: pidToFirstPort.get(pid),
    cwd: pidToCwd.get(pid),
    isTopics: false,
  });
}
externalRows.sort((a, b) => b.footprintMB - a.footprintMB);

// ── DISCO ──────────────────────────────────────────────────────────────────
function duMB(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const out = spawnSync("du", ["-sk", path], { encoding: "utf-8" }).stdout ?? "";
    return parseInt(out.split(/\s+/)[0] ?? "0", 10) / 1024;
  } catch { return 0; }
}

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// APP_DATA_DIR: dove vive il DB (default: ~/Projects/topics-app/data)
// Cerchiamo sia il path canonico che quello da env
const dataDir = (() => {
  // Il server gira da /Users/.../topics-app, quindi data/ e' relativa al repo
  const candidates = [
    join(homedir(), "Projects", "topics-app", "data"),
    join(homedir(), ".openclaw"),
    process.env.APP_DATA_DIR ?? "",
    process.env.OPENCLAW_DIR ?? "",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, "topics.db"))) ?? candidates[0];
})();

const dbPath = join(dataDir, "topics.db");
const dbMB = duMB(dbPath);

// Backup pre-migration: tutte le directory/file che sembrano backup nella data dir
interface BackupEntry { path: string; mb: number; mtime: Date }
const backupEntries: BackupEntry[] = [];
if (existsSync(dataDir)) {
  for (const entry of readdirSync(dataDir)) {
    const p = join(dataDir, entry);
    if (/bak|backup|\.bak/.test(entry)) {
      const mb = duMB(p);
      const mtime = (() => { try { return statSync(p).mtime; } catch { return new Date(0); } })();
      if (mb > 0) backupEntries.push({ path: p, mb, mtime });
    }
  }
}
// Anche la sottocartella backups/
const backupsDir = join(dataDir, "backups");
if (existsSync(backupsDir)) {
  const mb = duMB(backupsDir);
  if (mb > 0 && !backupEntries.some((e) => e.path === backupsDir)) {
    backupEntries.push({ path: backupsDir, mb, mtime: (() => { try { return statSync(backupsDir).mtime; } catch { return new Date(0); } })() });
  }
}
backupEntries.sort((a, b) => b.mb - a.mb);

const totalBackupMB = backupEntries.reduce((s, e) => s + e.mb, 0);

// Log del server
const serverLogPath = join(homedir(), ".claude", "jarvis", "logs", "topics-server.log");
const serverErrLogPath = join(homedir(), ".claude", "jarvis", "logs", "topics-server-error.log");
const serverLogMB = duMB(serverLogPath);
const serverErrLogMB = duMB(serverErrLogPath);

// Verifica se esiste rotazione del log
const logsDir = join(homedir(), ".claude", "jarvis", "logs");
const hasLogRotation = existsSync(logsDir) && readdirSync(logsDir).some((f) => /topics-server.*\.(1|2|3|gz|old|storico)/.test(f));

// ─────────────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({
    metric: "phys_footprint (la colonna Memoria di Monitoraggio Attivita')",
    device: { pid: appPid, totalMB: Math.round(total(appRows)), processes: appRows.length, rows: appRows },
    server: { totalMB: Math.round(total(serverRows)), processes: serverRows.length, rows: serverRows, apiTotalMB: server.apiTotalMB },
    agents: { totalMB: Math.round(total(cliRows)), processes: cliRows.length, rows: cliRows },
    scripts: topicsScripts.map((s) => ({ name: s.scriptName, pid: s.pid, ports: s.ports, cwd: s.projectPath, ageMin: Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000) })),
    external: externalRows.map((r) => ({ pid: r.pid, name: r.name, footprintMB: Math.round(r.footprintMB), port: r.port, cwd: r.cwd, note: "NON NOSTRO" })),
    disk: {
      dbPath, dbMB: Math.round(dbMB),
      backups: backupEntries.map((e) => ({ path: e.path, mb: Math.round(e.mb), mtime: e.mtime.toISOString() })),
      totalBackupMB: Math.round(totalBackupMB),
      serverLogMB: Math.round(serverLogMB),
      serverErrLogMB: Math.round(serverErrLogMB),
      logRotation: hasLogRotation,
    },
  }, null, 2));
} else {
  const section = (label: string, rows: Row[]) => {
    console.log(`\n${label}  —  ${total(rows).toFixed(0)} MB in ${rows.length} processi`);
    for (const r of rows.slice(0, 12)) {
      const compressa = r.footprintMB - r.residentMB;
      console.log(
        `  ${r.footprintMB.toFixed(0).padStart(6)} MB  ${r.name.slice(0, 34).padEnd(34)} pid ${r.pid}` +
        (compressa > 20 ? `   (${compressa.toFixed(0)} MB compressi/swap)` : ""),
      );
    }
    if (rows.length > 12) console.log(`  ... e altri ${rows.length - 12}`);
  };

  console.log("\nMemoria di Topics — metrica: phys_footprint (come Monitoraggio Attivita')");
  section("DISPOSITIVO (app + i suoi WebView)", appRows);
  section(`SERVER (Bun + sidecar)${server.fromApi ? "" : " [stima: server non raggiungibile]"}`, serverRows);
  if (server.fromApi && server.apiTotalMB != null) {
    const mio = Math.round(total(serverRows));
    if (Math.abs(mio - server.apiTotalMB) > 20) {
      console.log(`  ! il server ne dichiara ${server.apiTotalMB} MB: differenza di ${Math.abs(mio - server.apiTotalMB)} MB da capire`);
    }
  }
  section("AGENTI (CLI vive)", cliRows);

  // Script avviati da Topics
  if (topicsScripts.length > 0) {
    console.log(`\nSCRIPT avviati da Topics  —  ${topicsScripts.length} in esecuzione`);
    for (const s of topicsScripts) {
      const ageMin = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
      const portStr = s.ports.length > 0 ? `  porta ${s.ports.join(",")}` : "";
      const cwdShort = s.projectPath.replace(homedir(), "~").slice(-60);
      console.log(`  pid ${(s.pid ?? "?").toString().padEnd(6)}  ${s.scriptName.padEnd(16)}  eta' ${ageMin}m${portStr}   cwd ${cwdShort}`);
    }
  } else {
    console.log("\nSCRIPT avviati da Topics  —  nessuno in esecuzione");
  }

  // Processi non Topics
  console.log(`\nNON NOSTRO — dev server dell'utente (elencati, non toccati)  —  ${externalRows.length} trovati`);
  if (externalRows.length === 0) {
    console.log("  nessun dev server esterno rilevato");
  } else {
    const extTotal = externalRows.reduce((s, r) => s + r.footprintMB, 0);
    for (const r of externalRows.slice(0, 15)) {
      const portStr = r.port ? `:${r.port}` : "";
      const cwdShort = (r.cwd ?? "").replace(homedir(), "~").slice(-50);
      console.log(
        `  ${r.footprintMB.toFixed(0).padStart(6)} MB  ${r.name.slice(0, 24).padEnd(24)} pid ${r.pid}${portStr.padEnd(8)}  ${cwdShort}`,
      );
    }
    if (externalRows.length > 15) console.log(`  ... e altri ${externalRows.length - 15}`);
    console.log(`  TOTALE non nostro: ${extTotal.toFixed(0)} MB — non uccidere questi processi`);
  }

  console.log(
    `\nTOTALE Topics su questa macchina: ${(total(appRows) + total(serverRows) + total(cliRows)).toFixed(0)} MB\n`,
  );

  // Disco
  console.log("=== DISCO ===");
  console.log(`  DB vivo:   ${fmtMB(dbMB).padStart(8)}  ${dbPath.replace(homedir(), "~")}`);
  if (backupEntries.length === 0) {
    console.log("  backup:    nessuno trovato");
  } else {
    for (const e of backupEntries) {
      const age = Math.round((Date.now() - e.mtime.getTime()) / (86400 * 1000));
      console.log(`  backup:    ${fmtMB(e.mb).padStart(8)}  ${e.path.replace(homedir(), "~")}  (${age}gg fa)`);
    }
    console.log(`  totale backup:     ${fmtMB(totalBackupMB)}`);
  }
  if (serverLogMB > 0) {
    console.log(`  log server:${fmtMB(serverLogMB).padStart(8)}  ${serverLogPath.replace(homedir(), "~")}`);
  }
  if (serverErrLogMB > 0) {
    console.log(`  log stderr:${fmtMB(serverErrLogMB).padStart(8)}  ${serverErrLogPath.replace(homedir(), "~")}`);
  }
  if (!hasLogRotation && (serverLogMB > 0 || serverErrLogMB > 0)) {
    console.log("  ! nessuna rotazione rilevata per il log del server: cresce senza limite");
  }
  console.log();
}
