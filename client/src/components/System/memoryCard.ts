/**
 * What a memory card says about itself, read off its text: the front matter
 * (`type`, and a date under `date`, `updated` or `created`) and the links to
 * other cards (`[[name]]`). Pure, so the card view and its test share it.
 */
export interface ParsedCard {
  type: string;
  date: string | null;
  links: string[];
  body: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DATE_KEYS = ['date', 'updated', 'created'];

export function parseCard(content: string): ParsedCard {
  const front = FRONT.exec(content);
  const fields = new Map<string, string>();
  for (const line of (front?.[1] ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const body = front ? content.slice(front[0].length) : content;
  const links = [...new Set([...body.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1]!.trim()))];
  const dateKey = DATE_KEYS.find((k) => fields.get(k));
  return { type: fields.get('type') ?? '', date: dateKey ? fields.get(dateKey)! : null, links, body };
}
