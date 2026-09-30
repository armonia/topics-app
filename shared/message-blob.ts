/**
 * Codec per le colonne pesanti di `messages`: `blocks` e `tool_calls`.
 *
 * Due funzioni simmetriche:
 *
 * - `encodeCol(s)` comprime la stringa con zstd livello 3 se supera 512 byte,
 *   altrimenti la lascia invariata. Sotto soglia il codec non aggiunge overhead.
 *
 * - `decodeCol(v)` trasparente: se `v` e' una stringa la restituisce
 *   identica (DB in chiaro, nessun costo). Se e' un Buffer/Uint8Array la
 *   decomprime. Se e' null/undefined restituisce null.
 *
 * Nessuna migration di schema: l'affinity TEXT di SQLite accetta un BLOB e lo
 * conserva come BLOB. Testo e BLOB coesistono nella stessa colonna.
 *
 * Su un DB reale (707 MB, 16 k righe) zstd livello 3 porta blocks+tool_calls
 * da 618 MB a 104 MB (5,42x). La funzione e' l'identita' sui dati in chiaro:
 * abilitare decodeCol su tutti i lettori non cambia il comportamento finche'
 * il DB non viene compresso.
 */

import { MACHINE_ROW_KINDS } from "./prompt-number";

const COMPRESS_THRESHOLD = 512;

/**
 * A machine mark exactly as `JSON.stringify` writes it into `blocks`: the same
 * text `MACHINE_ROW_SQL` looks for with `LIKE`.
 */
const MACHINE_MARKS = MACHINE_ROW_KINDS.map((k) => `"kind":"${k}"`);

/**
 * Comprime `s` se supera la soglia, altrimenti la restituisce invariata.
 * Accetta `null`/`undefined` e li lascia passare.
 *
 * A row that carries a machine mark stays plain text at any size. Two readers
 * find those marks with `LIKE` on the raw column, which cannot see inside a
 * zstd blob: `MACHINE_ROW_SQL` (history numbering, resume, sidebar previews)
 * and the "already delivered" probe of `pendingHumanReopen`, which looks for
 * comment ids inside the `dispatched-envelope` block. An envelope carrying 12
 * comment ids is 515 bytes, got compressed, and disappeared from both.
 */
export function encodeCol(s: string | null | undefined): string | Uint8Array | null | undefined {
  if (s == null) return s;
  if (s.length < COMPRESS_THRESHOLD) return s;
  if (MACHINE_MARKS.some((m) => s.includes(m))) return s;
  return Bun.zstdCompressSync(Buffer.from(s, "utf8"), { level: 3 });
}

/**
 * Decomprime `v` se e' un Buffer/Uint8Array, restituisce `v` se e' una
 * stringa, `null` se nullo/undefined.
 *
 * Idempotente su stringhe: chiamarla su un DB in chiaro non cambia niente.
 */
export function decodeCol(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  // Buffer da SQLite: Uint8Array o Buffer
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    return Buffer.from(Bun.zstdDecompressSync(v)).toString("utf8");
  }
  // Forma inattesa: trattiamo come stringa per sicurezza
  return String(v);
}
