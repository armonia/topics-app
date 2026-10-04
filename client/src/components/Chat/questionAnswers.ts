/**
 * What the person answered, question by question, read from the tool row.
 *
 * On the wire the answer is a flat map `{ question text: value }`
 * (`ToolUserResponse`): a single choice is the label, a multiple one is the
 * labels joined by ", " (`resolveAnswerFor` in `ToolInputForm.tsx`), and
 * "Other" is the written text with no mark telling it apart. Showing it well
 * means putting it back next to the options the question offered: which one
 * was picked, which were not, and what is free text.
 *
 * Pure functions: the closed row (one line per question) and the open card
 * (every option, the pick ticked) both use them, and a test reaches them
 * without a DOM.
 */

/**
 * The recommended option, and how we know it is.
 *
 * The `recommended` field is the clean way, but the advice also arrives in the
 * text: the CLI appends "(Recommended)" to the label, and a model that does not
 * know the field says the same in words. Reading both forms means the mark
 * shows AT ONCE, without waiting for everyone to adopt the schema; and the word
 * at the end of the label is removed, or it would read twice. It lives here and
 * not in the panel because the answer already given shows the label without
 * that word too.
 */
const RECOMMENDED_RE = /\s*[（([]?\s*(consigliat[oa]|recommended)\s*[）)\]]?\s*$/i;
export function readRecommendation(opt: { label: string; description?: string; recommended?: boolean }) {
  const inLabel = RECOMMENDED_RE.test(opt.label);
  return {
    isRecommended: opt.recommended === true || inLabel || RECOMMENDED_RE.test(opt.description ?? ''),
    // The label without the word: the chip already says it.
    label: inLabel ? opt.label.replace(RECOMMENDED_RE, '') : opt.label,
  };
}

/** A question as the row knows it: from the persisted schema or, on old rows, from `detail`. */
export interface AskedQuestion {
  question: string;
  header?: string;
  /** Objects from the schema, strings from an `ask_user` detail. */
  options?: Array<string | { label: string }>;
  multiSelect?: boolean;
}

/** One piece of the answer: an offered option, or text written by hand. */
export interface AnswerPart {
  /** The label as it reads (without "(Recommended)"), or the free text. */
  text: string;
  free: boolean;
}

export interface AnsweredOption {
  /** The label as it reads. */
  label: string;
  chosen: boolean;
}

export interface AnsweredQuestion {
  /** The whole question text: the key of the map on the wire. */
  question: string;
  header?: string;
  options: AnsweredOption[];
  parts: AnswerPart[];
}

/** The separator the panel joins the picks of a multiple question with. */
const CHOICE_SEPARATOR = ', ';

/**
 * The value of one question, split into picked options and free text.
 *
 * On a single choice the value is either an option or entirely free text:
 * splitting it on commas would turn "Postgres, with pgvector" into an option
 * plus a comment, which is not what the person picked.
 *
 * On a multiple choice the labels are joined by ", " and the free text can sit
 * among them, commas included: each step takes the longest label that matches
 * (a label may contain ", " itself), and the pieces that match nothing are
 * sewn back into one free text.
 */
export function splitAnswer(answer: string, labels: readonly string[], multiSelect: boolean): AnswerPart[] {
  const value = answer.trim();
  if (!value) return [];
  const display = (raw: string) => readRecommendation({ label: raw }).label;
  if (labels.includes(value)) return [{ text: display(value), free: false }];
  if (!multiSelect) return [{ text: value, free: true }];
  const tokens = value.split(CHOICE_SEPARATOR);
  const parts: AnswerPart[] = [];
  let free: string[] = [];
  const flushFree = () => {
    if (free.length) parts.push({ text: free.join(CHOICE_SEPARATOR), free: true });
    free = [];
  };
  let i = 0;
  while (i < tokens.length) {
    let matched = 0;
    for (let j = tokens.length; j > i; j--) {
      if (labels.includes(tokens.slice(i, j).join(CHOICE_SEPARATOR))) { matched = j - i; break; }
    }
    if (matched === 0) {
      free.push(tokens[i]!);
      i += 1;
      continue;
    }
    flushFree();
    parts.push({ text: display(tokens.slice(i, i + matched).join(CHOICE_SEPARATOR)), free: false });
    i += matched;
  }
  flushFree();
  return parts;
}

const labelOf = (o: string | { label: string }) => (typeof o === 'string' ? o : o.label);

/**
 * The questions in the order they were asked, each with its own answer.
 *
 * An answer to a question the schema does not know (an old row without a
 * schema, or a composer answer to a question whose row only has a trimmed
 * `detail`) is not dropped: it shows at the end, with what is known. A question
 * without an answer stays in the list with empty `parts`; the renderer decides
 * whether to show it.
 */
export function readAnsweredQuestions(asked: readonly AskedQuestion[], answers: Readonly<Record<string, string>>): AnsweredQuestion[] {
  const out: AnsweredQuestion[] = [];
  const seen = new Set<string>();
  for (const q of asked) {
    seen.add(q.question);
    const labels = (q.options ?? []).map(labelOf);
    const parts = splitAnswer(answers[q.question] ?? '', labels, q.multiSelect === true);
    const chosen = new Set(parts.filter((p) => !p.free).map((p) => p.text));
    out.push({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: labels.map((raw) => {
        const label = readRecommendation({ label: raw }).label;
        return { label, chosen: chosen.has(label) };
      }),
      parts,
    });
  }
  for (const [question, value] of Object.entries(answers)) {
    if (seen.has(question)) continue;
    out.push({ question, options: [], parts: splitAnswer(value, [], false) });
  }
  return out;
}

/** A value of an MCP elicitation form, as the person filled it in. */
export type ElicitationValue = string | number | boolean | Array<string | number | boolean>;

export interface ElicitationField {
  /** The field's `title` from the schema, its key without one; absent for a bare value. */
  label?: string;
  value: ElicitationValue;
}

export interface ElicitationAnswer {
  /** What the form asked, as the server wrote it above the fields. */
  message?: string;
  fields: ElicitationField[];
}

/**
 * The answer to an MCP elicitation, field by field, named as the form named them.
 *
 * On the wire it is the object the form submitted, `{ key: value }`. Shown as
 * `JSON.stringify` it read `{"title":"Fix the login bug","confirm":true}` on the
 * closed row: keys instead of the names the person saw, braces and quotes. Here
 * each field takes its `title` from `requestedSchema.properties` (the key when
 * there is none), in the order the form asked them; fields the schema does not
 * know follow, a nested object is spelled out as "parent › child", and an empty
 * field is left out. Booleans stay booleans: the words for them are the
 * renderer's, in the reader's language.
 */
export function readElicitationAnswer(requestedSchema: unknown, message: string | undefined, value: unknown): ElicitationAnswer {
  const props = schemaFieldsOf(requestedSchema);
  const fields: ElicitationField[] = [];
  const push = (label: string | undefined, v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') { if (v.trim()) fields.push({ ...(label ? { label } : {}), value: v }); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { fields.push({ ...(label ? { label } : {}), value: v }); return; }
    if (Array.isArray(v)) {
      const flat = v.filter((x): x is string | number | boolean => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
      if (flat.length) fields.push({ ...(label ? { label } : {}), value: flat });
      return;
    }
    if (typeof v === 'object') {
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) push(label ? `${label} › ${k}` : k, inner);
    }
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = [...Object.keys(props).filter((k) => k in record), ...Object.keys(record).filter((k) => !(k in props))];
    for (const key of keys) push(titleOf(props[key]) ?? key, record[key]);
  } else {
    push(undefined, value);
  }
  const msg = message?.trim();
  return { ...(msg ? { message: msg } : {}), fields };
}

function schemaFieldsOf(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const props = (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

function titleOf(prop: unknown): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined;
  const title = (prop as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}
