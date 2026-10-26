#!/usr/bin/env bun
/**
 * The proof that the tests of the measured card weight and of the cap on agent
 * waits can go red. Same method as `board-doctor.mutants.ts`: switch off ONE
 * guard at a time, i.e. introduce exactly the mistake that guard exists to
 * prevent, and the file's suite has to notice.
 *
 * CAREFUL: it rewrites the listed files while it runs and restores them at the
 * end (on Ctrl-C too). It refuses to start when one of them has uncommitted
 * changes, so a brutal interruption cannot eat any work.
 *
 *   bun scripts/card-weight.mutants.ts
 */
import { spawnSync } from "node:child_process";

const WEIGHT = "server/services/dispatch-card-weight.ts";
const PRICE = "server/services/dispatch-card-price.ts";
const DISPATCHER = "server/services/task-dispatcher.ts";
const TASKS = "server/services/tasks.ts";
const REMOTE = "server/services/task-dispatcher-remote-node.ts";

const WEIGHT_TESTS = ["server/services/dispatch-card-weight.test.ts"];
const PRICE_TESTS = ["server/services/dispatch-card-price.test.ts", "server/services/task-dispatcher-card-price.test.ts"];
const WAIT_TESTS = ["server/services/tasks.test.ts", "server/services/task-dispatcher.test.ts", "server/services/task-dispatcher-remote-node.test.ts"];

/** [name, file, line to switch off, the line that switches it off, tests that must go red]. */
const MUTATIONS: ReadonlyArray<readonly [string, string, string, string, readonly string[]]> = [
  ["peso: non divide la crescita fra i turni in volo", WEIGHT, "const each = Math.max(0, treeGB - base) / turns.length;", "const each = Math.max(0, treeGB - base);", WEIGHT_TESTS],
  ["peso: non sottrae la base", WEIGHT, "const each = Math.max(0, treeGB - base) / turns.length;", "const each = treeGB / turns.length;", WEIGHT_TESTS],
  ["peso: misura senza una base", WEIGHT, "      if (base == null) return;\n", "", WEIGHT_TESTS],
  ["peso: la card tiene l'ultima lettura, non la più alta", WEIGHT, "gb: Math.max(seen?.gb ?? 0, each) });", "gb: each });", WEIGHT_TESTS],
  ["peso: prezza dalla prima card", WEIGHT, "if (recent.length < MEASURED_WEIGHT_MIN_CARDS) return null;", "if (recent.length < 1) return null;", WEIGHT_TESTS],
  ["peso: le card vecchie votano per sempre", WEIGHT, "filter((c) => c.at >= since);", "filter(() => true);", WEIGHT_TESTS],
  ["peso: nessun pavimento sotto la misura", WEIGHT, "Math.max(MEASURED_WEIGHT_FLOOR_GB, median(weights))", "median(weights)", WEIGHT_TESTS],
  ["peso: ignora il picco dei check", WEIGHT, "return Math.max(c.gb, checks != null && Number.isFinite(checks) ? checks : 0);", "return c.gb;", WEIGHT_TESTS],
  ["prezzo: la card pesante legge la misura", PRICE, "if (dispatchWeight !== \"heavy\" && projectId) {", "if (projectId) {", PRICE_TESTS],
  ["prezzo: la misura non entra nel prezzo", PRICE, "if (measured != null && Number.isFinite(measured) && measured > 0) return measured;", "if (false) return measured;", PRICE_TESTS],
  ["dispatcher: il turno finito non vota", DISPATCHER, "    inFlight.delete(taskId);\n    cardWeights.finish(taskId);\n", "    inFlight.delete(taskId);\n", PRICE_TESTS],
  ["dispatcher: solo la board leggera richiede col suo prezzo", DISPATCHER, "if (cardPrices.priceFor(projectId, t.dispatchWeight) >= agentMemPrice()) return false;", "if (cardPrices.weightFor(projectId, t.dispatchWeight) !== \"light\") return false;", PRICE_TESTS],
  ["rimandi: l'agente torna al tetto largo", TASKS, "const tetto = source === \"machine\" ? WAIT_STREAK_CAP : AGENT_WAIT_STREAK_CAP;", "const tetto = WAIT_STREAK_CAP;", WAIT_TESTS],
  ["rimandi: anche la macchina si ferma al secondo", TASKS, "const tetto = source === \"machine\" ? WAIT_STREAK_CAP : AGENT_WAIT_STREAK_CAP;", "const tetto = AGENT_WAIT_STREAK_CAP;", WAIT_TESTS],
  ["rimandi: il nodo muto rimanda come un agente", REMOTE, "host.deferWait(task.id, why, NODE_RETRY_MINUTES, \"machine\");", "host.deferWait(task.id, why, NODE_RETRY_MINUTES);", WAIT_TESTS],
];

const files = [...new Set(MUTATIONS.map(([, file]) => file))];
const dirty = spawnSync("git", ["status", "--porcelain", "--", ...files], { encoding: "utf8" }).stdout ?? "";
if (dirty.trim()) {
  console.error(`file con modifiche non committate, committale prima: questo script li riscrive.\n${dirty}`);
  process.exit(2);
}

const originals = new Map<string, string>();
for (const f of files) originals.set(f, await Bun.file(f).text());
const restore = () => Promise.all(files.map((f) => Bun.write(f, originals.get(f)!)));
process.on("SIGINT", () => { void restore().then(() => process.exit(130)); });

let escaped = 0;
try {
  for (const [name, file, from, to, tests] of MUTATIONS) {
    const original = originals.get(file)!;
    if (original.split(from).length !== 2) {
      console.log(`  NON TROVATA  ${name} — la riga è cambiata (o non è unica), la mutazione va riscritta`);
      escaped++;
      continue;
    }
    await Bun.write(file, original.replace(from, to));
    const run = spawnSync("bun", ["test", ...tests], { encoding: "utf8" });
    await Bun.write(file, original);
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const fails = Number(out.match(/(\d+) fail/)?.[1] ?? "-1");
    if (fails <= 0) escaped++;
    console.log(`  ${fails > 0 ? `rosso (${fails})`.padEnd(12) : "SFUGGITA    "} ${name}`);
  }
} finally {
  await restore();
}

console.log(escaped === 0
  ? `\n${MUTATIONS.length}/${MUTATIONS.length} mutazioni beccate: i test sanno diventare rossi.`
  : `\n${escaped} mutazioni su ${MUTATIONS.length} sono passate indenni: i test non reggono.`);
process.exit(escaped === 0 ? 0 : 1);
