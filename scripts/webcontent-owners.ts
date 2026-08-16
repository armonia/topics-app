#!/usr/bin/env bun
/**
 * DI CHI SONO I PROCESSI WEBCONTENT DI QUESTA MACCHINA.
 *
 * PERCHE' ESISTE, ed e' una lezione pagata. Il 2026-08-16 una misura frettolosa
 * ha contato «18-20 processi WebContent per 2,2 GB» e li ha attribuiti a
 * Topics, aprendo una card su una perdita del guscio. Erano di Mail.app e di
 * OpenClaw: Topics ne aveva UNO, vivo e legittimo. Anche i due «orfani da tre
 * giorni con ppid=1» erano di Mail.
 *
 * L'ERRORE ERA STRUTTURALE, non di distrazione. Tutti i WebContent del sistema
 * hanno la STESSA riga di comando — l'eseguibile dentro
 * `WebKit.framework/.../com.apple.WebKit.WebContent.xpc` — quindi `ps` non
 * distingue il nostro da quello di Mail, e non c'e' modo di marchiarli come si
 * fa con i Chromium (`--topics-browser=<ruolo>:<pid>`, vedi
 * `server/lib/browser-orphan-sweep.ts`): quella riga di comando non la
 * scriviamo noi.
 *
 * E `ppid == 1` non dice niente, per la stessa ragione gia' scritta nello sweep
 * dei Chromium: su macOS un figlio XPC viene riparentato a launchd mentre il
 * suo padre sta benissimo. Contarli come orfani e' il modo piu' rapido di
 * accusare codice sano.
 *
 * LA DOMANDA GIUSTA LA RISPONDE IL SISTEMA. macOS tiene il «responsible
 * process» di ogni processo — l'applicazione per conto della quale sta
 * girando — e si legge con `responsibility_get_pid_responsible_for_pid` in
 * `libproc`. E' la stessa nozione che usa il pannello Privacy per dire quale
 * app sta usando la fotocamera: non un'euristica, un dato del kernel.
 *
 *   bun run scripts/webcontent-owners.ts           # per applicazione
 *   bun run scripts/webcontent-owners.ts --json    # per un altro programma
 *
 * NON e' un cancello e non deve diventarlo: e' un REFERTO, e sta con
 * `report:*` per la ragione scritta in `check-scripts-are-wired.test.ts` —
 * misura lo stato della MACCHINA, non il codice, quindi il suo rosso non
 * direbbe niente su una modifica.
 */
import { spawnSync } from "node:child_process";
import { dlopen, FFIType, suffix } from "bun:ffi";

export interface ProcRow {
  pid: number;
  rssMB: number;
  /** L'applicazione per conto della quale gira, dal kernel. `null` se illeggibile. */
  owner: string | null;
}

/**
 * Il responsabile di un pid, o `null`.
 *
 * `null` non e' un guasto: un processo puo' sparire fra `ps` e questa chiamata,
 * e su una macchina non-macOS la libreria non c'e' proprio. Chi legge deve
 * trattarlo come «non lo so», mai come «di nessuno» — l'errore opposto
 * ricreerebbe esattamente la falsa attribuzione che questo script esiste per
 * impedire.
 */
export function responsiblePid(pid: number): number | null {
  try {
    const lib = dlopen(`/usr/lib/libproc.${suffix}`, {
      responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const r = lib.symbols.responsibility_get_pid_responsible_for_pid(pid);
    return r > 0 ? r : null;
  } catch {
    return null;
  }
}

/** `/Applications/Mail.app/Contents/MacOS/Mail` → `Mail`. */
export function appName(command: string): string {
  const m = /\/([^/]+)\.app\//.exec(command);
  if (m) return m[1]!;
  return command.split("/").pop() || command;
}

export function webContentProcs(): ProcRow[] {
  const ps = spawnSync("ps", ["-eo", "pid,rss,comm"], { encoding: "utf8" });
  const out: ProcRow[] = [];
  for (const line of (ps.stdout ?? "").split("\n")) {
    if (!line.includes("WebContent")) continue;
    const [pid, rss] = line.trim().split(/\s+/);
    const p = Number(pid);
    if (!Number.isFinite(p)) continue;
    const r = responsiblePid(p);
    const cmd = r
      ? (spawnSync("ps", ["-o", "command=", "-p", String(r)], { encoding: "utf8" }).stdout ?? "").trim()
      : "";
    out.push({ pid: p, rssMB: Number(rss) / 1024, owner: cmd ? appName(cmd) : null });
  }
  return out;
}

/** Somma per applicazione, dalla più pesante. `null` diventa «non attribuibile». */
export function byOwner(rows: readonly ProcRow[]): Array<{ owner: string; procs: number; mb: number }> {
  const m = new Map<string, { procs: number; mb: number }>();
  for (const r of rows) {
    const k = r.owner ?? "non attribuibile";
    const cur = m.get(k) ?? { procs: 0, mb: 0 };
    cur.procs++; cur.mb += r.rssMB;
    m.set(k, cur);
  }
  return [...m.entries()].map(([owner, v]) => ({ owner, ...v })).sort((a, b) => b.mb - a.mb);
}

if (import.meta.main) {
  const rows = webContentProcs();
  const tot = byOwner(rows);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ rows, byOwner: tot }, null, 2));
    process.exit(0);
  }
  console.log(`[webcontent] ${rows.length} processi WebContent, per applicazione responsabile:`);
  for (const t of tot) {
    console.log(`  ${t.mb.toFixed(0).padStart(6)} MB  x${String(t.procs).padStart(2)}  ${t.owner}`);
  }
  const nostri = tot.find((t) => t.owner === "Topics");
  console.log(
    nostri
      ? `\nDi Topics: ${nostri.mb.toFixed(0)} MB su ${nostri.procs} process${nostri.procs === 1 ? "o" : "i"}.`
      : "\nDi Topics: nessuno.",
  );
}
