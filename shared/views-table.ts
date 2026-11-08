/**
 * The `table` view (GENUI-06): rows of the same kind read across columns, such
 * as train departures, flights of a day or price quotes. `compare` is for 2-4
 * things to CHOOSE between with photos and arguments; a table is for more rows
 * and fewer words.
 *
 * A column may say which direction wins (`better`): its numeric cells are then
 * ranked like the metrics of `compare`, so the fastest train is marked without
 * the agent saying it in prose.
 */
import { z } from 'zod/mini';
import { asRecord, linkOf, str, MAX_TITLE } from './views-util';

export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 40;

const columnSchema = z.object({
  label: z.string(),
  unit: z.optional(z.string()),
  align: z.optional(z.enum(['start', 'end'])),
  better: z.optional(z.enum(['lower', 'higher'])),
  // How a NUMBER cell reads: minutes as "3 h 19", or an amount in `unit`
  // (an ISO currency, default EUR). Numbers stay numbers so they still rank.
  format: z.optional(z.enum(['duration', 'price'])),
});

const cellSchema = z.union([z.string(), z.number(), z.null()]);

const rowSchema = z.object({
  cells: z.array(cellSchema),
  note: z.optional(z.string()),
  recommended: z.optional(z.boolean()),
  link: z.optional(z.object({ url: z.string(), label: z.optional(z.string()) })),
});

export const tableViewSchema = z.object({
  view: z.literal('table'),
  title: z.string(),
  subtitle: z.optional(z.string()),
  verdict: z.optional(z.string()),
  columns: z.array(columnSchema),
  rows: z.array(rowSchema),
  footnote: z.optional(z.string()),
});

export type TableColumn = z.infer<typeof columnSchema>;
export type TableCell = z.infer<typeof cellSchema>;
export type TableRow = z.infer<typeof rowSchema>;
export type TableViewSpec = z.infer<typeof tableViewSchema>;

function cellOf(v: unknown): TableCell {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return str(v, 120) ?? null;
}

export function normalizeTable(raw: Record<string, unknown>, errors: string[]): TableViewSpec | null {
  const title = str(raw.title, MAX_TITLE);
  if (!title) errors.push("'title' (string) is required");
  const rawCols = Array.isArray(raw.columns) ? raw.columns : [];
  if (rawCols.length < 1 || rawCols.length > TABLE_MAX_COLUMNS) {
    errors.push(`'columns' must have 1-${TABLE_MAX_COLUMNS} items (got ${rawCols.length})`);
  }
  const columns: TableColumn[] = [];
  rawCols.slice(0, TABLE_MAX_COLUMNS).forEach((c, i) => {
    // A bare string is the common shorthand for a column.
    const r = typeof c === 'string' ? { label: c } : asRecord(c);
    const label = str(r.label, 40);
    if (!label) { errors.push(`columns[${i}].label (string) is required`); return; }
    const col: TableColumn = { label };
    const unit = str(r.unit, 12);
    if (unit) col.unit = unit;
    if (r.align === 'start' || r.align === 'end') col.align = r.align;
    if (r.better === 'lower' || r.better === 'higher') col.better = r.better;
    if (r.format === 'duration' || r.format === 'price') col.format = r.format;
    columns.push(col);
  });
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  if (rawRows.length < 1 || rawRows.length > TABLE_MAX_ROWS) {
    errors.push(`'rows' must have 1-${TABLE_MAX_ROWS} items (got ${rawRows.length})`);
  }
  const rows: TableRow[] = [];
  rawRows.slice(0, TABLE_MAX_ROWS).forEach((rw, i) => {
    // A row is `{cells: [...]}` or the bare array of cells.
    const r: Record<string, unknown> = Array.isArray(rw) ? { cells: rw } : asRecord(rw);
    const rawCells: unknown = r.cells;
    if (!Array.isArray(rawCells)) { errors.push(`rows[${i}].cells (array) is required`); return; }
    if (rawCells.length > columns.length) {
      errors.push(`rows[${i}] has ${rawCells.length} cells for ${columns.length} columns`);
      return;
    }
    // A short row is padded: a missing value is shown as such, not shifted.
    const cells = columns.map((_, j) => cellOf(rawCells[j]));
    const row: TableRow = { cells };
    const note = str(r.note, 160);
    if (note) row.note = note;
    if (r.recommended === true) row.recommended = true;
    const link = linkOf(r.link ?? r.url);
    if (link) row.link = link;
    rows.push(row);
  });
  const recommendedRows = rows.filter((r) => r.recommended).length;
  if (recommendedRows > 1) errors.push(`at most one row may be 'recommended' (got ${recommendedRows})`);
  if (errors.length || !title) return null;
  // A column whose cells are all numbers aligns to the end, unless told otherwise.
  columns.forEach((col, j) => {
    if (col.align) return;
    const vals = rows.map((r) => r.cells[j]).filter((v) => v !== null);
    if (vals.length && vals.every((v) => typeof v === 'number')) col.align = 'end';
  });
  const spec: TableViewSpec = { view: 'table', title, columns, rows };
  const subtitle = str(raw.subtitle);
  if (subtitle) spec.subtitle = subtitle;
  const verdict = str(raw.verdict);
  if (verdict) spec.verdict = verdict;
  const footnote = str(raw.footnote);
  if (footnote) spec.footnote = footnote;
  return spec;
}

export type CellRank = 'best' | 'worst' | undefined;

/**
 * `ranks[row][col]`: best or worst numeric value of a column that has
 * `better`. Needs two numbers that differ; ties share the rank. Pure.
 */
export function rankColumns(spec: Pick<TableViewSpec, 'columns' | 'rows'>): CellRank[][] {
  const ranks: CellRank[][] = spec.rows.map(() => spec.columns.map(() => undefined));
  spec.columns.forEach((col, j) => {
    if (!col.better) return;
    const nums = spec.rows.map((r) => r.cells[j]).filter((v): v is number => typeof v === 'number');
    if (nums.length < 2) return;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min === max) return;
    const best = col.better === 'lower' ? min : max;
    const worst = col.better === 'lower' ? max : min;
    spec.rows.forEach((r, i) => {
      const v = r.cells[j];
      if (v === best) ranks[i][j] = 'best';
      else if (v === worst) ranks[i][j] = 'worst';
    });
  });
  return ranks;
}
