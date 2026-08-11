#!/usr/bin/env bun
/**
 * Congela la coda di review dell'11/08/2026 come fixture della derivazione.
 *
 * PERCHÉ ESISTE. La regola «tocca `client/src` fuori dai test ⇒ visibile» è
 * nata da uno smistamento A MANO: 29 card in review, aperte una per una,
 * guardando il diff. La BARRA di quel lavoro è che la derivazione automatica
 * dica le stesse cose. Ma quelle card oggi sono state approvate, i loro rami
 * potati e i loro commit assorbiti da main: fra qualche giorno la misura non si
 * potrebbe più rifare. Questo script la fa UNA volta e la scrive su disco;
 * `shared/task-labels.test.ts` da lì in poi legge il file, non git.
 *
 * COME RICOSTRUISCE, e perché così:
 *  · L'INSIEME — le card in `review` all'istante in cui è nata la card delle
 *    etichette (2026-08-11T17:51:42Z), ricostruito dagli eventi di stato del
 *    thread (`task_comments.kind='status'`, `da→a`): l'ultima transizione fino a
 *    quell'istante finisce in `review`. Root, non archiviate. Sono 29, che è
 *    esattamente il numero contato a mano.
 *  · I FILE — quelli dei commit PROPRI della card (`main..ramo --not <altri
 *    rami>`), non `main...ramo`. Il ramo di una card nasceva dall'HEAD di un
 *    checkout condiviso ed EREDITA il lavoro di chi ci stava sopra: sulle stesse
 *    29 card le due basi litigano su 6, e la peggiore è una ricerca che aveva
 *    prodotto un `.md` e che, letta sul ramo intero, sembrava toccarne 83 di
 *    client. Per le card già atterrate il ramo non c'è più: si legge il commit
 *    di merge su main (`merge task <id>: …`).
 *
 * Uso (rigenerazione; serve il DB vero e il checkout principale):
 *   bun run scripts/build-review-queue-fixture.ts > tests/fixtures/review-queue-2026-08-11.json
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const AT = "2026-08-11T17:51:42.720Z";
const REPO = process.env.FIXTURE_REPO ?? join(homedir(), "Projects", "topics-app");
const DB_PATH = process.env.FIXTURE_DB ?? join(REPO, "data", "topics.db");
const PROJECT_PREFIX = "topics-app";

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", REPO, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout).trim();
}

const db = new Database(DB_PATH, { readonly: true });

const rows = db
  .query("SELECT id, text, parent_task_id, archived, delivery_branch FROM tasks WHERE project_id LIKE ?")
  .all(`${PROJECT_PREFIX}%`) as Array<{
    id: string; text: string; parent_task_id: string | null; archived: number; delivery_branch: string | null;
  }>;
const byId = new Map(rows.map((r) => [r.id, r]));

// Ultimo stato conosciuto di ogni task all'istante della misura.
const stateAt = new Map<string, string>();
const events = db
  .query("SELECT task_id, content FROM task_comments WHERE kind = 'status' AND created_at <= ? ORDER BY created_at ASC")
  .all(AT) as Array<{ task_id: string; content: string }>;
for (const e of events) {
  const m = /^(\w+)→(\w+)/.exec(String(e.content).trim());
  if (m && byId.has(e.task_id)) stateAt.set(e.task_id, m[2]!);
}

const queue = [...stateAt.entries()]
  .filter(([, s]) => s === "review")
  .map(([id]) => byId.get(id)!)
  .filter((t) => !t.parent_task_id && !t.archived);

const others = git(["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").filter(Boolean);

const cards = queue.map((t) => {
  const ref = t.delivery_branch ? `refs/heads/${t.delivery_branch}` : "";
  const alive = ref && git(["rev-parse", "--verify", "--quiet", ref]);
  let commits: string[] = [];
  let basis = "";
  if (alive) {
    commits = git(["rev-list", `refs/heads/main..${ref}`, "--not", ...others.filter((o) => o !== ref)])
      .split("\n").filter(Boolean);
    basis = "own-commits";
  } else {
    const merge = git(["log", "--format=%H", "--grep", t.id, "main"]).split("\n").filter(Boolean)[0];
    if (merge) {
      commits = git(["log", "--format=%H", "--no-merges", `${merge}^1..${merge}`]).split("\n").filter(Boolean);
      basis = "merge-commit";
    }
  }
  const files = new Set<string>();
  for (const sha of commits) {
    for (const f of git(["show", "--name-only", "--format=", "--no-renames", sha]).split("\n")) {
      if (f.trim()) files.add(f.trim());
    }
  }
  const list = [...files].sort();
  return {
    id: t.id,
    text: t.text,
    // `own-commits` / `merge-commit` = misurato. `unreconstructible` = il ramo
    // non esiste più e non c'è un merge su main con questo id: la lista vuota
    // NON è una misura, e chi legge il file deve poterlo distinguere da una
    // card che davvero non ha toccato niente.
    basis: basis ? (list.length ? basis : `${basis}-empty`) : "unreconstructible",
    files: list,
    // Il verdetto CONGELATO. Non lo ricalcola il test: è il dato contro cui la
    // regola viene messa alla prova, e se qualcuno allarga `client/src` a
    // `client/` o si dimentica l'esclusione dei test, qui si vede.
    expected: list.some((f) => f.startsWith("client/src/") && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
      ? "visibile"
      : list.length ? "invisibile" : "visibile",
  };
});

console.log(JSON.stringify({ at: AT, project: PROJECT_PREFIX, cards }, null, 2));
