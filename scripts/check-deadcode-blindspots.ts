#!/usr/bin/env bun
/**
 * scripts/check-deadcode-blindspots.ts — il cancello sul codice morto vede DAVVERO
 * ogni file, o ce n'è qualcuno dove un export morto è invisibile per costruzione?
 *
 * `bun run check:deadcode` (knip) dice «0 export morti». Non dice su QUANTI file
 * l'ha guardato. La differenza non è teorica: su `client/src/lib/api.ts` — 1451
 * righe, ~60 export, la superficie HTTP di tutto il client — knip non ha mai
 * segnalato niente perché non poteva. Un solo call site altrove:
 *
 *     import('../../lib/api').then(({ filesApi }) => …)   // CommandPalette.tsx
 *
 * Un `import()` dinamico il cui risultato NON viene destrutturato in una
 * dichiarazione di variabile è OPACO per knip (`IMPORT_FLAGS.OPAQUE`,
 * typescript/visitors/imports.js:260): non sa quali membri leggerai, quindi per
 * non mentire assume che li usi TUTTI. In `graph-explorer/operations/
 * is-referenced.js:50`, `file.import.get(OPAQUE)` rende «referenziato» qualunque
 * identificatore di quel modulo. Un import opaco basta a rendere cieco l'intero
 * file, per sempre, senza una riga di config e senza un avviso.
 *
 * La forma che knip capisce è la stessa cosa scritta con l'`await`:
 *
 *     const { filesApi } = await import('../../lib/api');   // vede `filesApi`
 *
 * (`imports.js:19-33`: ObjectPattern su ImportExpression → un import per nome).
 * `lazy(() => import('./Pane'))` invece è già gestito a parte (LOADER): acceca
 * solo i moduli SENZA export default, perché lì knip non sa cosa carica il
 * loader.
 *
 * COSA FA QUESTO CHECK. Appende una riga-sonda — un export morto per
 * costruzione — a ogni file di progetto NON entrypoint, lancia knip UNA volta,
 * e pretende che ogni sonda risulti nel report. Le sonde che non tornano sono i
 * punti ciechi: lì il cancello è verde perché non guarda, non perché è pulito.
 * I file restano modificati per il tempo di una run e vengono ripristinati in
 * `finally` (più handler su SIGINT/SIGTERM): se una run muore ammazzata,
 * `--restore` ripulisce le sonde rimaste, e all'avvio il check si rifiuta di
 * partire se ne trova.
 *
 * Uso:
 *   bun run scripts/check-deadcode-blindspots.ts            # esce 1 sui ciechi
 *   bun run scripts/check-deadcode-blindspots.ts --list     # solo la conta, esce 0
 *   bun run scripts/check-deadcode-blindspots.ts --restore  # ripara una run morta
 *
 * Costa una run di knip (~1 min): sta in CI accanto a `check:deadcode`, non nel
 * loop di sviluppo.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

/** Il marcatore sta NELLA riga: chi lo trova committato sa che è spazzatura di una run morta. */
export const PROBE_MARKER = "KNIP-BLINDSPOT-PROBE";
export const PROBE_NAME = "__knipBlindspotProbe";
const PROBE_LINE = `export const ${PROBE_NAME} = 1; // ${PROBE_MARKER} — sonda temporanea, se la vedi committata cancellala`;

// ─── knip.jsonc → i due insiemi di glob ──────────────────────────────────────

/**
 * `knip.jsonc` è commentato riga per riga (è anche la mappa di cosa entra nel
 * grafo), e `JSON.parse` non digerisce i commenti. Toglierli con una regex
 * sbaglia sulle stringhe: `"https://unpkg.com/knip@6/schema.json"` contiene
 * `//`. Questo è lo stesso lavoro fatto a stati, che dentro una stringa non
 * tocca niente.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // Le virgole finali sono legali in jsonc e non in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface WorkspaceGlobs {
  /** Prefisso del workspace rispetto alla radice (`""` per `.`, `"client"` per `client`). */
  dir: string;
  entry: string[];
  project: string[];
  ignore: string[];
}

export function readKnipWorkspaces(knipJsonc: string): WorkspaceGlobs[] {
  const cfg = JSON.parse(stripJsonComments(knipJsonc)) as {
    workspaces: Record<string, { entry?: string[]; project?: string[]; ignore?: string[] }>;
  };
  return Object.entries(cfg.workspaces).map(([name, ws]) => ({
    dir: name === "." ? "" : name,
    // Il `!` in coda dice «questo È un entrypoint anche se non lo importa
    // nessuno»: è un modificatore di knip, non parte del glob.
    entry: (ws.entry ?? []).map((p) => p.replace(/!$/, "")),
    project: ws.project ?? [],
    ignore: ws.ignore ?? [],
  }));
}

const matches = (patterns: string[], rel: string): boolean =>
  patterns.some((p) => new Bun.Glob(p).match(rel));

/**
 * Gli entrypoint NON sono solo quelli scritti in `knip.jsonc`: knip legge anche
 * gli `scripts` dei package.json e tratta come ingresso ogni file citato in un
 * comando (`"gen:shortcuts": "bun run scripts/gen-shortcuts.ts"`). Senza questo
 * pezzo, sei script perfettamente cablati risultavano «ciechi» — e sarebbe stato
 * un falso allarme: lì il cancello non guarda per contratto, come su `server.ts`.
 */
export function entriesFromPackageScripts(manifest: string, dir: string): string[] {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch { return []; }
  const out = new Set<string>();
  for (const cmd of Object.values(scripts)) {
    for (const token of cmd.split(/[\s'"]+/)) {
      const bare = token.replace(/^\.\//, "");
      if (!/\.(ts|tsx|mjs|cjs|js)$/.test(bare)) continue;
      out.add(dir ? `${dir}/${bare}` : bare);
    }
  }
  return [...out];
}

// ─── il debito già misurato ──────────────────────────────────────────────────

/**
 * I file su cui il cancello resta cieco OGGI, uno per uno e col motivo. Non è
 * un'amnistia a tappeto: è una lista che può solo ACCORCIARSI — se un file qui
 * dentro torna visibile il check fallisce chiedendo di toglierlo, e ogni file
 * cieco che non è qui dentro è una regressione.
 */
export const KNOWN_BLIND: Array<{ file: string; reason: string }> = [
  // `lazy(() => import('./X').then(m => ({ default: m.X })))`: l'adattatore
  // «export nominato → default» di React.lazy. Knip riconosce a parte
  // `lazy(() => import('./X'))` (LOADER: acceca solo i moduli SENZA export
  // default), ma il `.then` in mezzo rompe il riconoscimento e l'import ridiventa
  // opaco. Si ripara così, e allora si toglie la riga da questa lista:
  //   const X = lazy(async () => {
  //     const { X: C } = await import('./X');
  //     return { default: C };
  //   });
  // Costo di lasciarlo: ognuno di questi file esporta il proprio componente (più,
  // al massimo, i tipi delle sue props), e quel componente è vivo per definizione
  // — è quello che il `lazy()` carica.
  { file: "client/src/components/Board/KanbanBoardPane.tsx", reason: "lazy+then" },
  { file: "client/src/components/Browser/RemoteBrowserPanel.tsx", reason: "lazy+then" },
  { file: "client/src/components/Context/ContextInspector.tsx", reason: "lazy+then" },
  { file: "client/src/components/Dashboard/DashboardPane.tsx", reason: "lazy+then" },
  { file: "client/src/components/Editor/CodeEditor.tsx", reason: "lazy+then" },
  { file: "client/src/components/Editor/DiffViewer.tsx", reason: "lazy+then" },
  { file: "client/src/components/Editor/EditorTabs.tsx", reason: "lazy+then" },
  { file: "client/src/components/Editor/FilePane.tsx", reason: "lazy+then" },
  { file: "client/src/components/Modals/NewTopicModal.tsx", reason: "lazy+then" },
  { file: "client/src/components/Modals/TopicSettingsModal.tsx", reason: "lazy+then" },
  { file: "client/src/components/Project/FileExplorer.tsx", reason: "lazy+then" },
  { file: "client/src/components/Project/FileSearch.tsx", reason: "lazy+then" },
  { file: "client/src/components/Project/GitChanges.tsx", reason: "lazy+then" },
  { file: "client/src/components/Project/ProcessLogPane.tsx", reason: "lazy+then" },
  { file: "client/src/components/Settings/GlobalSettings.tsx", reason: "lazy+then" },
  { file: "client/src/components/Shared/KeyboardShortcuts.tsx", reason: "lazy+then" },
  { file: "client/src/components/Sidebar/CronJobsPanel.tsx", reason: "lazy+then" },
  { file: "client/src/components/Terminal/SingleTerminalPane.tsx", reason: "lazy+then" },
  // Tre test leggono il SORGENTE di questo file (`readFileSync(new URL(
  // '../../hooks/useTauriBrowser.ts', import.meta.url))`) per asserire su cosa
  // c'è scritto dentro. Per knip `new URL(specifier, import.meta.url)` è un
  // riferimento al modulo, e non sapendo cosa ne leggi lo rende opaco. È il
  // prezzo giusto: quei test valgono più della copertura su un file con UN export.
  { file: "client/src/hooks/useTauriBrowser.ts", reason: "il sorgente è letto da 3 test via new URL()" },
  // A genuine ENTRY POINT: the auto-bump workflow runs it
  // (`bun run scripts/release-gate.ts`), and knip counts every export of an
  // entry point as used — rightly, since nobody imports them. That
  // `tests/unit/auto-bump-gate.test.ts` imports `decide` to test it does not
  // change knip's verdict on the file itself.
  // Cost of leaving it: a dead export ADDED in there would go unreported. Small,
  // because the file has one surface (`decide` plus the two types of its input)
  // and twenty tests cover it. Not repairable: dropping the entry point would
  // mean no longer being able to run it.
  { file: "scripts/release-gate.ts", reason: "entry point: il workflow lo esegue, knip da' per usati gli export di un entry" },
];

// ─── i candidati ─────────────────────────────────────────────────────────────

export interface Candidate {
  /** Path relativo alla RADICE del repo — quello che stampa knip. */
  repoRel: string;
  abs: string;
}

/**
 * I file su cui il cancello DEVE saper vedere un export morto: dentro `project`,
 * fuori da `entry` e da `ignore`.
 *
 * Gli entrypoint restano fuori di proposito: knip non riporta gli export dei
 * file di ingresso (`includeEntryExports` è false), ed è voluto — un entrypoint
 * esporta per chi lo carica da fuori dal grafo. Non è un punto cieco, è il
 * contratto. I `.d.ts` restano fuori perché una sonda `export const` lì dentro
 * è codice, non dichiarazione.
 */
export function collectCandidates(workspaces: WorkspaceGlobs[], root: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const scriptEntries = new Set<string>();
  for (const ws of workspaces) {
    const manifest = join(root, ws.dir, "package.json");
    if (existsSync(manifest)) {
      for (const e of entriesFromPackageScripts(readFileSync(manifest, "utf8"), ws.dir)) {
        scriptEntries.add(e);
      }
    }
  }
  for (const ws of workspaces) {
    const base = ws.dir ? join(root, ws.dir) : root;
    for (const pattern of ws.project) {
      for (const rel of new Bun.Glob(pattern).scanSync({ cwd: base, onlyFiles: true, dot: false })) {
        const wsRel = rel.split("\\").join("/");
        if (wsRel.startsWith("node_modules/") || wsRel.includes("/node_modules/")) continue;
        if (wsRel.endsWith(".d.ts")) continue;
        if (matches(ws.entry, wsRel) || matches(ws.ignore, wsRel)) continue;
        const repoRel = ws.dir ? `${ws.dir}/${wsRel}` : wsRel;
        if (seen.has(repoRel) || scriptEntries.has(repoRel)) continue;
        // `export =` (TS, stile CommonJS) è incompatibile con qualunque altro
        // export: la sonda non compilerebbe.
        const abs = join(root, repoRel);
        if (/^export\s*=/m.test(readFileSync(abs, "utf8"))) continue;
        seen.add(repoRel);
        out.push({ repoRel, abs });
      }
    }
  }
  return out.sort((a, b) => a.repoRel.localeCompare(b.repoRel));
}

// ─── sonde: metti / togli ────────────────────────────────────────────────────

export function withProbe(source: string): string {
  return source.endsWith("\n") ? `${source}${PROBE_LINE}\n` : `${source}\n${PROBE_LINE}\n`;
}

export function withoutProbe(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.includes(PROBE_MARKER))
    .join("\n");
}

// ─── lettura del report ──────────────────────────────────────────────────────

interface KnipJsonIssue { file: string; symbols?: Array<{ name: string }> }

/**
 * Dal report JSON di knip: i file in cui la sonda è stata VISTA.
 * Il reporter `json` emette un array di `{ file, exports: [...], types: [...] }`
 * con path relativi alla radice (dove gira knip).
 */
export function filesWhereProbeWasSeen(json: string): Set<string> {
  const seen = new Set<string>();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return seen; }
  const rows = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>).flat();
  for (const row of rows as KnipJsonIssue[]) {
    if (!row || typeof row.file !== "string") continue;
    for (const [key, value] of Object.entries(row)) {
      if (key === "file" || !Array.isArray(value)) continue;
      for (const sym of value as Array<{ name?: string }>) {
        if (sym?.name === PROBE_NAME) seen.add(row.file.split("\\").join("/"));
      }
    }
  }
  return seen;
}

// ─── main ────────────────────────────────────────────────────────────────────

function leftoverProbes(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => readFileSync(c.abs, "utf8").includes(PROBE_MARKER));
}

/**
 * THE HOLD FILE. This gate rewrites hundreds of sources twice (the probe, then
 * an identical restore). On a machine with the server hot-reload on
 * (`TOPICS_SERVER_WATCH=1`, see scripts/server-watch.sh) every write is an
 * event, and on 2026-09-03 those events restarted the production server every
 * 30 seconds for ten minutes. The watcher compares content, but in the window
 * where the probes ARE in place the content really is different: the only way
 * to tell it "this is not a change" is to say so. Raised before the first
 * write, dropped after the last one, in `--restore` too.
 */
const RELOAD_HOLD = join(ROOT, ".topics-reload-hold");
function raiseHold(): void {
  try { writeFileSync(RELOAD_HOLD, `check-deadcode-blindspots pid ${process.pid} ${new Date().toISOString()}\n`); } catch { /* without the hold we carry on: the watcher still compares content */ }
}
function dropHold(): void {
  try { unlinkSync(RELOAD_HOLD); } catch { /* already gone */ }
}

function restore(files: Map<string, string>): void {
  for (const [abs, original] of files) {
    try {
      if (readFileSync(abs, "utf8") !== original) writeFileSync(abs, original);
    } catch { /* il file è sparito sotto: non c'è niente da rimettere */ }
  }
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const listOnly = argv.includes("--list");
  const restoreOnly = argv.includes("--restore");

  const knipPath = join(ROOT, "knip.jsonc");
  if (!existsSync(knipPath)) {
    console.error("knip.jsonc non trovato: il cancello non esiste, non c'è niente da misurare.");
    return 1;
  }
  const workspaces = readKnipWorkspaces(readFileSync(knipPath, "utf8"));
  const candidates = collectCandidates(workspaces, ROOT);

  if (restoreOnly) {
    const dirty = leftoverProbes(candidates);
    raiseHold();
    for (const c of dirty) writeFileSync(c.abs, withoutProbe(readFileSync(c.abs, "utf8")));
    dropHold();
    console.log(dirty.length ? `Sonde rimosse da ${dirty.length} file.` : "Nessuna sonda da rimuovere.");
    return 0;
  }

  const dirty = leftoverProbes(candidates);
  if (dirty.length) {
    console.error(
      `Ci sono già ${dirty.length} sonde nell'albero (una run precedente è morta a metà).\n` +
      `Ripara con:  bun run scripts/check-deadcode-blindspots.ts --restore\n` +
      dirty.slice(0, 10).map((c) => `  ${c.repoRel}`).join("\n"),
    );
    return 1;
  }

  const originals = new Map<string, string>();
  const onSignal = () => { restore(originals); dropHold(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let seen: Set<string>;
  raiseHold();
  try {
    for (const c of candidates) {
      const original = readFileSync(c.abs, "utf8");
      originals.set(c.abs, original);
      writeFileSync(c.abs, withProbe(original));
    }
    console.log(`Sonde piazzate su ${candidates.length} file. Lancio knip…`);

    let stdout = "";
    try {
      stdout = execFileSync(join(ROOT, "node_modules/.bin/knip-bun"), ["--reporter", "json"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // knip esce 1 quando trova qualcosa: è il caso NORMALE qui (le sonde SONO
      // export morti). Lo stdout è comunque il report.
      stdout = (err as { stdout?: string }).stdout ?? "";
      if (!stdout) throw err;
    }
    seen = filesWhereProbeWasSeen(stdout);
  } finally {
    restore(originals);
    dropHold();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const blind = candidates.filter((c) => !seen.has(c.repoRel)).map((c) => c.repoRel);
  const known = new Map(KNOWN_BLIND.map((k) => [k.file, k.reason]));
  const blindSet = new Set(blind);
  const regressions = blind.filter((f) => !known.has(f));
  const healed = KNOWN_BLIND.filter((k) => !blindSet.has(k.file)).map((k) => k.file);

  console.log(`File di progetto sotto esame: ${candidates.length}`);
  console.log(`Sonde tornate dal report:     ${candidates.length - blind.length}`);
  console.log(`Punti ciechi:                 ${blind.length} (${blind.length - regressions.length} già in lista, ${regressions.length} nuovi)`);

  if (blind.length - regressions.length > 0) {
    console.log(`\nCiechi già noti e accettati (vedi KNOWN_BLIND per il motivo):`);
    for (const f of blind) if (known.has(f)) console.log(`  ${f}  — ${known.get(f)}`);
  }

  if (healed.length) {
    console.error(
      `\nQuesti NON sono più ciechi: la lista può solo accorciarsi, quindi toglili ` +
      `da KNOWN_BLIND in ${"scripts/check-deadcode-blindspots.ts"}.`,
    );
    for (const f of healed) console.error(`  ${f}`);
  }

  if (regressions.length) {
    console.error(`\nREGRESSIONE — qui un export morto NON lo vede nessuno:`);
    for (const f of regressions) console.error(`  ${f}`);
    console.error(
      `\nCausa quasi sempre la stessa: qualcuno importa il modulo con un ` +
      `\`import('…')\` il cui risultato non finisce in una destrutturazione ` +
      `(\`.then(({ x }) => …)\`, un \`import()\` assegnato a una variabile già ` +
      `dichiarata, un \`(await import(…)).membro\`). Per knip quel modulo è OPACO ` +
      `e ogni suo export risulta usato.\n` +
      `Trova chi lo importa (\`grep -rn "import(.*<modulo>"\`) e riscrivilo come ` +
      `\`const { x } = await import('…')\`. Se invece è un cieco che vale la pena ` +
      `accettare, mettilo in KNOWN_BLIND CON IL MOTIVO.`,
    );
  }

  if (!regressions.length && !healed.length) {
    console.log(
      blind.length
        ? "\nNessuna regressione: il cancello guarda tutto il resto."
        : "\nIl cancello sul codice morto guarda ogni file di progetto.",
    );
    return 0;
  }
  return listOnly ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
