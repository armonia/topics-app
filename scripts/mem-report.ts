#!/usr/bin/env bun
/**
 * DOVE STANNO I MEGABYTE DI TOPICS, riga per riga.
 *
 * PERCHÉ ESISTE. La status bar mostra due numeri — il dispositivo e il server —
 * e quando uno dei due sembra alto non c'è modo di chiedergli «di cosa sei
 * fatto». Io stesso, davanti a «450 MB» riportati dall'utente, ne misuravo 65
 * con `ps` e ho finito per CHIEDERE invece di guardare: `ps` conta il processo
 * dell'app e non i WKWebView, che macOS attribuisce all'app senza renderli suoi
 * figli. Il numero giusto era già nel prodotto (`desktop-tauri/src-tauri`), solo
 * che si poteva leggere unicamente dalla UI.
 *
 * COME FA A VEDERE I WEBVIEW, che è la parte non ovvia. Un processo di contenuto
 * WKWebView è figlio di `launchd`, non dell'app: nessuna camminata sui ppid lo
 * troverà mai. macOS però tiene un'altra relazione, la RESPONSABILITÀ, ed è
 * quella che usa Monitoraggio Attività per raggruppare le righe sotto un'app.
 * Si legge con `responsibility_get_pid_responsible_for_pid`, in libsystem. Qui
 * la si chiama via FFI, esattamente come fa il guscio Tauri
 * (`scan_responsible_pids` in `lib.rs`).
 *
 * E LA METRICA È `phys_footprint`, non RSS: è la colonna «Memoria» di
 * Monitoraggio Attività, e include ciò che il sistema ha compresso o mandato in
 * swap. Quella memoria è ancora dell'app, e riportarla dentro è precisamente
 * ciò che fa scattare la UI. Un confronto fatto con RSS su una macchina che
 * comprime 9 GB non descrive niente.
 *
 * USAGE
 *   bun run scripts/mem-report.ts                  tutto: app, server, agenti
 *   bun run scripts/mem-report.ts --json
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawnSync } from "child_process";

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

/** I pid di cui `owner` è RESPONSABILE secondo macOS, `owner` incluso. */
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

function comm(pid: number): string {
  return (sh(`ps -o comm= -p ${pid} 2>/dev/null`) || "?").split("/").pop() ?? "?";
}

const MB = (b: number) => b / 1024 / 1024;

interface Row { pid: number; name: string; footprintMB: number; residentMB: number }

function rowsFor(pids: number[]): Row[] {
  const out: Row[] = [];
  for (const pid of pids) {
    const m = procMemory(pid);
    if (!m) continue;
    out.push({ pid, name: comm(pid), footprintMB: MB(m.footprint), residentMB: MB(m.resident) });
  }
  return out.sort((a, b) => b.footprintMB - a.footprintMB);
}

const total = (rows: Row[]) => rows.reduce((s, r) => s + r.footprintMB, 0);

// ── Il DISPOSITIVO: l'app desktop e tutto ciò di cui macOS la ritiene responsabile.
const appPid = Number(sh(`pgrep -f 'Topics.app/Contents/MacOS/app' | head -1`) || 0);
const appRows = appPid ? rowsFor(responsiblePids(appPid)) : [];

/**
 * Il SERVER e i suoi sidecar. Non sono figli dell'app: la barra li conta a
 * parte, e questo è il loro conto.
 *
 * NON basta cercare `pty-bridge` fra i processi, ed è il secondo difetto che
 * questo strumento ha avuto. I sidecar sono spawnati DETACHED: sopravvivono al
 * server che li ha creati e restano reparentati a pid 1. Su questa macchina ne
 * ho trovati di orfani vecchi di un giorno, appartenenti a server morti — più
 * un `fswatch` di un altro repo — e il totale usciva 252 MB contro i 154 che
 * l'API riporta. Un numero che non coincide con quello della barra non serve a
 * spiegarla: serve solo a litigarci.
 *
 * Si chiede quindi al SERVER, che è l'unico a sapere quali sidecar sono suoi
 * (li riconosce dal path del socket, unico per istanza: vedi `fleet-usage.ts`).
 * Se non risponde si ripiega sulla scansione, dicendo che è una stima.
 */
async function serverSide(): Promise<{ rows: Row[]; fromApi: boolean; apiTotalMB?: number }> {
  const ports = process.env.TOPICS_STATUS_PORT
    ? [Number(process.env.TOPICS_STATUS_PORT)]
    : [3333, Number(process.env.PORT) || 0].filter(Boolean);
  for (const port of ports) {
    try {
      const res = await fetch(`https://127.0.0.1:${port}/api/system/status`, {
        ...({ tls: { rejectUnauthorized: false } } as unknown as RequestInit),
        signal: AbortSignal.timeout(4000),
      });
      const body = (await res.json()) as any;
      const fleet = body?.server?.fleet;
      if (!fleet?.roots) continue;
      const pids = fleet.roots.map((r: any) => r.pid as number);
      // I discendenti contano: un root con `processCount` > 1 tiene sotto di sé
      // le CLI e i server MCP di quella sessione.
      const all = new Set<number>(pids);
      for (const p of pids) {
        for (const kid of sh(`pgrep -P ${p} 2>/dev/null`).split("\n").filter(Boolean)) all.add(Number(kid));
      }
      return { rows: rowsFor([...all]), fromApi: true, apiTotalMB: fleet.memoryMB };
    } catch { /* server non in ascolto su questa porta */ }
  }
  const scanned = sh(`pgrep -f 'topics-app/server.ts'`).split("\n").filter(Boolean).map(Number);
  const bridges = sh(`pgrep -f 'server/pty-bridge.mjs|ai-bridge'`).split("\n").filter(Boolean).map(Number);
  return { rows: rowsFor([...new Set([...scanned, ...bridges])]), fromApi: false };
}

const server = await serverSide();
const serverRows = server.rows;

/**
 * Gli AGENTI, e solo quelli.
 *
 * La prima versione cercava `claude|codex|jcode` nella riga di comando e
 * pescava 988 MB di roba che non è di Topics: i server MCP personali di Jarvis
 * vivono sotto `~/.claude/jarvis/`, sono `node` e `python`, e stavano lì da tre
 * giorni. Attribuirli a Topics era il modo perfetto per andare a caccia del
 * grasso nel posto sbagliato — cioè esattamente ciò che questo strumento deve
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

if (JSON_OUT) {
  console.log(JSON.stringify({
    metric: "phys_footprint (la colonna «Memoria» di Monitoraggio Attività)",
    device: { pid: appPid, totalMB: Math.round(total(appRows)), processes: appRows.length, rows: appRows },
    server: { totalMB: Math.round(total(serverRows)), processes: serverRows.length, rows: serverRows },
    agents: { totalMB: Math.round(total(cliRows)), processes: cliRows.length, rows: cliRows },
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
    if (rows.length > 12) console.log(`  … e altri ${rows.length - 12}`);
  };

  console.log("\nMemoria di Topics — metrica: phys_footprint (come Monitoraggio Attività)");
  section("DISPOSITIVO (app + i suoi WebView)", appRows);
  section(`SERVER (Bun + sidecar)${server.fromApi ? "" : " [stima: server non raggiungibile]"}`, serverRows);
  if (server.fromApi && server.apiTotalMB != null) {
    // Il controllo incrociato: se il mio conto e quello del server divergono,
    // uno dei due sbaglia e va detto invece di scegliere il piu' comodo.
    const mio = Math.round(total(serverRows));
    if (Math.abs(mio - server.apiTotalMB) > 20) {
      console.log(`  ! il server ne dichiara ${server.apiTotalMB} MB: differenza di ${Math.abs(mio - server.apiTotalMB)} MB da capire`);
    }
  }
  section("AGENTI (CLI vive)", cliRows);
  console.log(
    `\nTOTALE Topics su questa macchina: ${(total(appRows) + total(serverRows) + total(cliRows)).toFixed(0)} MB\n`,
  );
}
