/**
 * Worktree slimming — la cartella di una card pesa per le DIPENDENZE, non per
 * il repo.
 *
 * Misurato l'11/08 su `~/.topics/worktrees` (25 GB in tutto):
 *
 *     node_modules   9,8 GB   ← ~260 MB per worktree
 *     target (cargo) 3,3 GB
 *     .next          1,5 GB
 *
 * Gli OGGETTI git sono condivisi fra tutti i worktree di un progetto: quella
 * parte è quasi gratis. Il costo è che ogni card si rifà il suo `bun install` e
 * poi ci costruisce sopra. Con N card in parallelo il disco cresce di ~260 MB
 * ciascuna — nella notte fra il 10 e l'11/08 è passato da 30 a 64 GB in poche
 * ore, su una macchina già all'85%.
 *
 * `worktree-gc.ts` ha già la risposta per la cartella INTERA (`free-checkout`:
 * via il checkout, resta il branch). Ma quella risposta vale solo per un task
 * CHIUSO, e la maggior parte dello spazio sta sotto card consegnate che
 * aspettano un umano da giorni. Qui c'è la risposta intermedia: **la cartella
 * resta, gli artefatti rigenerabili no**. Il ramo, i commit, i file tracciati e
 * il lavoro non committato non vengono toccati; chi riapre quella cartella
 * rifà `bun install` dalla cache locale (1,1 GB già sul disco) e riparte.
 *
 * FUORI: un `node_modules` solo, condiviso fra i worktree via symlink. Rami
 * diversi hanno `package.json` diversi e un install condiviso li fa mentire a
 * vicenda. Meglio buttarlo e rifarlo che averne uno solo sbagliato.
 *
 * ── Perché `git status` non può cambiare ──────────────────────────────────
 *
 * DUE cancelli, entrambi obbligatori, entrambi letti da git e non indovinati:
 *
 *  1. il nome della cartella è in una lista chiusa di artefatti notoriamente
 *     rigenerabili (`SLIM_DIR_NAMES`) — mai un nome generico come `data` o
 *     `dist`, che in un progetto qualsiasi può contenere l'unica copia di
 *     qualcosa;
 *  2. `git check-ignore` la dichiara ignorata E `git ls-files` non trova
 *     dentro nessun file tracciato.
 *
 * Il secondo cancello è quello che rende l'invariante VERA e non sperata: un
 * percorso ignorato e senza file tracciati non compare in `git status`, quindi
 * cancellarlo non può sporcare né pulire l'albero. Il primo esiste perché
 * «ignorato» da solo non basta: `.env`, `data/`, le credenziali di un progetto
 * sono ignorate esattamente come le dipendenze, e non si rigenerano.
 */
import { existsSync } from "node:fs";
import { readdir, rm, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Nomi di cartella che sono, per convenzione universale del loro ecosistema,
 * output rigenerabile: dipendenze installate o cache di build.
 *
 * La lista è deliberatamente CHIUSA e fatta di nomi non ambigui. `dist`,
 * `build`, `out`, `coverage` sono fuori apposta: valgono poco (17 MB in tutto
 * sui 25 misurati) e il loro nome non promette niente su cosa contengono.
 * Stessa ragione per `videos`: pesa (3 GB il 16/08) ma il nome non dice di chi
 * e', e una cartella di video puo' benissimo essere l'unica copia di qualcosa.
 */
export const SLIM_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".astro",
  "__pycache__",
  ".pytest_cache",
  // Playwright. Misurato il 16/08 su `~/.topics/worktrees`: 12 GB su 27, quasi
  // tutti sotto quadra, dove la UAT gira con video e trace accesi. Sono i due
  // nomi che Playwright si sceglie da solo e che nessun altro usa per altro —
  // `videos/` resta FUORI apposta, e' un nome che chiunque puo' dare a
  // qualunque cosa e la lista vive di nomi che non promettono altro.
  "test-results",
  "playwright-report",
]);

/**
 * Nomi ambigui che valgono solo con una PROVA dentro la cartella.
 *
 * `target` è la directory di build di cargo — 3,3 GB dei 25 misurati — ma è
 * anche un nome che chiunque può usare per qualsiasi cosa. Cargo ci scrive
 * dentro `CACHEDIR.TAG` (lo standard per «questa è una cache, non backuppare»):
 * senza quel file, `target` non è il target di cargo e non si tocca.
 */
export const SLIM_DIR_MARKERS: ReadonlyMap<string, string> = new Map([
  ["target", "CACHEDIR.TAG"],
]);

/** Quanto in profondità cercare. `desktop-tauri/src-tauri/target` sta a 3. */
const MAX_DEPTH = 5;

/**
 * Nomi da risparmiare, per chi non è d'accordo su uno di loro.
 *
 * Esiste per `target`: 3,3 GB dei 25 misurati, ma ricompilare un progetto Rust
 * costa minuti, mentre un `bun install` da cache locale costa secondi. Chi
 * lavora tutto il giorno sul guscio Tauri può volerlo tenere —
 * `TOPICS_WORKTREE_SLIM_SKIP=target` e resta dov'è.
 */
export function parseSlimSkip(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Primo cancello, puro: questo nome di cartella è un artefatto rigenerabile?
 *
 * `hasMarker` risponde «esiste questo file dentro la cartella?» — iniettata
 * così la regola resta collaudabile senza toccare il disco.
 */
export function isSlimmableDirName(
  name: string,
  hasMarker: (file: string) => boolean,
  skip: ReadonlySet<string> = new Set(),
): boolean {
  if (skip.has(name)) return false;
  if (SLIM_DIR_NAMES.has(name)) return true;
  const marker = SLIM_DIR_MARKERS.get(name);
  return marker ? hasMarker(marker) : false;
}

export type SlimRefusal = "non ignorato da git" | "contiene file tracciati";

export interface SlimVerdict {
  /** Percorsi (relativi alla radice del worktree) che si possono cancellare. */
  purge: string[];
  /** Chi è stato scartato dal secondo cancello, e perché. */
  refused: { relPath: string; reason: SlimRefusal }[];
}

/**
 * Secondo cancello, puro: dei candidati trovati sul disco, quali sopravvivono
 * alla lettura di git.
 *
 * Entrambe le condizioni servono, e i file tracciati si guardano PER PRIMI —
 * non per sicurezza (l'ordine non cambia chi passa) ma per onestà del motivo:
 * `git check-ignore` non dichiara mai ignorato un percorso che l'indice
 * conosce, quindi un `.next` con dentro un file aggiunto a forza cadrebbe sul
 * primo controllo e verrebbe archiviato come «non ignorato», che è vero solo
 * per come git risponde e falso su cosa dice il `.gitignore`. Chi legge il log
 * per capire perché una cartella non si è liberata deve leggere la ragione
 * vera.
 */
export function pickSlimTargets(
  candidates: readonly string[],
  ignored: ReadonlySet<string>,
  trackedUnder: ReadonlySet<string>,
): SlimVerdict {
  const purge: string[] = [];
  const refused: { relPath: string; reason: SlimRefusal }[] = [];
  for (const relPath of candidates) {
    if (trackedUnder.has(relPath)) { refused.push({ relPath, reason: "contiene file tracciati" }); continue; }
    if (!ignored.has(relPath)) { refused.push({ relPath, reason: "non ignorato da git" }); continue; }
    purge.push(relPath);
  }
  return { purge, refused };
}

// ─────────────────────────────────────────────────────────────────────────

async function gitOut(cwd: string, args: string[], stdin?: string): Promise<{ out: string; code: number }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { out, code };
  } catch {
    return { out: "", code: 128 };
  }
}

/** `a/b` sempre, anche su Windows: è la forma che git parla. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Cerca gli artefatti, potando ai match: dentro un `node_modules` non si entra
 * (ci sono decine di migliaia di file e nessun altro candidato che ci
 * interessi), e dentro `.git` nemmeno.
 *
 * I symlink non vengono mai seguiti né rimossi: `readdir(withFileTypes)` marca
 * un link a directory come `isSymbolicLink()`, non come `isDirectory()`, quindi
 * il filtro qui sotto li esclude entrambi i sensi. Un `node_modules` che è un
 * link (workspace pnpm/bun) non costa spazio suo: non è il nostro problema.
 */
async function scanCandidates(root: string, skip: ReadonlySet<string>): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permessi, cartella sparita sotto di noi: non è un motivo per fallire
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git") continue;
      const abs = join(dir, e.name);
      if (isSlimmableDirName(e.name, (marker) => existsSync(join(abs, marker)), skip)) {
        found.push(toPosix(relative(root, abs)));
        continue; // pota: dentro un artefatto non c'è niente da cercare
      }
      if (depth < MAX_DEPTH) await walk(abs, depth + 1);
    }
  }
  await walk(root, 1);
  return found;
}

/**
 * Byte occupati, contati come li conta `du`: blocchi allocati, non dimensione
 * apparente. Su un `node_modules` fatto di decine di migliaia di file minuscoli
 * le due misure differiscono di parecchio, e quella che libera spazio davvero è
 * la prima.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(cur, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      try {
        const st = await lstat(abs);
        total += typeof st.blocks === "number" && st.blocks >= 0 ? st.blocks * 512 : st.size;
      } catch { /* sparito nel frattempo: vale zero */ }
    }
  }
  return total;
}

export interface SlimResult {
  /** Cartelle rimosse, con i byte liberati da ciascuna. */
  removed: { relPath: string; bytes: number }[];
  /** Totale liberato. */
  bytes: number;
  /** Candidati fermati dal cancello di git (non si sono toccati). */
  refused: { relPath: string; reason: SlimRefusal }[];
  /** Rimozioni fallite (permessi, corsa con un altro processo). */
  errors: { relPath: string; message: string }[];
}

const EMPTY: SlimResult = { removed: [], bytes: 0, refused: [], errors: [] };

/**
 * Butta gli artefatti rigenerabili di UN worktree, lasciando in piedi tutto il
 * resto: la cartella, il branch, i commit, i file tracciati, il lavoro non
 * committato.
 *
 * Non decide MAI da sola se è il momento giusto: il chiamante (la consegna di
 * una card, la passata del GC) ha già stabilito che nessun turno sta girando lì
 * dentro e che nessuna anteprima viva ci si appoggia. Qui si guarda solo se è
 * SICURO, mai se è opportuno.
 */
export async function slimWorktree(root: string, skip: ReadonlySet<string> = new Set()): Promise<SlimResult> {
  if (!existsSync(root)) return EMPTY;

  const candidates = await scanCandidates(root, skip);
  if (candidates.length === 0) return EMPTY;

  // Cancello 1 — git dichiara ignorato. `check-ignore` esce 1 quando nessun
  // percorso è ignorato: non è un errore, è la risposta "nessuno".
  const ci = await gitOut(root, ["check-ignore", "-z", "--stdin"], candidates.join("\0"));
  if (ci.code !== 0 && ci.code !== 1) return { ...EMPTY, refused: candidates.map((relPath) => ({ relPath, reason: "non ignorato da git" as const })) };
  const ignored = new Set(ci.out.split("\0").filter(Boolean).map(toPosix));

  // Cancello 2 — nessun file tracciato là sotto. Un `git add -f` dentro un
  // percorso ignorato è raro e legale, ed è l'unico modo in cui cancellare
  // sporcherebbe `git status`.
  const ls = await gitOut(root, ["ls-files", "-z", "--", ...candidates]);
  const trackedFiles = ls.out.split("\0").filter(Boolean).map(toPosix);
  const trackedUnder = new Set(
    candidates.filter((c) => trackedFiles.some((f) => f === c || f.startsWith(`${c}/`))),
  );

  const { purge, refused } = pickSlimTargets(candidates, ignored, trackedUnder);

  const removed: { relPath: string; bytes: number }[] = [];
  const errors: { relPath: string; message: string }[] = [];
  let bytes = 0;
  for (const relPath of purge) {
    const abs = join(root, relPath);
    const size = await directorySizeBytes(abs);
    try {
      await rm(abs, { recursive: true, force: true });
      removed.push({ relPath, bytes: size });
      bytes += size;
    } catch (err) {
      errors.push({ relPath, message: (err as Error)?.message ?? String(err) });
    }
  }
  return { removed, bytes, refused, errors };
}

/** MB con una cifra, per i log e i commenti — `1,4 GB` non serve a nessuno qui. */
export function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
