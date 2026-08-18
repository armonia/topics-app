#!/usr/bin/env bun
/**
 * N AGENTI INSIEME: dove il runtime nativo dovrebbe staccare davvero.
 *
 * PERCHÉ QUESTO E NON `task-dispatch`. Quello misura UN task per volta, e su un
 * task solo il vantaggio è modesto: il tempo lo fa il modello, uguale per
 * entrambe le strade. Il guadagno del runtime nativo non è nel singolo turno, è
 * nel fatto che la sessione N-esima costa 2,3 MB invece di 432 — e una
 * differenza del genere si vede solo quando N cresce.
 *
 * COSA SI MISURA. Si mettono N task in coda insieme su N board, e si cronometra
 * quando l'ULTIMO ha finito. È la domanda della kanban: «ho cinque cose da
 * fare, quando sono pronte?». Non la media dei singoli — quella nasconde
 * esattamente l'effetto che cerchiamo, perché un agente che aspetta uno slot
 * libero ha una media bellissima e una coda lunghissima.
 *
 * IL LIMITE CHE SI CERCA. Con le CLI il tetto di concorrenza e il pavimento di
 * memoria fanno lavorare gli agenti a scaglioni: cinque task non partono
 * insieme, partono a due a due. Col runtime nativo quel vincolo non c'è, e i
 * cinque dovrebbero sovrapporsi. La differenza attesa non è «ogni task è più
 * veloce», è «finiscono tutti prima».
 *
 * COSTA SOLDI: N turni veri per ogni strada.
 *
 * USAGE
 *   bun run scripts/bench/concurrency.ts --base https://127.0.0.1:39460 --tasks 4
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { projectIdForPath as boardId } from "../../shared/board";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = flag("base", "https://127.0.0.1:3333")!.replace(/\/$/, "");
const TASKS = Number(flag("tasks", "4"));
const MODEL = flag("model", "claude-sonnet-4-6")!;
const TIMEOUT_MS = Number(flag("timeout", "300000"));
const tls = { tls: { rejectUnauthorized: false } } as unknown as RequestInit;

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { ...tls, ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

interface Slot { dir: string; board: string; done?: number }

/**
 * N board, una per task: il tetto di concorrenza è per MACCHINA, quindi board
 * separate non lo aggirano — ma tengono i file separati, così «chi ha finito»
 * è una domanda con una risposta per ognuno.
 */
async function prepare(n: number): Promise<Slot[]> {
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const dir = mkdtempSync(join(tmpdir(), `conc-${i}-`));
    spawnSync("/usr/bin/git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "t.txt"), "prima\n");
    const board = boardId(dir);
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `conc${i}`, path: dir }) });
    await api(`/api/boards/${board}/settings`, {
      method: "PATCH",
      body: JSON.stringify({ autoDispatch: true, dispatchUseWorktree: false, dispatchTimeoutMin: 5, dispatchModel: MODEL }),
    });
    out.push({ dir, board });
  }
  return out;
}

async function run(): Promise<{ slots: Slot[]; t0: number; lastMs: number | null }> {
  const slots = await prepare(TASKS);
  const t0 = performance.now();
  // TUTTI INSIEME: è il punto. Crearli in serie darebbe al primo un vantaggio
  // che non ha niente a che vedere con il runtime.
  await Promise.all(slots.map((s) =>
    api(`/api/boards/${s.board}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        text: "Scrivi FATTO in t.txt",
        description: "Nel file t.txt sostituisci il contenuto con la sola parola FATTO. Poi fermati.",
        status: "todo",
      }),
    })));

  while (performance.now() - t0 < TIMEOUT_MS) {
    let allDone = true;
    for (const s of slots) {
      if (s.done) continue;
      const p = join(s.dir, "t.txt");
      if (existsSync(p) && readFileSync(p, "utf-8").trim() === "FATTO") s.done = performance.now() - t0;
      else allDone = false;
    }
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const finiti = slots.filter((s) => s.done).map((s) => s.done!);
  return { slots, t0, lastMs: finiti.length === slots.length ? Math.max(...finiti) : null };
}

console.log(`\nserver ${BASE}, ${TASKS} task in coda INSIEME, modello ${MODEL}\n`);
const { slots, lastMs } = await run();

for (const [i, s] of slots.entries()) {
  console.log(`  task ${i + 1}: ${s.done ? `${(s.done / 1000).toFixed(1)} s` : "NON finito"}`);
}
if (lastMs != null) {
  console.log(`\n  TUTTI PRONTI in ${(lastMs / 1000).toFixed(1)} s`);
} else {
  const ok = slots.filter((s) => s.done).length;
  console.log(`\n  INCOMPLETO: ${ok}/${slots.length} finiti entro ${TIMEOUT_MS / 1000}s`);
}

const outPath = join(import.meta.dir, "..", "..", "bench", "results", "concurrency.json");
writeFileSync(outPath, JSON.stringify({
  schema: "bench-concurrency-v1",
  measured_at: new Date().toISOString(),
  base: BASE, model: MODEL, tasks: TASKS,
  what: "N task messi in coda INSIEME su N board; si cronometra quando l'ULTIMO ha finito. È la domanda della kanban: «ho N cose da fare, quando sono pronte?»",
  perTaskSeconds: slots.map((s) => (s.done ? Number((s.done / 1000).toFixed(1)) : null)),
  allReadySeconds: lastMs != null ? Number((lastMs / 1000).toFixed(1)) : null,
  completed: slots.filter((s) => s.done).length,
  caveats: [
    "NON è la media dei singoli: quella nasconde l'effetto: un agente che aspetta uno slot ha una media bellissima e una coda lunghissima.",
    "Il tempo include la finestra di grace del dispatcher (~6s) e il polling (1s).",
    "Il tetto di concorrenza è per MACCHINA: N board non lo aggirano, servono solo a tenere i file separati.",
    "Chiama il modello vero N volte per strada: questo run è costato soldi.",
  ],
}, null, 2));
console.log(`\nscritto ${outPath}\n`);

for (const s of slots) { try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* scratch */ } }
