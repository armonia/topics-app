#!/usr/bin/env bun
/**
 * COMPRIMERE LE RIGHE CHE IL CODEC NON HA MAI VISTO.
 *
 * PERCHE' ESISTE. `shared/message-blob.ts` comprime `blocks` e `tool_calls` con
 * zstd da quando e' stato scritto, e ogni lettore passa gia' da `decodeCol`
 * (verificato: tutti e cinque i file che fanno SELECT su quelle colonne). Ma il
 * codec agisce in SCRITTURA, quindi ha toccato solo le righe scritte dopo di
 * lui. Misurato sul DB di produzione il 2026-08-19:
 *
 *     blocks      273 righe compresse (4 MB)  ·  4.131 in chiaro (481 MB)
 *     tool_calls  291 righe compresse (4 MB)  ·  8.762 in chiaro (288 MB)
 *
 * Cioe' **769 MB in chiaro contro 8 compressi**, su un file da 888 MB. Il
 * rapporto non e' quello dichiarato ma quello misurato su un campione casuale
 * di 440 colonne vere: **4,99x**, che su quei 769 MB vale **~615 MB**.
 *
 * PERCHE' NON UNA MIGRATION SQL. zstd non esiste in SQLite, e il watcher di
 * `start-prod.sh` applica un file `server/db/migrations/*.sql` al DB VIVO in
 * pochi secondi (lo dice CLAUDE.md). Un lavoro da 13.000 righe e centinaia di
 * megabyte non va fatto da un hook che parte al salvataggio: va fatto quando
 * qualcuno lo chiede, a lotti, potendolo fermare.
 *
 * COSA GARANTISCE, e come. Ogni riga viene riletta e confrontata PRIMA di
 * essere sostituita: se `decodeCol(encodeCol(x)) !== x` la riga si salta e si
 * conta. Non e' paranoia — e' l'unica cosa che distingue «ho compresso» da «ho
 * perso i messaggi di qualcuno», e qui si sta riscrivendo la tabella che
 * contiene le conversazioni.
 *
 *   bun run scripts/compress-message-blobs.ts --dry-run   quanto renderebbe
 *   bun run scripts/compress-message-blobs.ts             lo fa, a lotti
 *   bun run scripts/compress-message-blobs.ts --limit 500 solo N righe
 *
 * IL BACKUP E' TUO. Lo script non lo fa e lo dice: `data/topics.db` piu' il suo
 * `-wal` vanno copiati prima, a server fermo o subito dopo un checkpoint.
 * `--dry-run` non scrive niente ed e' il modo di guardare senza rischiare.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodeCol, decodeCol } from "../shared/message-blob";

const DRY = process.argv.includes("--dry-run");
const iLimite = process.argv.indexOf("--limit");
const LIMITE = iLimite >= 0 ? Number(process.argv[iLimite + 1]) : Infinity;
const iDb = process.argv.indexOf("--db");
const DB_PATH = iDb >= 0 ? process.argv[iDb + 1]! : join(import.meta.dir, "..", "data", "topics.db");

/** Sotto questa soglia `encodeCol` non comprime: chiederglielo sarebbe inutile. */
const SOGLIA = 512;
/** Righe per transazione. Abbastanza grande da non pagare un fsync a riga,
 *  abbastanza piccolo da non tenere il lock di scrittura per minuti — questo DB
 *  serve un server vivo. */
const LOTTO = 200;

if (!existsSync(DB_PATH)) {
  console.error(`[compress] nessun database in ${DB_PATH}`);
  process.exit(2);
}

const db = DRY ? new Database(DB_PATH, { readonly: true }) : new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 15000");

const mb = (n: number) => (n / 1048576).toFixed(1);

/** Le righe che hanno almeno una colonna in chiaro sopra soglia. */
const SELEZIONE = `
  SELECT id, blocks, tool_calls FROM messages
  WHERE (typeof(blocks) = 'text' AND length(blocks) > ${SOGLIA})
     OR (typeof(tool_calls) = 'text' AND length(tool_calls) > ${SOGLIA})
`;

const { n: daFare } = db.query(`SELECT count(*) AS n FROM (${SELEZIONE})`).get() as { n: number };
console.log(`[compress] ${daFare} righe da comprimere in ${DB_PATH}${DRY ? "  (DRY RUN: non scrivo niente)" : ""}`);
if (daFare === 0) process.exit(0);

const aggiorna = DRY ? null : db.prepare(`UPDATE messages SET blocks = ?, tool_calls = ? WHERE id = ?`);

let viste = 0, riscritte = 0, saltate = 0, prima = 0, dopo = 0;
let lotto: Array<{ id: string; b: string | Uint8Array | null; t: string | Uint8Array | null }> = [];

const writeBatch = (): void => {
  if (DRY || lotto.length === 0) { lotto = []; return; }
  db.transaction(() => {
    for (const r of lotto) aggiorna!.run(r.b as never, r.t as never, r.id);
  })();
  lotto = [];
};

for (const riga of db.query(SELEZIONE).iterate() as Iterable<{ id: string; blocks: unknown; tool_calls: unknown }>) {
  if (viste >= LIMITE) break;
  viste++;

  const nuovi: Array<string | Uint8Array | null> = [];
  let rowOk = true;

  for (const col of [riga.blocks, riga.tool_calls]) {
    if (typeof col !== "string" || col.length <= SOGLIA) { nuovi.push(col as string | null); continue; }
    const compresso = encodeCol(col);
    // IL CONTROLLO CHE RENDE QUESTO SCRIPT DIVERSO DA UN UPDATE. Si rilegge
    // cio' che si sta per scrivere: se non torna identico, la riga resta com'e'.
    if (typeof compresso === "string" || compresso == null || decodeCol(compresso) !== col) {
      rowOk = false;
      break;
    }
    prima += Buffer.byteLength(col, "utf8");
    dopo += compresso.length;
    nuovi.push(compresso);
  }

  if (!rowOk) { saltate++; continue; }
  lotto.push({ id: riga.id, b: nuovi[0] ?? null, t: nuovi[1] ?? null });
  riscritte++;
  if (lotto.length >= LOTTO) {
    writeBatch();
    if (riscritte % 2000 === 0) console.log(`[compress] ${riscritte}/${daFare}…`);
  }
}
writeBatch();

const rapporto = dopo > 0 ? prima / dopo : 0;
console.log(
  `[compress] ${riscritte} righe ${DRY ? "comprimibili" : "riscritte"}` +
  (saltate > 0 ? `, ${saltate} SALTATE (il giro di ritorno non era identico)` : "") +
  `\n[compress] ${mb(prima)} MB → ${mb(dopo)} MB  (${rapporto.toFixed(2)}x, ${mb(prima - dopo)} MB risparmiati)`,
);

if (DRY) {
  console.log("[compress] dry run: niente e' stato scritto. Rilancia senza --dry-run — e fai prima il backup di data/topics.db e del suo -wal.");
} else {
  // Il file NON si restringe da solo: SQLite libera le pagine dentro il file e
  // le riusa. `VACUUM` le restituisce al filesystem, ma riscrive l'intero
  // database e vuole spazio libero pari alla sua taglia, quindi lo si nomina
  // invece di farlo di nascosto su un DB che un server sta usando.
  console.log("[compress] le pagine liberate restano DENTRO il file: per restituirle al disco serve `sqlite3 data/topics.db VACUUM;` a server fermo.");
}
