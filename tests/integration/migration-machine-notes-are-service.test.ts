/**
 * Bonifica del thread: `20260818110000-machine-notes-are-service.sql`.
 *
 * ── Cosa fa, e perche' non e' cosmetica ─────────────────────────────────────
 * Dal 18/08 il GC, il landing audit e il percorso del land marcano da se' le
 * proprie ricevute con `kind='service'`. Ma il thread e' una cosa che RESTA:
 * 871 righe erano gia' scritte, e continuavano a fare muro fra chi rivede e la
 * parola di chi ha fatto il lavoro — su una board viva, cioe' proprio nella
 * colonna che si sta guardando adesso.
 *
 * `service` NON cancella: `foldsAway` le ripiega in «N note di servizio» nel
 * drawer, e la finestra della card le salta.
 *
 * ── Cosa conta davvero: COSA NON tocca ──────────────────────────────────────
 * Come per `migration-071`, il valore non e' cio' che cambia, e' cio' che
 * lascia stare. Il confine non e' «chi l'ha scritta» ma «cambia cosa fai»:
 * «Land != consegna» dice che cio' che e' atterrato non e' cio' che hai
 * approvato, i checks ROSSI elencano i comandi caduti, «Build client fallita»
 * ti chiede un comando. Quelle restano parola.
 *
 * E i predicati sono ANCORATI all'inizio (`LIKE 'x%'`): un umano che cita una
 * di queste frasi non deve sparire dal thread. Sono i due casi in fondo, ed e'
 * la ragione per cui questo test esiste invece di un conteggio.
 *
 * Il test esegue il FILE della migration, non una sua copia: se il predicato
 * cambia, cambia sotto questi casi.
 *
 * @covers THREAD-05
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(import.meta.dir, "../../server/db/migrations/20260818110000-machine-notes-are-service.sql"),
  "utf8",
);

/** [id, autore, testo, kind di partenza, kind atteso dopo]. */
const CASI: [string, string, string, string, string][] = [
  // ── Contabilita': ripiega ────────────────────────────────────────────────
  ["1", "system", "Non è su main: `abc1234` (topics/x) — landa il ramo.", "comment", "service"],
  ["2", "system", "⚠️ Worktree `topics/x` tenuto per modifiche non committate (path: `/p`).", "comment", "service"],
  ["3", "system", "⚠️ Worktree NON ripulito: sporco. Il branch è stato conservato.", "comment", "service"],
  ["4", "system", "🧹 Cartella del worktree liberata per fare spazio: spazio.", "comment", "service"],
  ["5", "system", "Worktree e branch del task ripuliti.", "comment", "service"],
  ["6", "system", "Land accodato: la card si chiude solo quando il merge è CONFERMATO su main.", "comment", "service"],
  ["7", "system", "Riallineato prima del land: main portato nel ramo.", "comment", "service"],
  ["8", "system", "Mergiato su main (commit abc1234).", "comment", "service"],
  ["9", "system", "Il landing tocca il server: andrà live al prossimo reload del server.", "comment", "service"],
  ["10", "system", "Client ricostruito: la modifica è visibile (hard refresh se non appare).", "comment", "service"],
  ["11", "system", "**Checks pre-review verdi** su `abc`: ✓ `typecheck` (47.6s)", "comment", "service"],

  // ── Cambia cosa fai: resta parola ────────────────────────────────────────
  ["20", "system", "⚠️ Land ≠ consegna: il ramo è cambiato dopo l'approvazione.", "comment", "comment"],
  ["21", "system", "⚠️ Land NON confermato: il merge è uscito zero ma il commit NON risulta su main.", "comment", "comment"],
  ["22", "system", "**Checks pre-review ROSSI** su `abc`: ✗ `lint`", "comment", "comment"],
  ["23", "system", "**Checks pre-review NON MISURATI** su `abc`: `test:unit` è stato saltato.", "comment", "comment"],
  ["24", "system", "Il lavoro è su main, ma la card NON si chiude: restano 2 sottotask aperti.", "comment", "comment"],
  ["25", "system", "⚠️ Landato su main ma NON ancora attivo: il server gira da un checkout fermo.", "comment", "comment"],
  ["26", "system", "Il landing tocca desktop-tauri/: serve un rebuild dell'app.", "comment", "comment"],
  ["27", "system", "Build client fallita (exit 1). Lancia `bun run build:client` a mano.", "comment", "comment"],
  ["28", "system", "Budget dei tentativi finito (2/2): non riparte da solo.", "comment", "comment"],
  ["29", "system", "Errore del provider: riprovo tra 60s sulla stessa sessione.", "comment", "comment"],

  // ── Le due trappole: un umano che CITA, e una citazione a meta' riga ──────
  ["40", "user", "Non è su main: `abc1234` — ma secondo me ci sta lo stesso", "comment", "comment"],
  ["41", "system", "Ho letto «Non è su main: abc» e non sono d'accordo: guarda il merge.", "comment", "comment"],
  // ── E una review-note non e' contabilita': ha una sua ragione di esserci ──
  ["42", "system", "Non è su main: `zzz`", "review-note", "review-note"],
];

function db(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
    content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'comment')`);
  const ins = d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind) VALUES (?, 't', ?, ?, ?)");
  for (const [id, a, c, k] of CASI) ins.run(id, a, c, k);
  d.run(SQL);
  return d;
}

describe("le note di macchina gia' scritte diventano note di servizio", () => {
  test("la migration si legge e fa qualcosa (guardia contro un verde a vuoto)", () => {
    // Senza, un file svuotato renderebbe verdi tutti i casi «resta parola» e
    // rossi solo quelli che ripiegano: il modo piu' comune in cui un cancello
    // smette di guardare e' diventare metа' verde per caso.
    expect(SQL).toContain("UPDATE task_comments SET kind = 'service'");
    const d = db();
    const n = d.query("SELECT count(*) AS n FROM task_comments WHERE kind = 'service'").get() as { n: number };
    expect(n.n).toBeGreaterThan(5);
    d.close();
  });

  for (const [id, autore, testo, prima, dopo] of CASI) {
    const verso = prima === dopo ? "resta" : `${prima} → ${dopo}`;
    test(`[${verso}] ${autore}: ${testo.slice(0, 54)}`, () => {
      const d = db();
      const r = d.query("SELECT kind FROM task_comments WHERE id = ?").get(id) as { kind: string };
      expect(r.kind).toBe(dopo);
      d.close();
    });
  }
});
