/**
 * A readable title out of a delegated job's prompt (hub-smistamento, HUBBR-13).
 *
 * A prompt is not a title: it starts with where to work, who the agent is,
 * the rules, and only then the work. These helpers keep the first sentence
 * that says the work, and say nothing when none does. Split out of
 * `agentsJobs.ts`, which re-exports them.
 */

export const TITLE_MAX = 64;

// Words that make a sentence English: the hub writes in Italian, a prompt in
// English is a harness's own prose and not a title for this view.
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'with', 'for', 'this', 'that', 'is', 'are', 'on', 'an', 'from', 'your', 'you', 'be', 'it', 'in', 'up', 'into', 'new']);
const ENGLISH_ONLY = new Set(['the', 'and', 'of', 'to', 'with', 'for', 'this', 'that', 'is', 'are', 'your', 'you', 'be', 'into', 'adversarial']);

/** A sentence in English: a harness's own prose, never a title here. */
export function looksEnglish(s: string): boolean {
  const words = s.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const hits = words.filter((w) => ENGLISH.has(w)).length;
  const strong = words.some((w) => ENGLISH_ONLY.has(w));
  return strong && (hits >= 2 || words.length <= 6);
}

/** A word in capitals is shouting, not a name: kept only up to three letters (PR, CI, API). */
export const calm = (s: string) => s.replace(/\b[A-ZÀ-Ý]{4,}\b/g, (w) => w.toLowerCase());

/** At most `n` characters, cut on a word, with an ellipsis. */
export function clip(s: string, n = TITLE_MAX): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

export const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Where a token that is not prose was taken out: a path, a file, a command, a link. */
const CUT = '\uE000';

// The patterns below are the hub's own Italian phrasing of a prompt; they are
// data, matched against what the person and the agents wrote.
const WRAPPER = /^(?:esegui|lancia|run|execute)\b[^.]{0,40}\b(?:comando|command)\b|^(?:esegui|svolgi|fai|leggi|segui)\b[^.]{0,30}\b(?:descritt|scritt|indicat)\w*\s+(?:in|nel)\b|^(?:esegui|lancia|fai|run|execute|comando)\s*:/i; // allow-italian: the prompts' own words, matched as data
const LOCATION = /^(?:nel|nella|in|lavori in|lavora in)\s+(?:(?:il|lo|la)\s+)?(?:git\s+)?(?:worktree|repo|cartella|progetto|ramo)?\b[^:]{0,160}?:\s+/i; // allow-italian: the prompts' own words, matched as data
const LOCATION_BARE = new RegExp(`^(?:nel|nella|in)\\s+(?:(?:worktree|repo|cartella|progetto)\\s+)?${CUT}\\s*,?\\s*`, 'i'); // allow-italian: the prompts' own words, matched as data
const PREAMBLE = /^(?:progetto|repo|worktree|cartella|ramo|branch|sorgente|fonte|anteprima)\b/i; // allow-italian: the prompts' own words, matched as data
const ROLE = /^sei\s+(?:un|una|il|la|lo)\b/i; // allow-italian: the prompts' own words, matched as data
/** A verifier's brief: what it checks is a claim, not a job with a name. */
const CHECKER = /^sei\s+un\w*\s+(?:verifier|verificatore|revisore|critico)\b/i; // allow-italian: the prompts' own words, matched as data
const RULE = /^(?:non|mai|niente|nessun\w*|regole|usa|puoi|devi|ricorda|lavora\s+(?:solo|su|nel|in|qui)|leggi\s+prima|prima\s+leggi|read\s+first|stato|lingua|language|output|formato|stile|browser)\b|\b(?:mai|vietat[oa])\b/i; // allow-italian: the prompts' own words, matched as data
const LABEL = /^(?:task|compito|goal|obiettivo|richiesta[^:]{0,25}|contesto|context|fase\s+\w+|bug[^:]{0,40}|problema|ripresa[^:]{0,30}|decisione[^:]{0,25})\s*:\s*/i; // allow-italian: the prompts' own words, matched as data
const CLAUSE = /,\s+(?=(?:niente|non|senza|mai|nessun\w*|solo|sola|rispondi|in italiano|in inglese)\b)/i; // allow-italian: the prompts' own words, matched as data
const READ_ONLY = /\b(?:in\s+|di\s+)?sol[ao]\s+(?:lettura|scrittura)\b,?/gi; // allow-italian: the prompts' own words, matched as data
const SMALL = '(?:in|di|da|su|a|ad|al|nel|nella|del|della|con|per|sul|sulla|dal|dalla|e|o|il|lo|la|le|gli|i|un|una|uno|tra|fra)'; // allow-italian: the prompts' own words, matched as data
const TRAIL_WORDS = new RegExp(`\\s+${SMALL}\\s*$`, 'i');
const TRAIL_PLACE = new RegExp(`\\s+(?:${SMALL}\\s+){1,2}(?:worktree|repo|ramo|branch|cartella|progetto|file)\\s*$`, 'i'); // allow-italian: the prompts' own words, matched as data
const BROKEN = new RegExp(`(?:^|\\s)(?:${SMALL}|file|script|cartella|comando|ramo|percorso|branch)\\s*${CUT}`, 'i'); // allow-italian: the prompts' own words, matched as data
const ENDS_ON_VERB = /\s(?:è|e'|sono|sta|stanno|ha|hanno)$/i; // allow-italian: the prompts' own words, matched as data

/** The end of a sentence without what a removed token left: the mark, a dangling place, a dangling small word. */
function trimTail(s: string): string {
  let t = s;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(new RegExp(`[\\s,;:.]*${CUT}[\\s,;:.]*$`), '').replace(TRAIL_PLACE, '').replace(TRAIL_WORDS, '').trim();
    if (t === before) break;
  }
  return t;
}

/**
 * Past a preamble the next sentences are as often the rules as the work: one
 * is a title only when it is hasLabel as the goal or opens on a verb of work.
 */
const ACTION = /^(?:\p{L}+(?:are|ere|ire)|correggi|verifica|crea|aggiungi|togli|sistema|rifai|porta|sposta|scrivi|leggi|prepara|trova|cerca|controlla|ripara|rilancia|chiudi|riprendi|completa|traduci|aggiorna|implementa|rimuovi|fai|prova|misura|studia|analizza|confronta|migra|collega|pubblica|rigenera|ricostruisci|indaga|rivedi|rileggi)\b/iu; // allow-italian: the prompts' own words, matched as data

/** One sentence of a prompt made a title, or '' when it is not one; null when it is a preamble to skip. */
function sentenceTitle(raw: string, afterPreamble: boolean): string | null {
  let t = raw.trim();
  if (!t) return null;
  if (WRAPPER.test(t) || CHECKER.test(t)) return '';
  if (LOCATION.test(t) && (t.includes(CUT) || /\bramo\b|\brepo\b|\bworktree\b/i.test(t.split(':')[0]!))) t = t.replace(LOCATION, '');
  else t = t.replace(LOCATION_BARE, '');
  if (!t.trim() || PREAMBLE.test(t) || ROLE.test(t) || RULE.test(t)) return null;
  const hasLabel = LABEL.test(t);
  t = t.replace(LABEL, '');
  if (afterPreamble && !hasLabel && !ACTION.test(t)) return null;
  if (WRAPPER.test(t)) return '';
  t = t.split(CLAUSE)[0]!.replace(READ_ONLY, ' ');
  const colon = t.indexOf(': ');
  if (colon > 0) {
    const head = t.slice(0, colon).trim();
    const tail = t.slice(colon + 2).replace(new RegExp(CUT, 'g'), '').trim();
    const words = head.split(/\s+/).length;
    if (!tail && words <= 3) return '';
    if (head.includes(CUT) && words <= 3) t = t.slice(colon + 2);
    else if (words >= 3) t = head;
  }
  // A path between a verb and the next one: «read X and tell me» reads «tell me».
  t = t.replace(new RegExp(`^[\\p{L}']+\\s*${CUT}\\s+e\\s+`, 'iu'), '');
  t = trimTail(t);
  // A path cut out of the middle leaves the sentence broken there: what comes before it may still read.
  const broken = BROKEN.exec(t);
  if (broken) t = trimTail(t.slice(0, broken.index));
  if (broken && t.split(/\s+/).length < 3) return '';
  t = t.replace(new RegExp(CUT, 'g'), ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/[.:,;]+$/, '').trim();
  t = t.replace(/^«(.*)»$/, '$1').replace(/^"(.*)"$/, '$1').trim();
  if (/^\d+[.)]/.test(t) || ENDS_ON_VERB.test(t)) return '';
  if (t.split(/\s+/).length < 2 || !/[a-zà-ý]{3}/i.test(t)) return '';
  if (looksEnglish(t)) return '';
  return clip(capFirst(t));
}

/**
 * The automation a job was sent to repair, by the name the hub gave it,
 * without the hub's notes in brackets and after the second colon; null for
 * any other job. The view words the repair.
 */
export function repairName(raw: unknown): string | null {
  const auto = /^Automazione «([^»]+)»/i.exec(typeof raw === 'string' ? raw.trim() : ''); // allow-italian: the hub's own prompt
  if (!auto) return null;
  const parts = auto[1]!.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(/\s*:\s+/);
  const name = parts.length > 1 && parts[0]!.split(' ').length <= 2 ? `${parts[0]}: ${parts[1]}` : parts[0]!;
  return clip(name.trim(), TITLE_MAX - 10);
}

/**
 * The title of a delegated job, from the text it was given. A prompt is not
 * a title: it starts with where to work, who the agent is, the rules, and only
 * then the work. So the first sentence that says the work, without paths,
 * files, commands, links, parentheses, hashes or flags, at most 64
 * characters. '' when no sentence is readable on its own (a command wrapper,
 * a task kept in a file, a prompt in English, a sentence a removed path left
 * broken): the view then names the job by its project instead.
 */
export function jobTitle(raw: unknown): string {
  let s = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!s || s.startsWith('-')) return '';
  // A card of the board names itself between the quotes.
  const card = /^Card della board[^«]*«(.+?)»(?:\.|\s|$)/i.exec(s);
  if (card) return clip(capFirst(card[1]!.trim()));
  // An automation the hub sent to be repaired is named by `repairName`, not here.
  if (repairName(s)) return '';
  s = calm(s)
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\([^)]*$/, ' ')
    .replace(/`[^`]*`?/g, CUT)
    .replace(/https?:\/\/\S*[^\s.,;:)]/g, CUT)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, CUT)
    .replace(/(?<![\w/])(?:~|\.{1,2})?\/[^\s,;]*[^\s,;.:]/g, CUT)
    // A word/word of letters only is prose (rollback/redeploy); with a digit, a dash, a dot or a second slash it is a path or a branch.
    .replace(/\b(?![\p{L}]+\/[\p{L}]+\b(?![/\w-]|\.\w))[\w.-]*[a-z][\w.-]*\/[^\s,;]*[^\s,;.:]/giu, CUT)
    .replace(/\b[\w.-]+\.(?:jsonl?|mjs|cjs|js|ts|tsx|jsx|swift|rs|py|sh|md|txt|ya?ml|html|css|toml|lobster|jpe?g|png|webp|gif|svg|pdf|webm|mp4)\b/gi, CUT)
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, CUT)
    .replace(/\b\w+=\S+/g, CUT)
    .replace(/(?:^|\s)--?[a-z][\w-]*/g, ` ${CUT}`)
    .replace(/\s+/g, ' ');
  const sentences = s.split(/(?<=[.!?])\s+|\s[\u2014\u2013-]\s|;\s|\s(?=\d[.)]\s)/).slice(0, 5);
  let afterPreamble = false;
  for (const sentence of sentences) {
    const t = sentenceTitle(sentence, afterPreamble);
    if (t !== null) return t;
    afterPreamble = true;
  }
  return '';
}
