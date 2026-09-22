/**
 * THE VERDICT, SPLIT IN TWO: the sentence a person reads, and the payload a
 * person forwards.
 *
 * THE DEFECT, measured on this machine's database (2026-09-22): 126 verdict
 * rows out of 2101 carry the provider's raw JSON inside the amber banner, so
 * the chat says
 *
 *   API 401: {"type":"error","error":{"type":"authentication_error","message":
 *   "OAuth access token has been revoked."},"request_id":null}. The token could
 *   not be renewed either: run `claude` -> /login once, then retry.
 *
 * where the only sentence that matters ("OAuth access token has been revoked")
 * is buried between two braces and a null request id. The banner printed the
 * string as it came, because nobody had ever asked it what the string WAS.
 *
 * SO THE QUESTION IS ASKED HERE, ONCE, as a pure function: the human headline
 * (label, provider message, human tail) and the technical details (the raw
 * JSON, pretty-printed) which the banner keeps folded and copyable. Nothing is
 * thrown away: a payload nobody can read is still the payload you paste into a
 * bug report.
 *
 * WHAT IS DELIBERATELY NOT HERE. No HTML entity decoding: zero of those same
 * 2101 rows contain one, so the branch would only be code defending itself
 * from a failure this app does not produce.
 *
 * AND THE 35 THAT ARRIVE CUT IN HALF. 35 of those 126 are stored truncated at
 * a fixed 309 characters, so the object never closes and `JSON.parse` will
 * never see them. Leaving them raw would have left the envelope printed in the
 * reader's face exactly where it hurts most: every one of the 35 is a
 * `tool_use`/`tool_result` pairing error, which you cannot act on without
 * reading the sentence. So they are READ, not repaired -- see
 * `truncatedMessage` below.
 */

/** A verdict as the banner needs it: one sentence, plus what is behind it. */
export interface ReadableVerdict {
  /** The sentence to print. Never empty when the input is not empty. */
  headline: string;
  /**
   * The payload behind the sentence, or `null` when there was none.
   * Pretty-printed when it parsed; verbatim when it arrived truncated.
   */
  details: string | null;
  /** True when the payload was stored cut off, so `details` is raw and partial. */
  truncated: boolean;
}

/**
 * The end of the JSON object that starts at `from`, or -1.
 *
 * A brace counter that knows about strings, because the provider's messages
 * contain braces of their own ("messages.7.content.0.thinking.text: Extra
 * inputs are not permitted" is tame, but the tool-use errors quote identifiers
 * and backticks). Counting braces blind would cut the object in the middle and
 * lose the payload exactly when it is most needed.
 */
function endOfJsonObject(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where the JSON string opening at `openQuote` ends, and whether it closed. */
function scanString(text: string, openQuote: number): { end: number; terminated: boolean } {
  let escaped = false;
  for (let i = openQuote + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') return { end: i, terminated: true };
  }
  return { end: text.length, terminated: false };
}

/**
 * The keys a provider puts its sentence under. A CLOSED list, and `error` is
 * deliberately not on it: in a truncated payload `"error":{` opens an object,
 * and taking the next string would hand back the nested `type` instead of the
 * message.
 */
const MESSAGE_KEYS = new Set(['message', 'error_description', 'detail']);

/**
 * The provider's sentence inside an object that never closes.
 *
 * NOT A JSON REPAIR, AND THAT IS THE POINT. Closing the braces would produce a
 * payload the provider never sent, which people then paste into bug reports as
 * if it were the real thing. This only walks the text as a tokenizer would,
 * respecting quotes and escapes, and lifts out the one string that is worth
 * reading. Keys are recognised only where a key can structurally be (a closed
 * string followed by a colon), so a message that quotes `"message":"` inside
 * itself cannot hijack the read.
 *
 * Returns the string's body and whether the cut fell after it (`complete`) or
 * inside it. Both are useful: 9 of the 35 rows closed their message before the
 * cut, the other 26 did not, and a sentence cut mid-word still says more than
 * the envelope around it.
 */
function truncatedMessage(text: string, from: number): { body: string; complete: boolean } | null {
  // The cut object must actually look like one. An unclosed brace in prose is
  // prose, and prose is printed untouched.
  let k = from + 1;
  while (k < text.length && /\s/.test(text[k])) k++;
  if (text[k] !== '"') return null;

  let i = k;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const key = scanString(text, i);
    // An unterminated string that is not a value we want ends the read: there
    // is nothing structural left behind it.
    if (!key.terminated) return null;
    const name = text.slice(i + 1, key.end);
    let j = key.end + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ':') {
      // A value, not a key. Step over it and keep walking.
      i = key.end + 1;
      continue;
    }
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (MESSAGE_KEYS.has(name) && text[j] === '"') {
      const value = scanString(text, j);
      return { body: text.slice(j + 1, value.end), complete: value.terminated };
    }
    i = j;
  }
  return null;
}

/**
 * A JSON string body turned back into text.
 *
 * The cut can land inside an escape sequence, leaving a dangling `\` or a
 * half-written `\u00`. That tail is dropped, because it is half a character
 * and not a character; anything else that will not decode is refused outright
 * so the caller can fall back to printing the verdict untouched.
 */
function decodeStringBody(body: string): string | null {
  let s = body.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  const trailingSlashes = s.length - s.replace(/\\+$/, '').length;
  if (trailingSlashes % 2 === 1) s = s.slice(0, -1);
  try {
    const decoded = JSON.parse(`"${s}"`);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

/** The sentence inside a provider payload, whatever shape it arrived in. */
function messageOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  const nested = o.error;
  if (nested && typeof nested === 'object') {
    const m = (nested as Record<string, unknown>).message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  for (const key of ['message', 'error_description', 'error', 'detail'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Read a verdict: the human sentence, and the payload behind it.
 *
 * The label before the JSON ("API 401: ") and the advice after it ("The token
 * could not be renewed either: ...") are both kept: the first says who
 * refused, the second says what to do, and dropping either would trade an
 * unreadable line for a useless one. Only the object in the middle moves into
 * the folded details, replaced by its own message.
 */
export function readableVerdict(raw: string): ReadableVerdict {
  const text = (raw ?? '').trim();
  if (!text) return { headline: '', details: null, truncated: false };

  const start = text.indexOf('{');
  if (start === -1) return { headline: text, details: null, truncated: false };
  const end = endOfJsonObject(text, start);
  if (end === -1) return readTruncated(text, start);

  const slice = text.slice(start, end + 1);
  let payload: unknown;
  try {
    payload = JSON.parse(slice);
  } catch {
    // Braces that are not JSON are prose: a path, a shell snippet, a template.
    return { headline: text, details: null, truncated: false };
  }

  const message = messageOf(payload);
  const before = text.slice(0, start).trim();
  const after = text.slice(end + 1).trim();
  // The tail usually opens with the punctuation that followed the object.
  const tail = after.replace(/^[.,;:]\s*/, '');
  const headline = [before, message ?? '', tail]
    .filter((p) => p.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    headline: headline || text,
    details: JSON.stringify(payload, null, 2),
    truncated: false,
  };
}

/**
 * A verdict whose payload was stored cut off.
 *
 * The label before the object is kept, the provider's sentence takes the place
 * of the object, and an ellipsis is added when the sentence itself was cut, so
 * nobody reads a half sentence as a whole one. The fold gets the payload
 * VERBATIM, truncation and all: it is not re-serialised, because half an
 * object cannot be re-serialised without inventing the missing half.
 *
 * Anything that does not yield a readable sentence falls back to the untouched
 * text, which is what every unrecognised verdict has always done.
 */
function readTruncated(text: string, start: number): ReadableVerdict {
  const found = truncatedMessage(text, start);
  if (!found) return { headline: text, details: null, truncated: false };

  const message = decodeStringBody(found.body);
  if (!message || !message.trim()) return { headline: text, details: null, truncated: false };

  const before = text.slice(0, start).trim();
  const sentence = message.trim() + (found.complete ? '' : '…');
  const headline = [before, sentence]
    .filter((p) => p.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { headline, details: text.slice(start), truncated: true };
}
