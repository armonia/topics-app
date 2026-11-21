/** The tool result parsed as JSON, or undefined when it is plain text. */
export function parseJsonResult(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
