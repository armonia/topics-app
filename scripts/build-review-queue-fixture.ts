#!/usr/bin/env bun
/**
 * Congela la coda di review dell'11/08/2026 come fixture della derivazione.
 *
 * NON RIGENERARE. `tests/fixtures/review-queue-2026-08-11.json` è stato
 * ANONIMIZZATO a mano: id e titoli delle 29 card sono sintetici, perché questo
 * repo è pubblico e quei titoli erano la roadmap vera di una persona. La forma
 * misurata (29 card, i file dei loro commit propri, il verdetto atteso) è
 * intatta, ed è l'unica cosa su cui il test asserisce. Far girare questo script
 * contro il DB vivo rimetterebbe dentro i dati reali: tienilo come documento di
 * COME la misura è stata presa, non come un comando da eseguire.
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
 *    etichette, ricostruito dagli eventi di stato del thread
 *    (`task_comments.kind='status'`, `da→a`): l'ultima transizione fino a
 *    quell'istante finisce in `review`. Root, non archiviate. Sono 29, che è
 *    esattamente il numero contato a mano. L'istante ESATTO non è scritto qui:
 *    era un dato personale (dice a che ora lavorava una persona) ed è stato
 *    normalizzato a mezzanotte, come il campo `at` della fixture. Il che
 *    significa anche che `AT` qui sotto NON ricostruisce più quelle 29 card —
 *    un motivo in più per non rigenerare (vedi il divieto in cima).
 *  · I FILE — quelli dei commit PROPRI della card (`main..ramo --not <altri
 *    rami>`), non `main...ramo`. Il ramo di una card nasceva dall'HEAD di un
 *    checkout condiviso ed EREDITA il lavoro di chi ci stava sopra: sulle stesse
 *    29 card le due basi litigano su 6, e la peggiore è una ricerca che aveva
 *    prodotto un `.md` e che, letta sul ramo intero, sembrava toccarne 83 di
 *    client. Per le card già atterrate il ramo non c'è più: si legge il commit
 *    di merge su main (`merge task <id>: …`).
 *
 * Uso (storico, e vedi il divieto qui sopra: serviva il DB vero e il checkout
 * principale):
 *   bun run scripts/build-review-queue-fixture.ts > tests/fixtures/review-queue-2026-08-11.json
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Normalizzato a mezzanotte, non l'istante vero della misura: vedi sopra. */
const AT = "2026-08-11T00:00:00.000Z";
const REPO = process.env.FIXTURE_REPO ?? join(homedir(), "Projects", "topics-app");
const DB_PATH = process.env.FIXTURE_DB ?? join(REPO, "data", "topics.db");
/** Il file già congelato, letto per non impoverirlo (vedi `frozen`). */
const FIXTURE_PATH = join(import.meta.dir, "..", "tests", "fixtures", "review-queue-2026-08-11.json");
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

/**
 * La fixture già congelata, se c'è.
 *
 * PERCHÉ SERVE. Questa ricostruzione DECADE: il ramo di una card vive finché
 * qualcuno non lo landa, e da quel momento `main..ramo --not <altri>` non ha più
 * niente da dire. Misurato addosso: fra la prima generazione e la seconda — un
 * rebase su main, qualche ora — la card `0a1b2c22` è passata da 20 file (9 di
 * client) a ZERO, e con essa il verdetto da `visibile` a `decisione`. Una fixture
 * che si rigenera più povera ogni volta non è una misura congelata: è una misura
 * che si scioglie, e il test che ci sta sopra racconterebbe la storia sbagliata
 * con la faccia del verde.
 *
 * Quindi: ciò che è già stato MISURATO vince su ciò che oggi non è più
 * ricostruibile. Una rigenerazione può solo aggiungere, mai svuotare.
 */
const frozen = new Map<string, { files: string[]; basis: string }>();
try {
  const prev = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    cards: Array<{ id: string; files: string[]; basis: string }>;
  };
  for (const c of prev.cards) if (c.files?.length) frozen.set(c.id, { files: c.files, basis: c.basis });
} catch { /* prima generazione: non c'è niente da preservare */ }

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
  let list = [...files].sort();
  // Il congelato vince sul decaduto (vedi `frozen`): se oggi la ricostruzione è
  // vuota ma una misura c'era, si tiene quella e lo si dichiara nel `basis`.
  const keep = frozen.get(t.id);
  if (!list.length && keep) {
    list = keep.files;
    basis = `${keep.basis} (congelato 2026-08-11)`;
  }
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
    // regola viene messa alla prova, nelle TRE classi: se qualcuno allarga
    // `client/src` a `client/`, si dimentica l'esclusione dei test, o rimette i
    // documenti nello stesso mucchio del codice, qui si vede.
    //
    // Scritto a mano e non chiamando `deriveCloser`: una fixture che chiama la
    // funzione che deve mettere alla prova è un test che non può fallire.
    expected: list.some((f) => f.startsWith("client/src/") && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
      ? "visibile"
      : (!list.length || list.every((f) => f.endsWith(".md") || f.startsWith("openspec/") || f.startsWith("docs/")))
        ? "decisione"
        : "invisibile",
  };
});

// Le rigenerazioni successive NON devono impoverire il file: se una card che
// aveva una misura oggi non ne ha più, il congelato l'ha già rimessa — ma se
// qualcuno cancella il file e rigenera da zero, questo lo dice a voce.
const dissolved = cards.filter((c) => !c.files.length);
if (dissolved.length) {
  console.error(
    `[fixture] ATTENZIONE: ${dissolved.length} card senza file e senza misura congelata ` +
    `(${dissolved.map((c) => c.id.slice(0, 8)).join(", ")}). I loro rami non esistono più: ` +
    "il verdetto che ne esce è `decisione` per assenza di codice, non una misura del loro diff.",
  );
}

console.log(JSON.stringify({ at: AT, project: PROJECT_PREFIX, cards }, null, 2));
