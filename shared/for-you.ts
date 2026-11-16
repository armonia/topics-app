/**
 * «Per te»: the four lines every card in Review opens with, in plain words.
 * Written by the system (never by the agent that delivers) from the card's
 * description, delivery, comments and question.
 */
export interface ForYou {
  /** What the card asks of the person, one line; «Niente: va solo chiusa.» when nothing. */
  asked: string;
  /** What had happened. */
  happened: string;
  /** What was done. */
  done: string;
  /** What is left to the person. */
  remains: string;
  /** The choices as buttons, the recommended one first. May be empty. */
  options: string[];
}

/** Internal jargon that must never reach the person: card ids, hashes, paths, run numbers. */
const JARGON = [
  /\b[0-9a-f]{7,40}\b/i,
  /(^|\s)\/[\w.-]+\/[\w./-]+/,
  /\.(ts|tsx|js|json|md|sql)\b/i,
  /\bPR\s*#?\d+/i,
  /#\d{2,}/,
];

export function hasJargon(text: string): boolean {
  return JARGON.some((re) => re.test(text));
}

/** Parses the model answer into a ForYou, or null when it is not four usable lines. */
export function parseForYou(raw: string): ForYou | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const line = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const out: ForYou = {
    asked: line(d.asked), happened: line(d.happened), done: line(d.done), remains: line(d.remains),
    options: Array.isArray(d.options) ? d.options.map(line).filter(Boolean).slice(0, 4) : [],
  };
  if (!out.asked || !out.happened || !out.done || !out.remains) return null;
  if (hasJargon(`${out.asked} ${out.happened} ${out.done} ${out.remains} ${out.options.join(' ')}`)) return null;
  return out;
}
