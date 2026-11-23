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

const encodePath = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-');
const lastSegment = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

/**
 * The name a store goes by: `agent:<id>` is that agent's name, `project:<slug>`
 * the name of the project whose folder the slug encodes (Claude Code writes a
 * path with every non-alphanumeric character as `-`). Without a match the id
 * stays, minus its prefix.
 */
export function storeLabel(storeId: string, agents: { id: string; name: string }[], projects: { name: string; path: string }[]): string {
  const colon = storeId.indexOf(':');
  const kind = storeId.slice(0, colon);
  const key = storeId.slice(colon + 1);
  if (kind === 'agent') return agents.find((a) => a.id === key)?.name || key;
  if (kind === 'project') return projects.find((p) => encodePath(p.path) === key || lastSegment(p.path) === key)?.name || key;
  return storeId;
}
