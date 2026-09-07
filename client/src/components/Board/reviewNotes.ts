/**
 * Revisione riga-per-riga di un diff: numerazione delle righe del patch e
 * formato del commento che torna all'agente.
 *
 * Sta fuori dal componente perché è la parte che si può sbagliare in silenzio.
 * I numeri di riga NON sono l'indice della riga nel patch: vengono dagli header
 * `@@ -vecchia,n +nuova,m @@` e avanzano in modo diverso sui due lati (una riga
 * aggiunta non consuma il contatore vecchio, una rimossa non consuma il nuovo).
 * Un off-by-one qui manda l'agente a guardare la riga sbagliata, e nel commento
 * non si vede: il testo sembra sensato lo stesso.
 */

import type { DiffNote } from '../../lib/board';

export type { DiffNote };

/**
 * The caller's translate function. This module is pure (no React, no locale of
 * its own), so the words come in from whoever is rendering, the way
 * `taskActionError` already takes them.
 */
import type { Translate } from '../../../../shared/queue-reason-text';

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'nonewline'; // allow-italian: 'del' is a patch row kind, not a word a reader sees

export interface DiffRow {
  /** La riga del patch, marcatore incluso (`+`, `-`, ` `, `@@ …`). */
  raw: string;
  kind: DiffRowKind;
  /** Numero nel file PRIMA della modifica; null su una riga aggiunta. */
  oldLine: number | null;
  /** Numero nel file DOPO la modifica; null su una riga rimossa. */
  newLine: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Numera le righe di UN file del patch (il corpo prodotto da `splitPatch`).
 *
 * La distinzione meta/contenuto non si fa con una regex sul prefisso: una riga
 * RIMOSSA il cui contenuto inizia per `--` diventa `---…` nel patch e sarebbe
 * scambiata per l'header `---`. L'unica regola solida è posizionale — prima del
 * primo `@@` c'è solo intestazione, dopo c'è solo contenuto di hunk.
 */
export function parseDiffRows(body: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = body.split('\n');
  // Un patch finisce con newline: l'ultimo elemento dello split è '' e non è
  // una riga del file (una riga di contesto vuota nel patch è ' ', non '').
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const h = HUNK_RE.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      rows.push({ raw, kind: 'hunk', oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) {
      rows.push({ raw, kind: 'meta', oldLine: null, newLine: null });
      continue;
    }
    const c = raw[0];
    if (c === '+') rows.push({ raw, kind: 'add', oldLine: null, newLine: newNo++ });
    else if (c === '-') rows.push({ raw, kind: 'del', oldLine: oldNo++, newLine: null }); // allow-italian: 'del' is a patch row kind
    else if (c === '\\') rows.push({ raw, kind: 'nonewline', oldLine: null, newLine: null });
    else rows.push({ raw, kind: 'ctx', oldLine: oldNo++, newLine: newNo++ });
  }
  return rows;
}

/** Riga commentabile: le intestazioni e i marcatori non lo sono. */
export function isCommentable(row: DiffRow): boolean {
  return row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx'; // allow-italian: 'del' is a patch row kind
}

/** Ancora di una riga: il lato nuovo se esiste, altrimenti quello vecchio. */
export function anchorOf(row: DiffRow): { line: number; side: 'new' | 'old' } | null {
  if (row.newLine !== null) return { line: row.newLine, side: 'new' };
  if (row.oldLine !== null) return { line: row.oldLine, side: 'old' };
  return null;
}

/** Chiave stabile di una nota: una riga porta al massimo un thread aperto. */
export function noteKey(path: string, line: number, side: 'new' | 'old'): string {
  return `${path}:${side}:${line}`;
}

/**
 * Recinto lungo abbastanza da contenere il codice citato: una riga che contiene
 * ``` spezzerebbe un fence da tre e il commento arriverebbe sfondato.
 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Il commento unico che porta le note all'agente.
 *
 * Una nota per volta sarebbe un resume per nota: ogni commento su un task in
 * review fa reject-with-text e ri-sveglia l'agente (`server/routes/tasks.ts`),
 * quindi N note = N risvegli e N turni sprecati. Le note si accumulano come una
 * review in sospeso e partono insieme, ordinate per file e per riga — l'ordine
 * in cui uno legge il diff, non quello in cui ha cliccato.
 */
export function formatReviewNotes(notes: DiffNote[], tr: Translate): string {
  const sorted = [...notes].sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path));
  const files = new Set(sorted.map((n) => n.path)).size;
  const head = tr(sorted.length === 1 ? 'board.reviewNotes.head.one' : 'board.reviewNotes.head.many', { n: sorted.length, files });
  const blocks = sorted.map((n) => {
    const where = n.side === 'old' ? ` ${tr('board.reviewNotes.removedLine')}` : '';
    const fence = fenceFor(n.code);
    return [
      `**\`${n.path}:${n.line}\`**${where}`,
      `${fence}diff`,
      n.code,
      fence,
      n.body.trim(),
    ].join('\n');
  });
  return [
    head,
    ...blocks,
    tr('board.reviewNotes.footer'),
  ].join('\n\n');
}
