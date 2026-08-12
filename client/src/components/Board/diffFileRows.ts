/**
 * L'elenco dei file di un diff: quali righe disegnare, in che ordine, e cosa si
 * sa di ognuna.
 *
 * Sta fuori dal componente perché è la parte che si può interrogare senza
 * montare niente — ed è la parte dove stava il difetto: la lista si costruiva
 * spezzando il PATCH, che il server tronca a ~200 KB. Oltre quel tetto i file
 * non sparivano solo dal testo, sparivano anche dal conto: un diff da 40 file si
 * presentava come 12, senza dirlo. Lo stat, invece, è completo per contratto
 * (`--numstat` non ha tetto), quindi è lo stat a comandare l'elenco.
 */

import type { DiffBundle, DiffFileStat } from '../../lib/board';

/**
 * Il pezzo di patch di UN file. Si chiama così e non `FileChunk` perché quel
 * nome è già preso dal lato server (`lib/commit-message.ts`, che spezza un diff
 * per comporre il messaggio di un commit): stessa idea, altra forma (`text` là,
 * `body` qui) e nessun filo fra le due — e un tipo omonimo sui due lati è quello
 * che il cricchetto di `tests/unit/no-type-mirrors.test.ts` esiste per fermare.
 */
export interface DiffFileChunk {
  /** Path `b/` dall'intestazione `diff --git`. */
  path: string;
  body: string;
}

export interface FileRow {
  path: string;
  stat?: DiffFileStat;
  /** Assente = il patch di questo file non è arrivato (tetto del payload). */
  chunk?: DiffFileChunk;
  /** Il pezzo c'è ma è TAGLIATO a metà: è l'ultimo di un patch troncato. */
  partial?: boolean;
}

/** Spezza un patch nei suoi pezzi per file, indicizzati sul path di destinazione. */
export function splitPatch(patch: string): DiffFileChunk[] {
  if (!patch.trim()) return [];
  const out: DiffFileChunk[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      if (cur) out.push({ path: cur.path, body: cur.lines.join('\n') });
      cur = { path: m[2], lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ path: cur.path, body: cur.lines.join('\n') });
  return out;
}

/**
 * Le righe da disegnare: lo STAT comanda, il patch riempie.
 *
 * Ogni file dello stat compare ANCHE senza il suo pezzo di patch — con il
 * conteggio giusto e un cartello al posto delle righe. Chi ha un pezzo e nessuna
 * riga di stat (non dovrebbe capitare, ma il patch è la fonte del CONTENUTO)
 * resta in coda: mai perso.
 */
export function buildFileRows(bundle: Pick<DiffBundle, 'stat' | 'patch' | 'truncated'>): FileRow[] {
  const chunks = splitPatch(bundle.patch);
  const byPath = new Map(chunks.map((c, i) => [c.path, { chunk: c, i }]));
  // L'ULTIMO pezzo di un patch troncato è tagliato a metà riga: dirlo, invece di
  // farlo sembrare un file che finisce lì.
  const cutAt = bundle.truncated ? chunks.length - 1 : -1;
  const rows: FileRow[] = [];
  const seen = new Set<string>();
  for (const s of bundle.stat) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    const hit = byPath.get(s.path);
    rows.push({ path: s.path, stat: s, chunk: hit?.chunk, partial: !!hit && hit.i === cutAt });
  }
  for (const [i, c] of chunks.entries()) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    rows.push({ path: c.path, chunk: c, partial: i === cutAt });
  }
  return rows;
}
