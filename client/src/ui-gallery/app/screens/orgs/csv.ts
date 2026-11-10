/** The byte-order mark that makes spreadsheets read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Hands a CSV to the browser as a download, from a data: address (nothing leaves the page). */
export function downloadCsv(name: string, lines: string[][]) {
  const escapeCell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = lines.map((l) => l.map(escapeCell).join(';')).join('\n');
  const link = document.createElement('a');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(BOM + text)}`;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
