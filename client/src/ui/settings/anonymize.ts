/**
 * The anonymizer of the preview, as a pure function: the same text always
 * gives the same placeholders (the same person is always PERSONA_1), so the
 * «Prova» of Settings shows what the real one does. Fiscal code, VAT number (allow-italian: quotes the Italian interface)
 * and IBAN are recognised by their check character, not by their shape, so a
 * sixteen-letter word is left alone. Names come from a list of Italian first
 * names and titles; the real service uses a trained model for them.
 */

export type AnonCategory = 'fiscal-code' | 'vat-iban' | 'names' | 'contacts';

/** What a detected piece is, which decides its placeholder (`PERSONA_1`). */
export type AnonKind = 'CF' | 'PIVA' | 'IBAN' | 'PERSONA' | 'AVVOCATO' | 'AZIENDA' | 'INDIRIZZO' | 'CONTATTO' | 'TERMINE';

export const ANON_CATEGORIES: AnonCategory[] = ['fiscal-code', 'vat-iban', 'names', 'contacts'];

export const KIND_CATEGORY: Record<AnonKind, AnonCategory | 'custom'> = {
  CF: 'fiscal-code',
  PIVA: 'vat-iban',
  IBAN: 'vat-iban',
  PERSONA: 'names',
  AVVOCATO: 'names',
  AZIENDA: 'names',
  INDIRIZZO: 'contacts',
  CONTATTO: 'contacts',
  TERMINE: 'custom',
};

/** A run of the text: plain, or a detected value with its placeholder. */
export interface AnonSegment {
  text: string;
  kind?: AnonKind;
  /** `PERSONA_1`; set on every detected value, also when its category is off. */
  token?: string;
  /** Whether the value is replaced: false when its category is switched off. */
  masked?: boolean;
}

export interface AnonEntry {
  token: string;
  kind: AnonKind;
  value: string;
  masked: boolean;
}

export interface AnonResult {
  segments: AnonSegment[];
  /** What leaves for the AI: placeholders in place of the masked values. */
  sent: string;
  /** The correspondence table, in order of first appearance. Never leaves the server. */
  table: AnonEntry[];
  /** Masked values per category (custom terms count under `names`'s sibling `custom`). */
  counts: Record<AnonCategory | 'custom', number>;
}

const FIRST_NAMES = [
  'Mario', 'Luigi', 'Gianni', 'Giuseppe', 'Antonio', 'Francesco', 'Salvatore', 'Carmine', 'Vincenzo', 'Raffaele',
  'Gennaro', 'Pasquale', 'Michele', 'Angelo', 'Luca', 'Marco', 'Paolo', 'Andrea', 'Roberto', 'Stefano', 'Alberto',
  'Maria', 'Anna', 'Giulia', 'Francesca', 'Rosa', 'Carmela', 'Lucia', 'Angela', 'Giuseppina', 'Concetta', 'Teresa',
  'Elena', 'Sara', 'Chiara', 'Paola', 'Laura', 'Silvia', 'Antonietta', 'Filomena', 'Assunta', 'Immacolata', // allow-italian: Italian names and legal forms the recognisers match
];

const NAME_WORD = "[A-ZÀ-Ý][\\p{L}'’]+"; // allow-italian: Italian names and legal forms the recognisers match
const PARTICLE = "(?:(?:de|di|del|della|dei|degli|d'|De|Di|Del|Della)\\s*)?"; // allow-italian: Italian names and legal forms the recognisers match
const FULL_NAME = `${NAME_WORD}(?:\\s+${PARTICLE}${NAME_WORD}){0,2}`;
const COMPANY_FORM = '(?:S\\.r\\.l\\.|S\\.p\\.A\\.|S\\.n\\.c\\.|S\\.a\\.s\\.)';

interface Detector {
  kind: AnonKind;
  re: RegExp;
  valid?: (s: string) => boolean;
}

/* Fiscal code check character (D.M. 23/12/1976). */
const ODD: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

export function isFiscalCode(raw: string): boolean {
  const c = raw.toUpperCase();
  if (c.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = c[i];
    sum += i % 2 === 0 ? (ODD[ch] ?? 0) : /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === c[15];
}

/* Italian VAT number: Luhn variant on 11 digits. */
export function isVatNumber(raw: string): boolean {
  if (!/^\d{11}$/.test(raw)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = Number(raw[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(raw[10]);
}

/* IBAN: mod 97 on the rearranged digits. */
export function isIban(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length !== 27) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const part = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of part) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/* Ordered by priority: when two detectors overlap, the earlier one wins. */
const DETECTORS: Detector[] = [
  { kind: 'IBAN', re: /\bIT\d{2}(?:\s?[A-Z0-9]{4}){5}\s?[A-Z0-9]{3}\b/g, valid: isIban },
  { kind: 'CF', re: /\b[A-Za-z]{6}\d{2}[A-EHLMPRSTa-ehlmprst]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/g, valid: isFiscalCode },
  { kind: 'PIVA', re: /\b\d{11}\b/g, valid: isVatNumber },
  { kind: 'CONTATTO', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: 'CONTATTO', re: /(?<![\d/.,-])(?:\+39[\s.]?)?\b(?:3\d{2}[\s.]?\d{3}[\s.]?\d{3,4}|0[1-9]\d{0,2}[\s./-]?\d{5,8})\b/g },
  {
    kind: 'INDIRIZZO',
    re: new RegExp(`\\b(?:[Vv]ia|[Vv]iale|[Pp]iazza|[Cc]orso|[Vv]icolo|[Ll]argo|[Cc]ontrada)\\s+${PARTICLE}${NAME_WORD}(?:\\s+${PARTICLE}${NAME_WORD})*(?:,?\\s+\\d+[A-Za-z]?)?`, 'gu'),
  },
  { kind: 'AVVOCATO', re: new RegExp(`\\b(?:[Aa]vv\\.|[Aa]vvocato)\\s+${FULL_NAME}`, 'gu') },
  {
    kind: 'AZIENDA',
    re: new RegExp(`\\b(?:[Aa]zienda [Aa]gricola|[Ss]ociet[àa] [Aa]gricola|[Dd]itta|[Ii]mpresa|[Cc]ooperativa)\\s+${NAME_WORD}(?:\\s+${NAME_WORD})*(?:\\s+${COMPANY_FORM})?`, 'gu'), // allow-italian: Italian names and legal forms the recognisers match
  },
  { kind: 'AZIENDA', re: new RegExp(`\\b${NAME_WORD}(?:\\s+${NAME_WORD})*\\s+${COMPANY_FORM}`, 'gu') },
  { kind: 'PERSONA', re: new RegExp(`\\b(?:[Ss]ig\\.ra|[Ss]ig\\.|[Dd]ott\\.ssa|[Dd]ott\\.|[Ii]ng\\.|[Gg]eom\\.|[Aa]rch\\.|[Pp]rof\\.)\\s+${FULL_NAME}`, 'gu') },
  { kind: 'PERSONA', re: new RegExp(`\\b(?:${FIRST_NAMES.join('|')})\\s+${PARTICLE}${NAME_WORD}(?:\\s+${NAME_WORD})?`, 'gu') },
];

interface Hit { start: number; end: number; kind: AnonKind }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function collect(text: string, terms: string[]): Hit[] {
  const taken: Hit[] = [];
  const overlaps = (a: number, b: number) => taken.some((h) => a < h.end && b > h.start);
  const add = (start: number, end: number, kind: AnonKind) => {
    if (end > start && !overlaps(start, end)) taken.push({ start, end, kind });
  };
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    for (const m of text.matchAll(new RegExp(escapeRe(t), 'gi'))) add(m.index ?? 0, (m.index ?? 0) + m[0].length, 'TERMINE');
  }
  for (const d of DETECTORS) {
    for (const m of text.matchAll(d.re)) {
      const value = m[0];
      if (d.valid && !d.valid(value)) continue;
      add(m.index ?? 0, (m.index ?? 0) + value.length, d.kind);
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Anonymizes `text`. `enabled` says which categories are replaced (a switched
 * off one is still detected, so the screen can show what stayed in clear);
 * `terms` are extra words the organization never lets out.
 */
export function anonymize(text: string, enabled: Record<AnonCategory, boolean>, terms: string[] = []): AnonResult {
  const hits = collect(text, terms);
  const numbers = new Map<string, number>();
  const seen = new Map<string, AnonEntry>();
  const perKind: Partial<Record<AnonKind, number>> = {};
  const table: AnonEntry[] = [];
  const segments: AnonSegment[] = [];
  const counts: AnonResult['counts'] = { 'fiscal-code': 0, 'vat-iban': 0, names: 0, contacts: 0, custom: 0 };
  let cursor = 0;
  for (const h of hits) {
    if (h.start > cursor) segments.push({ text: text.slice(cursor, h.start) });
    const value = text.slice(h.start, h.end);
    const key = `${h.kind}:${normalize(value)}`;
    let entry = seen.get(key);
    if (!entry) {
      const n = (perKind[h.kind] ?? 0) + 1;
      perKind[h.kind] = n;
      numbers.set(key, n);
      const cat = KIND_CATEGORY[h.kind];
      entry = { token: `${h.kind}_${n}`, kind: h.kind, value, masked: cat === 'custom' ? true : enabled[cat] };
      seen.set(key, entry);
      table.push(entry);
    }
    const cat = KIND_CATEGORY[h.kind];
    if (entry.masked) counts[cat] += 1;
    segments.push({ text: value, kind: h.kind, token: entry.token, masked: entry.masked });
    cursor = h.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  const sent = segments.map((s) => (s.masked && s.token ? s.token : s.text)).join('');
  return { segments, sent, table, counts };
}

/** One run of a reply: plain words or the value a placeholder stands for. */
export interface ReplyPart {
  text: string;
  /** True when the run is a placeholder as the AI wrote it. */
  token?: boolean;
  /** True when the run is a real value put back by Topics. */
  value?: boolean;
}

/**
 * Fills the placeholders `{PERSONA}` of an answer of the AI: seen from the
 * AI they read as the token, seen from Topics as the true value. A kind with
 * no match in the text reads as `fallback`.
 */
export function replyParts(template: string, table: AnonEntry[], side: 'ai' | 'topics', fallback: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let cursor = 0;
  for (const m of template.matchAll(/\{([A-Z]+)\}/g)) {
    const at = m.index ?? 0;
    if (at > cursor) parts.push({ text: template.slice(cursor, at) });
    const e = table.find((t) => t.kind === m[1]);
    if (!e) parts.push({ text: fallback });
    else if (side === 'ai' && e.masked) parts.push({ text: e.token, token: true });
    else parts.push({ text: e.value, value: true });
    cursor = at + m[0].length;
  }
  if (cursor < template.length) parts.push({ text: template.slice(cursor) });
  return parts;
}
