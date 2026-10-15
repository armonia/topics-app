export type VirtualRow<T> = { item: T; top: number; height: number };

export function layoutVirtualRows<T extends { id: string }>(items: readonly T[], heights: ReadonlyMap<string, number>, estimate: number, gap: number): { rows: VirtualRow<T>[]; totalHeight: number } {
  const rows: VirtualRow<T>[] = [];
  let top = 0;
  for (const item of items) {
    const height = heights.get(item.id) ?? estimate;
    rows.push({ item, top, height });
    top += height + gap;
  }
  return { rows, totalHeight: Math.max(0, top - (rows.length ? gap : 0)) };
}

export function visibleVirtualIds<T extends { id: string }>(rows: readonly VirtualRow<T>[], top: number, height: number, overscan: number, pinnedId?: string | null): Set<string> {
  const from = Math.max(0, top - overscan);
  const to = top + height + overscan;
  let start = rows.findIndex((row) => row.top + row.height >= from);
  if (start < 0) start = Math.max(0, rows.length - 1);
  let end = start;
  while (end + 1 < rows.length && rows[end + 1]!.top <= to) end += 1;
  const visible = new Set(rows.slice(start, end + 1).map((row) => row.item.id));
  if (pinnedId) visible.add(pinnedId);
  return visible;
}
