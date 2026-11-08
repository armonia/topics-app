/**
 * How a view's values read, for both renderers (the client's components and
 * the server's MCP Apps page): a price, minutes, a table cell. One copy, so the
 * chat and an external host never format the same number two ways.
 */
import type { TableCell, TableColumn } from './views-table';
import type { ViewPrice } from './views-util';

export function formatPrice(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    // An unknown currency code is still a price: show the code after it.
    return `${amount} ${currency}`;
  }
}

/** A price with what it covers: "9,25 € a bordo". */
export function formatPriceNote(price: ViewPrice, locale: string): string {
  const p = formatPrice(price.amount, price.currency, locale);
  return price.note ? `${p} ${price.note}` : p;
}

/** Minutes as people read them: 45 min, 3 h, 3 h 19. */
export function formatMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}

/** The text of a table cell, or null when the value is missing. */
export function cellText(v: TableCell, col: TableColumn, locale: string): string | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (col.format === 'duration') return formatMinutes(v);
    if (col.format === 'price') return formatPrice(v, col.unit ?? 'EUR', locale);
    const n = new Intl.NumberFormat(locale).format(v);
    return col.unit ? `${n} ${col.unit}` : n;
  }
  return col.unit && col.format !== 'price' ? `${v} ${col.unit}` : v;
}
