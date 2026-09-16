/**
 * WHAT THE PERSON READS BEFORE SAYING YES, on the Google door.
 *
 * `google_call` IS A SECOND MAIL DOOR. `gws gmail users messages send` exists
 * (so does `users drafts send`), so an agent that never touches `send_mail` can
 * still put a message on the wire through the generic Google call. That door
 * used to ask for a confirmation whose whole content was
 * `body: {"userId":"me","raw":"RnJvbTogcHJpbW9AZXNlbXBpby50ZXN0..."}` cut at
 * 300 characters: base64, halfway through, with recipient, subject and body
 * invisible. It is the sealed envelope OUTBOUND-03 forbids - reopened on the
 * door next to the one that had just been fixed.
 *
 * TWO ANSWERS, because the two failures are different:
 *
 *   - a call that SENDS is refused here and told to use `send_mail`. Two doors
 *     onto the same act mean two confirmations to keep honest, and the one that
 *     shows the message already exists.
 *   - every other write is SUMMARISED in words: an `raw` field is decoded and
 *     read out (from, to, subject, body), and nothing is ever cut without the
 *     cut being announced.
 *
 * A LIST IS THE SECOND LAYER, NOT THE FENCE. The first version of this file was
 * a list of two API paths, and the CLI it is standing in front of has four
 * `+helpers` that send - none of them an API path, all of them reachable
 * through the same four free strings. The fence is in `routes/outbound.ts`: the
 * four fields must be API names, which refuses every helper and every flag in
 * one rule. What survives here is the list, kept because "this call sends mail,
 * use `send_mail`" is a better answer to an agent than "that is not a name",
 * and because `users drafts create` writes without sending and must still pass.
 */

/** A message pulled out of a `raw` field, in the parts a person decides on. */
export interface DecodedMail {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

/**
 * The Gmail calls that put a message on the wire, written out.
 *
 * Both shapes the CLI accepts are listed: the full `users messages send` an
 * agent copies from the API reference, and the short `messages send` the help
 * text also answers to. A method name alone ("send") is not enough to decide -
 * `drafts create` writes and does not send, `settings.sendAs.create` is a
 * setting - so the whole path is what is compared.
 */
const GMAIL_SENDING_CALLS = new Set([
  "users messages send",
  "users drafts send",
  "messages send",
  "drafts send",
]);

/**
 * The HELPERS of the CLI that is actually being driven, which the API paths
 * above do not cover.
 *
 * `gws gmail --help` lists four commands that put a message on the wire:
 * `+send`, `+reply`, `+reply-all`, `+forward`. None of them is an API path, so
 * comparing whole paths never saw them, and the call has four free string slots
 * - exactly the ones `+forward --message-id <ID> --to <EMAILS>` needs, which
 * forwards any message of the mailbox, attachments included, to any address.
 * A helper is recognised wherever it sits, because the caller chooses the slot.
 */
const GMAIL_SENDING_HELPERS = new Set([
  "+send",
  "+reply",
  "+reply-all",
  "+forward",
]);

/** Lower case, trimmed, single spaces: `Users  Messages` is the same call. */
function flatten(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Does this Google call SEND a message, i.e. is it the mail door in disguise? */
export function gmailSendsMail(parts: {
  service: string;
  resource: string;
  subresource?: string;
  method: string;
}): boolean {
  if (flatten(parts.service) !== "gmail") return false;
  const fields = [parts.resource, parts.subresource ?? "", parts.method].map(flatten).filter(Boolean);
  if (fields.some((field) => GMAIL_SENDING_HELPERS.has(field))) return true;
  return GMAIL_SENDING_CALLS.has(fields.join(" "));
}

/**
 * A cut that says it is a cut. A confirmation that silently stops mid-field is
 * the same lie as one that shows nothing: the reader cannot tell the end of the
 * text from the end of the quota.
 */
export function announcedCut(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[...] (${text.length} caratteri in tutto)`
    : text;
}

/** `raw` travels base64url in the Gmail API; Buffer wants the plain alphabet. */
function fromBase64Url(raw: string): string {
  const plain = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  return Buffer.from(plain, "base64").toString("utf8");
}

/** The `raw` of a Gmail message, at the top level or under `message`. */
function rawFieldOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const top = (body as { raw?: unknown }).raw;
  if (typeof top === "string" && top.trim()) return top;
  const nested = (body as { message?: { raw?: unknown } }).message?.raw;
  return typeof nested === "string" && nested.trim() ? nested : null;
}

/**
 * Turn an RFC822 message into its headers and its body. Continuation lines are
 * joined back onto their header: a subject long enough to wrap is exactly the
 * subject somebody needs to read whole.
 */
export function decodeRawMail(body: unknown): DecodedMail | null {
  const raw = rawFieldOf(body);
  if (!raw) return null;
  let text: string;
  try { text = fromBase64Url(raw); } catch { return null; }
  if (!text.trim()) return null;
  const split = text.search(/\r?\n\r?\n/);
  const head = split >= 0 ? text.slice(0, split) : text;
  const rest = split >= 0 ? text.slice(split).replace(/^\r?\n\r?\n/, "") : "";
  const headers = new Map<string, string>();
  let current = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  // A base64 decoder never refuses: garbage comes back as mojibake, with no
  // header in it. Calling that "a message" would replace the JSON the person
  // could at least read with an empty From/To/Subject block - hiding the field
  // instead of showing it. Without a single recognisable header this is not a
  // message, and the caller falls back to printing the body as it is.
  if (!headers.has("from") && !headers.has("to") && !headers.has("subject")) return null;
  return {
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    cc: headers.get("cc") ?? "",
    subject: headers.get("subject") ?? "",
    body: rest,
  };
}

export interface GoogleSummaryParts {
  /** The call as it is written on the card: `gmail users drafts create`. */
  call: string;
  /** Query parameters, already serialised, or null when there are none. */
  params: string | null;
  /** The request body, already serialised, or null when there is none. */
  body: string | null;
  /** The request body as an object, which is where a `raw` message is found. */
  bodyValue: unknown;
  /** How much of a long field is shown before the cut is announced. */
  maxChars: number;
}

/**
 * The question for a Google write, in words somebody can decide on.
 *
 * When the body carries a message, the message is what gets shown - the JSON
 * around it is repeated with the base64 replaced by a pointer, so the reader
 * sees there was one field and where it went, instead of a wall they have to
 * decode by hand.
 */
export function googleWriteSummary(parts: GoogleSummaryParts): string {
  const lines = [
    `Chiamata Google che SCRIVE: ${parts.call}`,
    parts.params ? `params: ${announcedCut(parts.params, parts.maxChars)}` : "params: nessuno",
  ];
  const mail = decodeRawMail(parts.bodyValue);
  if (mail) {
    lines.push(
      "Questa chiamata porta un MESSAGGIO (campo `raw`, decodificato qui):",
      `Da: ${mail.from || "(non indicato)"}`,
      `A: ${mail.to || "(non indicato)"}${mail.cc ? ` (cc ${mail.cc})` : ""}`,
      `Oggetto: ${mail.subject || "(nessuno)"}`,
      "",
      announcedCut(mail.body.trim(), parts.maxChars),
    );
    return lines.join("\n");
  }
  lines.push(parts.body ? `body: ${announcedCut(parts.body, parts.maxChars)}` : "body: nessuno");
  return lines.join("\n");
}
