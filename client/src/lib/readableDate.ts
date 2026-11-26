/** "today 11:48" / "yesterday 11:48" / "21 Nov 11:48" for an ISO timestamp, in the reader's locale. */
export function readableDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const localeTag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
  const time = d.toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (days === 0 || days === -1) {
    const word = new Intl.RelativeTimeFormat(localeTag, { numeric: 'auto' }).format(days, 'day');
    return `${word} ${time}`;
  }
  const date = d.toLocaleDateString(localeTag, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) });
  return `${date} ${time}`;
}
