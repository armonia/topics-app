/**
 * Bonifica del verdetto: `20260818120000-timeout-is-not-a-red.sql`.
 *
 * ── Cosa chiude ─────────────────────────────────────────────────────────────
 * `recordChecks` scriveva `ok ? "pass" : "fail"`, quindi un comando SCADUTO al
 * tetto dei 20 minuti finiva marcato rosso. Il TESTO del commento faceva gia' la
 * distinzione dal 12/08 («**Checks pre-review NON MISURATI**»), e il suo test si
 * chiudeva con «la parola conta piu' del codice di stato» — ma la card legge lo
 * STATO, perche' `checks_json` non viaggia nel payload della lista (pesava
 * 217 KB), e lo stato diceva rosso lo stesso.
 *
 * Misurato il 18/08 sul DB vivo: delle 15 card con `checks_state = 'fail'`, SEI
 * portavano solo comandi scaduti. Il 40% delle bocciature accusava un codice
 * sano, e chi rivedeva leggeva «checks rossi».
 *
 * ── Cosa conta: il verso in cui sbaglia ─────────────────────────────────────
 * Verso il ROSSO, sempre. Se il JSON manca, e' illeggibile, o contiene anche un
 * solo fallimento con un exit code vero (o uno `spawnError`), la riga non si
 * tocca. Meglio un rosso di troppo — si apre la card e si scopre che era un
 * timeout — che un rosso tolto a una consegna davvero rotta.
 *
 * L'ultimo caso qui sotto e' la trappola vera: un comando rosso il cui OUTPUT
 * contiene letteralmente la stringa `"ok":false`. Il predicato lavora su un
 * LIKE, quindi quella coda potrebbe ingannarlo — e il test esiste per dire che
 * non lo fa.
 *
 * Il test esegue il FILE della migration, non una sua copia.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(import.meta.dir, "../../server/db/migrations/20260818120000-timeout-is-not-a-red.sql"),
  "utf8",
);

/** Un run serializzato come lo scrive `JSON.stringify` — senza spazi. */
function run(name: string, code: number | null, timedOut: boolean, spawnError?: string, tail = "") {
  const r: Record<string, unknown> = {
    name, cmd: name, ok: code === 0 && !timedOut && !spawnError, code, ms: 1, timedOut, tail,
  };
  if (spawnError) r.spawnError = spawnError;
  return r;
}

/** [id, stato di partenza, runs (null = colonna vuota), stato atteso]. */
const CASI: [string, string, Record<string, unknown>[] | null, string][] = [
  ["solo-scaduto", "fail", [run("typecheck", 0, false), run("test:unit", null, true)], "unknown"],
  ["scaduto-unico", "fail", [run("test:unit", null, true)], "unknown"],
  // ── Restano rosse, ed e' il punto ────────────────────────────────────────
  ["rosso-vero", "fail", [run("lint", 2, false)], "fail"],
  ["rosso-e-scaduto", "fail", [run("lint", 2, false), run("test:unit", null, true)], "fail"],
  ["mai-partito", "fail", [run("e2e", null, false, "ENOENT")], "fail"],
  ["senza-json", "fail", null, "fail"],
  // ── Il verde non si tocca ────────────────────────────────────────────────
  ["verde", "pass", [run("typecheck", 0, false)], "pass"],
  // ── LA TRAPPOLA: la coda dell'output cita la stringa che il LIKE cerca ───
  ["coda-bugiarda", "fail", [run("lint", 2, false, undefined, 'atteso {"ok":false,"code":1}')], "fail"],
];

function db(): Database {
  const d = new Database(":memory:");
  d.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, checks_state TEXT, checks_json TEXT)");
  const ins = d.prepare("INSERT INTO tasks (id, checks_state, checks_json) VALUES (?, ?, ?)");
  for (const [id, stato, runs] of CASI) ins.run(id, stato, runs ? JSON.stringify(runs) : null);
  d.run(SQL);
  return d;
}

describe("uno SCADUTO non e' un rosso, nemmeno nello storico", () => {
  test("la migration fa qualcosa (guardia contro un verde a vuoto)", () => {
    // Senza, un file svuotato renderebbe verdi tutti i casi «resta rossa» e
    // rossi solo i due che cambiano: mezza guardia per caso.
    expect(SQL).toContain("checks_state = 'unknown'");
    const d = db();
    const n = d.query("SELECT count(*) AS n FROM tasks WHERE checks_state = 'unknown'").get() as { n: number };
    expect(n.n).toBe(2);
    d.close();
  });

  for (const [id, prima, , dopo] of CASI) {
    test(`[${prima === dopo ? "resta " + dopo : `${prima} → ${dopo}`}] ${id}`, () => {
      const d = db();
      const r = d.query("SELECT checks_state FROM tasks WHERE id = ?").get(id) as { checks_state: string };
      expect(r.checks_state).toBe(dopo);
      d.close();
    });
  }
});
