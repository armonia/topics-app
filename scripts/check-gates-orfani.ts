#!/usr/bin/env bun
/**
 * Prints the `check:*` gates no workflow runs, with the written reason.
 * Logic moved from `tests/unit/check-scripts-are-wired.test.ts`, which now
 * imports it from here: one definition, no copy. The `undeclared` / `expired` /
 * `brokenPaths` strings stay identical to the test's old output (the text is
 * part of the value), and so do the REASONS reason texts — translate nothing
 * inside them. Exit 1 when any of those three lists is non-empty, else 0.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");

/** Prefixes that declare "this is not a code gate": none may sit in a workflow. */
export const REPORT_PREFIXES = ["report:", "probe:", "measure:", "bench:"];

/** The `check:*` nobody runs, and why. `orphanReport()` demands each entry still be true. */
export const REASONS: Record<string, string> = {
  "check:repo-pulito":
    "misura il CHECKOUT, non il codice: rami oltre main, stash, worktree, file non " +
    "committati. In CI `actions/checkout` costruisce un checkout usa e getta dove " +
    "niente di tutto cio' puo' esistere, quindi in CI sarebbe sempre verde e non " +
    "direbbe niente; in una worktree di consegna i rami ci sono per forza, quindi in " +
    "`static-rails` sarebbe sempre rosso. Gira da `scripts/git-hooks/pre-push`, cioe' " +
    "nel momento in cui qualcuno sta per dire fatto, e stampa senza mai bloccare.",
  "check:lockfile":
    "versione «una botta sola» per l'umano (root, client, landing). In CI gli stessi tre " +
    "lockfile sono gia' coperti dai due install piu' il passo landing/ dedicato.",
  "check:contrast": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:field": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:painted": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:landing": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:copy": "gira su landing/dist, un sito gia' costruito che nessun workflow costruisce.",
  "check:occlusion":
    "e' un cancello VERO del codice, ma vuole un WebKit di Playwright e un bundle costruito: " +
    "gira a mano, ed e' anche l'attrezzo che registra la clip di consegna (--video).",
  "check:history-clean":
    "interroga la STORIA (contenuti, messaggi di commit e messaggi dei tag annotati) sui ref " +
    "che il remoto pubblica, e in CI la storia non c'e': " +
    "`actions/checkout` clona con `fetch-depth: 1`, quindi il cancello misurerebbe un solo " +
    "commit e uscirebbe verde per il motivo sbagliato - il modo piu' comune in cui un cancello " +
    "smette di guardare senza che nessuno se ne accorga. Gira a mano prima e dopo la " +
    "riscrittura (`bun run scripts/scrub-history.ts` per misurare, `--check` per l'esito), " +
    "che e' l'unico momento in cui serve. Se un giorno si scaricasse la storia intera in CI, " +
    "questa riga va tolta e il cancello cablato.",
  "check:quality-bar":
    "legge lo stato di GitHub (ultimo CI su main, issue bug aperte) e il log del server di " +
    "chi lo lancia: in CI il primo sarebbe il run stesso e il secondo non esiste. Lo esegue " +
    "`scripts/qa-gate.sh`, la barra locale; il suo test unitario (un mutante per misura) gira " +
    "invece nella suite.",
  "check:sidecars":
    "guarda l'ALLESTIMENTO di questa postazione, non il codice: dice se " +
    "desktop-tauri/src-tauri/binaries c'e', cioe' se il crate Tauri e' compilabile qui. In CI " +
    "quella cartella la costruisce (o la stubba) il workflow stesso, e non esiste un checkout " +
    "principale da cui prenderla: il cancello uscirebbe verde per il motivo sbagliato. Gira a " +
    "mano in un worktree, e `bun run sidecars:sync` e' la sua cura.",
  "check:scroll-fluidity":
    "dipende dalla CADENZA dello schermo e in CI non puo' decidere: misura i frame persi " +
    "scorrendo una chat, la baseline `scripts/scroll-fluidity-baseline.json` e' registrata a 120 Hz (8,3 ms) " +
    "e il runner CI dipinge a 60 Hz (16,7 ms), quindi esce 2 («non misurato», 2,0x) su ogni run: " +
    "8 su 8, circa 69 giorni senza un verdetto. Un cancello che si astiene restando verde e' " +
    "peggio di nessun cancello, perche' sembra una copertura. Si lancia a mano su uno schermo " +
    "da almeno 120 Hz; torna in CI solo con un runner a 120 Hz o una baseline a 60.",
  "check:drag":
    "dipende dalla CADENZA dello schermo e in CI non puo' decidere: misura il frame time di " +
    "un drag sulla board, come `check:scroll-fluidity`; la baseline `scripts/drag-frames-baseline.json` e' a 120 Hz, il " +
    "runner CI a 60 Hz, quindi la calibrazione (16,7 ms) e' gia' tutto il budget del p95 (16,7 " +
    "ms) e il cancello esce 2 («non misurato») su ogni run, 8 su 8. Tolto dal workflow perche' " +
    "un'astensione sempre verde non protegge niente. Si lancia a mano su uno schermo da almeno " +
    "120 Hz; torna in CI solo con un runner a 120 Hz o una baseline a 60.",
};

/** The package.json scripts, by name. */
export function scripts(repoRoot: string = REPO_ROOT): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/**
 * Strip YAML comments: from a `#` at line start or preceded by whitespace to
 * end of line.
 *
 * WHY. A workflow EXECUTES in the `run:` block and EXPLAINS in comments, and
 * the whole difference is here. Without this pass the first comment naming a
 * command counts as executing it — it happened at once, on the first run: the
 * comment added in `ci.yml` to say "do not add `report:landed` here" contains
 * the string `bun run report:landed --json` as guidance for the reader, and
 * the test flagged it as an intruder. A check that punishes its own
 * documentation teaches people not to document.
 *
 * WHY IT TRACKS QUOTES, and it is not pedantry. This pass does not add text:
 * it REMOVES it. So every excess goes toward what cannot be seen — a command
 * deleted by mistake is not a false alarm, it is an invocation that vanishes,
 * and the test below turns green on a workflow that really does run that
 * command. Cutting at the first `#` of the line,
 *
 *     - run: echo "step #1" && bun run report:landed
 *
 * leaves `- run: echo "step`, and the report walks into CI with nobody
 * flagging it (measured: the gate exited 0 on that exact line). The `#` opens
 * a comment only when it is OUTSIDE a string, so the quote state must be
 * followed. Pinned at the bottom of the file, line by line.
 */
export function stripYamlComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** Every workflow, as `name → EXECUTABLE source` (comments removed). */
export function workflows(repoRoot: string = REPO_ROOT): Record<string, string> {
  const dir = join(repoRoot, ".github/workflows");
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    out[f] = stripYamlComments(readFileSync(join(dir, f), "utf-8"));
  }
  return out;
}

/**
 * `run <name>` with a real boundary at the tail, so `check:deadcode` never
 * matches inside `check:deadcode-blindspots`. A script DEFINITION is not an
 * invocation: `"check:any": "bun run scripts/check-any.ts"` has no `run check:any`.
 */
export function invokes(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\brun\\s+${escaped}(?![\\w:.-])`).test(source);
}

/** Who runs `name`: the workflows launching it + the other scripts launching it. */
export function invokers(name: string, all: Record<string, string>, wf: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(wf)) if (invokes(src, name)) out.push(`.github/workflows/${file}`);
  for (const [key, cmd] of Object.entries(all)) if (key !== name && invokes(cmd, name)) out.push(`package.json:${key}`);
  return out;
}

export interface OrphanReport {
  /** check:* that nobody runs and that carry a written reason, name + reason. */
  declared: { name: string; reason: string }[];
  /** check:* that nobody runs and have NO reason: the defect. Same messages as the test today. */
  undeclared: string[];
  /** REASONS entries that went stale: script gone, now wired, reason too short. */
  expired: string[];
  /** Reasons naming a repo path (`scripts/…`, `.github/…`, `tests/…`, `server/…`, `client/…`) that does not exist. */
  brokenPaths: string[];
}

export function orphanReport(repoRoot: string = REPO_ROOT): OrphanReport {
  const all = scripts(repoRoot);
  const wf = workflows(repoRoot);
  const declared: { name: string; reason: string }[] = [], undeclared: string[] = [];
  for (const name of Object.keys(all).sort()) {
    if (!name.startsWith("check:")) continue;
    if (invokers(name, all, wf).length > 0) continue;
    const reason = REASONS[name];
    if (reason !== undefined) {
      declared.push({ name, reason });
      continue;
    }
    undeclared.push(
      `${name}  — definito in package.json e lanciato da NESSUNO.\n` +
        `      Un check che nessuno esegue non protegge: fa credere che la classe di difetti\n` +
        `      sia coperta. O lo cabli in .github/workflows/ci.yml, o scrivi il motivo in\n` +
        `      REASONS qui in scripts/check-gates-orfani.ts. Se misura lo stato\n` +
        `      della board e non il codice, il nome giusto e' report:* (vedi report:landed).`,
    );
  }
  const expired: string[] = [];
  for (const [name, motivo] of Object.entries(REASONS)) {
    if (!all[name]) {
      expired.push(`${name}: non esiste piu' in package.json, togli la riga da REASONS`);
      continue;
    }
    const chi = invokers(name, all, wf);
    if (chi.length > 0) expired.push(`${name}: ora e' cablato (${chi.join(", ")}), togli la riga da REASONS`);
    if (motivo.trim().length < 20) expired.push(`${name}: il motivo e' troppo corto per essere un motivo`);
  }
  const brokenPaths: string[] = [];
  for (const [name, motivo] of Object.entries(REASONS)) {
    // Repo paths quoted in backticks: `scripts/...`, `.github/...`.
    for (const m of motivo.matchAll(/`((?:scripts|\.github|tests|server|client)\/[^`\s]+)`/g)) {
      const rel = m[1];
      if (!existsSync(join(repoRoot, rel))) {
        brokenPaths.push(
          `${name}: il motivo dice che gira da \`${rel}\`, che non esiste.\n` +
            `      O il file e' stato spostato e il motivo va aggiornato, o il motivo\n` +
            `      non e' mai stato vero: in entrambi i casi il check non gira dove dice.`,
        );
      }
    }
  }
  return { declared, undeclared, expired, brokenPaths };
}

if (import.meta.main) {
  const report = orphanReport();
  for (const { name, reason } of report.declared) {
    const flat = reason.replace(/\s+/g, " ").trim(); // first sentence: up to the first `. ` or `: `, max 150 chars
    const cuts = [flat.indexOf(". "), flat.indexOf(": ")].filter((i) => i >= 0);
    const head = cuts.length > 0 ? flat.slice(0, Math.min(...cuts)) : flat;
    console.log(`  ${name} — ${head.length > 150 ? `${head.slice(0, 150)}…` : head}`);
  }
  const problems = [...report.undeclared, ...report.expired, ...report.brokenPaths];
  for (const line of problems) console.log(line);
  if (problems.length === 0) {
    console.log(`check:gates-orfani: ${report.declared.length} orfani, tutti dichiarati`);
  } else {
    console.log(`check:gates-orfani: ROSSO, ${problems.length} senza motivo o con motivo scaduto`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
