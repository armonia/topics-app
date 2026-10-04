// B3 (e E1/E2 della tornata 3c) sul server vivo, in sola lettura: legge il log
// stdout del server di produzione e `pmset -g log`, non scrive niente.
// Uso: bun openspec/changes/mac-usabile-sotto-carico/measurements/b3-measure.ts [log] [--since YYYY-MM-DD]
// Esce 1 se una soglia assoluta di design.md («B3») non regge sulla finestra.
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Soglie misurate sulla finestra 28/09-03/10 (mediana alta dei sei giorni UTC interi).
const O1_STALL_S_PER_DAY = 110;
const O2_SWAPIN_P95 = 1092.0;
const O2_LOAD1_P95 = 81.1;
// O4 resta quella del disegno: è già assoluta.
const O4_MAX_S = 190;

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1]! : "";
const logPath = args.find((a, i) => !a.startsWith("--") && (sinceIdx < 0 || i !== sinceIdx + 1))
  ?? join(homedir(), ".claude/jarvis/logs/topics-server.log");

// Intervalli di sonno della macchina: uno stallo che li tocca è il Mac addormentato, non un blocco.
const pm = Bun.spawnSync(["pmset", "-g", "log"]).stdout.toString();
const sleeps: Array<[number, number]> = [];
let pmsetFrom = Infinity;
let asleepAt: number | null = null;
for (const line of pm.split("\n")) {
  // «Wake Requests» è una richiesta, non un risveglio: l'evento vero ha la colonna allineata con più spazi.
  const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) (Sleep|Wake|DarkWake)(?:\t| {2,})/.exec(line);
  if (!m) continue;
  const t = Date.parse(m[1]!.replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2"));
  pmsetFrom = Math.min(pmsetFrom, t);
  if (m[2] === "Sleep") asleepAt ??= t;
  else if (asleepAt !== null) { sleeps.push([asleepAt, t]); asleepAt = null; }
}

type Memsig = Record<string, string>;
const lagByDay = new Map<string, number[]>();
const memByDay = new Map<string, Memsig[]>();
const memRows: Memsig[] = [];
let sleptStalls = 0;
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  const lag = /^(\d{4}-\d\d-\d\d)(T\S+) \[LAG\] loop stopped (\d+)ms/.exec(line);
  if (lag) {
    const end = Date.parse(lag[1]! + lag[2]!);
    const start = end - Number(lag[3]);
    if (sleeps.some(([a, b]) => a < end && b > start)) { sleptStalls++; continue; }
    (lagByDay.get(lag[1]!) ?? lagByDay.set(lag[1]!, []).get(lag[1]!)!).push(Number(lag[3]) / 1000);
    continue;
  }
  const mem = /^(\d{4}-\d\d-\d\d)T\S+ \[memsig\] (.*)$/.exec(line);
  if (!mem) continue;
  const kv: Memsig = Object.fromEntries(mem[2]!.split(" ").filter((x) => x.includes("=")).map((x) => {
    const i = x.indexOf("=");
    return [x.slice(0, i), x.slice(i + 1)];
  }));
  (memByDay.get(mem[1]!) ?? memByDay.set(mem[1]!, []).get(mem[1]!)!).push(kv);
  memRows.push(kv);
}

const num = (kv: Memsig, k: string): number | null => {
  const v = Number.parseFloat(kv[k] ?? "");
  return Number.isFinite(v) ? v : null;
};
const p95 = (xs: Array<number | null>): number => {
  const s = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! : NaN;
};
const upperMedian = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// Il primo e l'ultimo giorno del log sono parziali: contano solo i giorni UTC interi.
const days = [...new Set([...lagByDay.keys(), ...memByDay.keys()])].sort();
const full = days.slice(1, -1).filter((d) => d >= since);
console.log("day         O1 stall s    n  max s | O2 p95 swapin/s  p95 load1 | sustained min/rows");
const o1: number[] = [], swap: number[] = [], load: number[] = [];
for (const d of days) {
  const lags = lagByDay.get(d) ?? [];
  const rows = memByDay.get(d) ?? [];
  const stall = lags.reduce((a, b) => a + b, 0);
  const sw = p95(rows.map((r) => num(r, "swapin/s")));
  const ld = p95(rows.map((r) => num(r, "load1")));
  const isFull = full.includes(d);
  if (isFull) { o1.push(stall); swap.push(sw); load.push(ld); }
  const sleepNote = Date.parse(d + "T00:00:00Z") < pmsetFrom ? " sleep not verifiable (before pmset log)" : "";
  console.log(`${d} ${stall.toFixed(0).padStart(11)} ${String(lags.length).padStart(4)} ${(lags.length ? Math.max(...lags) : 0).toFixed(1).padStart(6)} |`
    + ` ${sw.toFixed(1).padStart(15)} ${ld.toFixed(1).padStart(10)} | ${rows.filter((r) => r.swap === "sustained").length}/${rows.length}`
    + `${isFull ? "" : " (partial or before --since)"}${sleepNote}`);
}
if (full.length === 0) { console.error("no full UTC day in the window"); process.exit(2); }

// O4: righe [memsig] (una al minuto) consecutive con swap sostenuto e un albero di check >= 1 GB.
let run = 0, best = 0;
for (const r of memRows) {
  run = r.swap === "sustained" && (num(r, "heaviestCheckGB") ?? 0) >= 1 ? run + 1 : 0;
  best = Math.max(best, run);
}
const heaviest = Math.max(0, ...memRows.map((r) => num(r, "heaviestCheckGB") ?? 0));
const checkMinutes = memRows.filter((r) => (num(r, "checkRuns") ?? 0) > 0).length;

const verdicts: Array<[string, number, number]> = [
  ["O1 stall s/day (upper median)", upperMedian(o1), O1_STALL_S_PER_DAY],
  ["O2 p95 swapin/s (upper median)", upperMedian(swap), O2_SWAPIN_P95],
  ["O2 p95 load1 (upper median)", upperMedian(load), O2_LOAD1_P95],
  ["O4 sustained swap with a check tree >= 1 GB, s in a row", best * 60, O4_MAX_S],
];
console.log(`\nfull days ${full[0]}..${full.at(-1)} (${full.length}); stalls dropped as machine sleep: ${sleptStalls}`);
console.log(`O4 context: heaviest check tree ${heaviest.toFixed(1)} GB, minutes with a check run ${checkMinutes}`);
let failed = false;
for (const [name, value, limit] of verdicts) {
  const ok = value <= limit;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${value.toFixed(1)} <= ${limit}`);
}
process.exit(failed ? 1 : 0);
