#!/usr/bin/env bun
/**
 * «Done» deve voler dire «è nel prodotto»: le card chiuse col commit di consegna
 * FUORI dal contenuto di main, contate a voce.
 *
 * Il guasto dell'11/08 (card `2e6964cb`): il land non è riuscito, il thread lo
 * scriveva — «⚠️ Land NON riuscito … Il branch del task NON è su main» — e lo
 * stato diceva `done`. Sulla board la card stava in Done come tutte le altre.
 * La colonna Done è l'unica cosa che si guarda quando si tira una riga: una card
 * lì dentro col codice fuori da main è lavoro che nessuno cerca più, e il GC dei
 * worktree può potarne il ramo. Quella volta era documentazione ed è stata
 * rimessa a mano; con del codice sarebbe sparita in silenzio.
 *
 * Il cancello che chiude il buco sta nel land (`task-automerge.ts` +
 * `landFallout`): un land fallito TOGLIE la card da Done. Questo script è la
 * MISURA — lo stesso conto fatto a mano quella notte — e serve a due cose: dire
 * che l'arretrato è stato smaltito, e accorgersi se il cancello ricomincia a
 * perdere.
 *
 *   bun run check:landed              # esce ≠0 se una sola card done non è su main
 *   bun run check:landed --json       # una riga JSON, per chi la vuole leggere a macchina
 *   bun run check:landed --strict     # fallisce anche sui commit SPARITI dal repo
 *   bun run check:landed --db <path>  # un altro database
 *
 * Sola lettura: apre il DB `{ readonly: true }` e gira solo comandi git di
 * lettura. Non ripara niente — landare è una decisione umana.
 *
 * «Nel contenuto di main», non «antenato di main»: il land RICOPIA i commit
 * della card (cherry-pick) invece di fonderli, quindi la copia atterrata ha un
 * altro sha e la discendenza direbbe di no su lavoro che è dentro. Il conto è
 * quello di `commitStatusFromRepo`, lo stesso dell'audit periodico — due copie
 * divergerebbero, e la copia sbagliata è quella che assolve.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../server/services/tasks";
import { commitStatusFromRepo, type BranchStatus } from "../server/services/branch-status";
import { scanWorkspaceProjects } from "../server/services/project-path-resolver";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const JSON_OUT = argv.includes("--json");
const STRICT = argv.includes("--strict");
const DB_PATH = flag("--db") ?? process.env.TOPICS_DB
  ?? join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "topics.db");
const WORKSPACE_DIR = process.env.DISPATCH_WORKSPACE_DIR ?? join(homedir(), ".openclaw", "workspace");

interface DoneRow {
  id: string;
  project_id: string;
  text: string;
  delivery_branch: string | null;
  delivery_commit: string;
  landing_state: string | null;
}

/** Una card chiusa e il verdetto del repo sulla sua consegna. */
interface Verdict {
  id: string;
  text: string;
  projectId: string;
  branch: string | null;
  commit: string;
  /** Quello che la board MOSTRA — utile solo per vedere quanto è in ritardo. */
  landingState: string | null;
  /** `unmerged` = provato: non è su main. `gone` = il commit non c'è più. */
  status: BranchStatus | "no-repo";
  repoPath: string | null;
}

if (!existsSync(DB_PATH)) {
  console.error(`nessun database in ${DB_PATH}. Passa --db <path> o DATA_DIR=…`);
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });

/**
 * `tasks.project_id` è un hash A SENSO UNICO del percorso (`projectIdForPath`):
 * per tornare alla cartella si ri-hasha ogni percorso che il DB conosce finché
 * uno combacia. Le sorgenti sono le stesse del server (progetti registrati,
 * cartelle dei topic, scansione del workspace) — meno una, e le card di quel
 * progetto diventerebbero «non verificabili» invece di essere guardate.
 */
function projectPaths(): string[] {
  const seen = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/")) return;
    const clean = p.replace(/\/+$/, "");
    if (clean) seen.add(clean);
  };
  try { for (const r of db.prepare("SELECT path FROM projects").all() as any[]) add(r.path); } catch { /* tabella assente */ }
  try {
    for (const r of db.prepare("SELECT DISTINCT project_path FROM topics WHERE project_path IS NOT NULL").all() as any[]) add(r.project_path);
  } catch { /* idem */ }
  for (const p of scanWorkspaceProjects(WORKSPACE_DIR)) add(p);
  return [...seen];
}

const byBoardId = new Map<string, string>();
for (const path of projectPaths()) {
  const id = projectIdForPath(path);
  // Primo che vince: l'ordine è progetti registrati → topic → workspace, cioè
  // dal più autorevole al più occasionale.
  if (!byBoardId.has(id) && existsSync(join(path, ".git"))) byBoardId.set(id, path);
}

const rows = db.prepare(
  `SELECT id, project_id, text, delivery_branch, delivery_commit, landing_state
     FROM tasks
    WHERE archived = 0 AND status = 'done' AND delivery_commit IS NOT NULL`,
).all() as unknown as DoneRow[];

const verdicts: Verdict[] = [];
for (const r of rows) {
  const repoPath = byBoardId.get(r.project_id) ?? null;
  const status: BranchStatus | "no-repo" = repoPath
    ? await commitStatusFromRepo(repoPath, r.delivery_commit)
    : "no-repo";
  verdicts.push({
    id: r.id, text: r.text ?? "", projectId: r.project_id,
    branch: r.delivery_branch, commit: r.delivery_commit,
    landingState: r.landing_state, status, repoPath,
  });
}

const outside = verdicts.filter((v) => v.status === "unmerged");
const pruned = verdicts.filter((v) => v.status === "gone");
const unresolved = verdicts.filter((v) => v.status === "no-repo");
const landed = verdicts.filter((v) => v.status === "merged");

if (JSON_OUT) {
  console.log(JSON.stringify({
    checked: verdicts.length,
    landed: landed.length,
    outsideMain: outside.length,
    pruned: pruned.length,
    unresolvedProject: unresolved.length,
    cards: outside.map((v) => ({ id: v.id, commit: v.commit, branch: v.branch, text: v.text.slice(0, 80) })),
  }));
} else {
  const line = (v: Verdict) =>
    `    · ${v.id.slice(0, 8)} ${v.commit.slice(0, 8)}${v.branch ? ` (${v.branch})` : ""} — ${v.text.slice(0, 60)}`;
  console.log(
    `card done con una consegna registrata: ${verdicts.length} · su main: ${landed.length} · ` +
    `FUORI da main: ${outside.length} · commit sparito: ${pruned.length} · progetto non risolto: ${unresolved.length}`,
  );
  if (outside.length > 0) {
    console.log(`\n  ${outside.length} card sono in Done col codice FUORI dal contenuto di main:`);
    // Raggruppate per checkout: la prova si incolla in un terminale per NON
    // crederci, e una prova che nomina il repo di un'ALTRA card non si incolla.
    const byRepo = new Map<string, Verdict[]>();
    for (const v of outside) byRepo.set(v.repoPath ?? "?", [...(byRepo.get(v.repoPath ?? "?") ?? []), v]);
    for (const [repo, group] of byRepo) {
      console.log(`\n  ${repo} — ${group.length}:`);
      for (const v of group) console.log(line(v));
      const first = group[0]!;
      console.log(
        `    prova: git -C '${repo}' merge-base --is-ancestor ${first.commit} main; ` +
        `git -C '${repo}' log main -F --grep="$(git -C '${repo}' log -1 --format=%s ${first.commit})"`,
      );
    }
    console.log("\n  azione: landa il ramo (bottone «Landa su main» sulla card) prima che il GC lo poti, oppure cherry-picka il commit a mano");
  }
  if (pruned.length > 0) {
    // Non è un'assoluzione: il commit poteva essere stato potato PRIMA di
    // atterrare. È «non lo so», e va detto — `--strict` lo tratta da guasto.
    console.log(`\n  ${pruned.length} card hanno un commit che il repo non ha più (potato, o progetto spostato): non verificabili`);
    for (const v of pruned) console.log(line(v));
  }
  if (unresolved.length > 0) {
    const ids = [...new Set(unresolved.map((v) => v.projectId))];
    console.log(`\n  ${unresolved.length} card su ${ids.length} board di cui non si trova il checkout (${ids.slice(0, 5).join(", ")}): non guardate`);
  }
}

process.exit(outside.length > 0 || (STRICT && pruned.length > 0) ? 1 : 0);
