#!/usr/bin/env bun
/**
 * Anteprime di review: due card non possono mostrare la STESSA immagine.
 *
 * Il rilievo dell'11/08: su 47 anteprime sul disco i contenuti distinti erano
 * 25 — 24 card mostravano due sole schermate, e nessuna delle due era il loro
 * lavoro (la login di un altro progetto adottata dalla porta del pool, e il 503
 * «Bundle not built yet» di un worktree senza `public/`). Il cancello è nel
 * `preview-manager`; questo script è la MISURA, e la bonifica di ciò che il
 * cancello ha lasciato passare prima di esistere.
 *
 *   bun run scripts/check-preview-evidence.ts            # conta, esce ≠0 se >0
 *   bun run scripts/check-preview-evidence.ts --fix      # azzera le card e cestina i file
 *
 * Opzioni: --dir <anteprime> --db <topics.db>. Un'evidenza falsa è peggio di
 * nessuna evidenza: --fix toglie l'immagine dalla card e lascia una nota nel
 * thread, così il task torna giudicabile invece di sembrare pronto.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { DUPLICATE_EVIDENCE_REASON } from "../shared/preview-retirement";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const FIX = argv.includes("--fix");
const PREVIEW_DIR = flag("--dir") ?? join(homedir(), ".openclaw", "media", "task-previews");
const DB_PATH = flag("--db") ?? process.env.TOPICS_DB ?? join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "topics.db");

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

function md5(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    return createHash("md5").update(readFileSync(path)).digest("hex");
  } catch { return null; }
}

/** Cestino, non `rm`: un'anteprima sbagliata resta comunque una prova di cosa è successo. */
function discard(path: string): void {
  try {
    const trash = Bun.which("trash");
    if (trash) { Bun.spawnSync([trash, path]); if (!existsSync(path)) return; }
  } catch { /* fall through */ }
  try { unlinkSync(path); } catch { /* già sparito */ }
}

if (!existsSync(PREVIEW_DIR)) {
  console.log(`nessuna cartella anteprime (${PREVIEW_DIR}) — gruppi duplicati: 0`);
  process.exit(0);
}

const files = readdirSync(PREVIEW_DIR).filter((f) => IMAGE_RE.test(f)).map((f) => join(PREVIEW_DIR, f));
const byDigest = new Map<string, string[]>();
for (const f of files) {
  const d = md5(f);
  if (!d) continue;
  byDigest.set(d, [...(byDigest.get(d) ?? []), f]);
}
const dupes = Array.from(byDigest.entries()).filter(([, fs]) => fs.length > 1);

// Chi PUNTA a quei file: la card è il posto dove il danno si vede.
const db = existsSync(DB_PATH) ? new Database(DB_PATH) : null;
if (db) db.run("PRAGMA busy_timeout = 10000");
const tasksFor = (path: string): { id: string; text: string; status: string }[] => {
  if (!db) return [];
  try {
    return db.prepare("SELECT id, text, status FROM tasks WHERE preview_image = ?").all(path) as any[];
  } catch { return []; }
};

console.log(`anteprime: ${files.length} · contenuti distinti: ${byDigest.size} · gruppi duplicati: ${dupes.length}`);
if (!db) console.log(`(nessun database in ${DB_PATH}: solo il conteggio dei file)`);

let cleared = 0;
for (const [digest, group] of dupes) {
  const cards = group.flatMap((f) => tasksFor(f));
  console.log(`\n  md5 ${digest.slice(0, 8)} — ${group.length} file, ${cards.length} card`);
  for (const c of cards) console.log(`    · ${c.id.slice(0, 8)} [${c.status}] ${(c.text ?? "").slice(0, 60)}`);
  if (!FIX) continue;
  for (const c of cards) {
    try {
      const ts = new Date().toISOString();
      // Il ritiro è uno STATO della card: la nota qui sotto resta (è la storia),
      // ma il fatto «non ha anteprima, e il motivo è che ne aveva una falsa»
      // vive in colonna, dove si spegne da solo quando l'anteprima torna.
      db!.prepare(
        "UPDATE tasks SET preview_image = NULL, preview_retired_at = ?, preview_retired_reason = ? WHERE id = ?",
      ).run(ts, DUPLICATE_EVIDENCE_REASON, c.id);
      const note =
        `⚠️ Anteprima RITIRATA: era byte per byte identica a quella di altre ${cards.length - 1} card ` +
        `(md5 \`${digest.slice(0, 8)}\`), cioè non era evidenza di questo lavoro. ` +
        "La consegna resta in review: allega tu l'anteprima giusta con `update_task(preview_image=…)`.";
      const dupe = db!.prepare(
        "SELECT id FROM task_comments WHERE task_id = ? AND kind = 'review-note' AND content = ? LIMIT 1",
      ).get(c.id, note);
      if (!dupe) {
        db!.prepare(
          "INSERT INTO task_comments (id, task_id, author, content, mentions, media, kind, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 'review-note', ?)",
        ).run(crypto.randomUUID(), c.id, "system", note, ts);
      }
      db!.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, c.id);
      cleared++;
    } catch (err) { console.error(`    ! ${c.id.slice(0, 8)}: ${err}`); }
  }
  for (const f of group) discard(f);
}

if (FIX) {
  const left = readdirSync(PREVIEW_DIR).filter((f) => IMAGE_RE.test(f)).map((f) => join(PREVIEW_DIR, f));
  const after = new Map<string, number>();
  for (const f of left) { const d = md5(f); if (d) after.set(d, (after.get(d) ?? 0) + 1); }
  const still = Array.from(after.values()).filter((n) => n > 1).length;
  console.log(`\nbonificate: ${cleared} card · anteprime: ${left.length} · gruppi duplicati: ${still}`);
  process.exit(still === 0 ? 0 : 1);
}

process.exit(dupes.length === 0 ? 0 : 1);
