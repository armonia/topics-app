/**
 * Intent classifier for a spoken reply to a task in review.
 *
 * Three possible outcomes, always the same three the voice board acts on:
 *   · `approve`  — the delivery is fine, approve it (same as the Approve
 *     button);
 *   · `feedback` — there's more to do: the whole text goes back to the task
 *     as a comment (same path as the quick-reply, `notifyActionRequest`);
 *   · `close`    — close ONLY the voice loop. Does not touch the task:
 *     "close" here is not "land" nor "approve", it's "stop talking to me", a
 *     gesture that stays the human's.
 *
 * Groq (`llama-3.1-8b-instant`) does the real classification when
 * `GROQ_API_KEY` is set — the same key `lib/stt.ts` already uses for
 * Whisper, zero new secret. Fails silently on anything (missing key, network
 * down, malformed response, timeout): this isn't a service that must stay
 * up, it's a suggestion with a keyword fallback always behind it — the board
 * has to keep answering even offline.
 */

export type VoiceIntent = "approve" | "feedback" | "close";

export interface ClassifyResult {
  intent: VoiceIntent;
  /** Only for `feedback`: the text that ends up as a comment on the task. */
  text?: string;
  /** Who decided — useful in logs/tests, doesn't change client behaviour. */
  source: "groq" | "keyword";
}

export interface IntentClassifierDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const GROQ_TIMEOUT_MS = 8_000;
const GROQ_MODEL = "llama-3.1-8b-instant";
const MAX_TEXT_CHARS = 2_000;

// Words that, alone at the start of a sentence (or the whole sentence),
// count as a certain intent — Italian and English, the two languages the
// project treats as live. Order matters: `close` before `approve` because
// "that's it, sounds good" carries both a farewell and an assent, and
// someone closing is closing, not approving.
const CLOSE_RE = /^(chiudi|basta|stop|fermati|esci|grazie|close|that's all|stop it)\b/i;
const APPROVE_RE = /^(approvo|approva|ok|va bene|si|s[ìí]|perfetto|approve|yes|yep|sounds good|looks good)\b/i;

/**
 * The offline fallback: no nuance, only the opening of the sentence.
 * Anything that doesn't open with a clear assent or a clear close is
 * `feedback` — the safe default: an extra `feedback` costs a re-read
 * comment, an extra `approve` would close a task by mistake.
 */
export function classifyByKeyword(text: string): ClassifyResult {
  const trimmed = text.trim();
  if (CLOSE_RE.test(trimmed)) return { intent: "close", source: "keyword" };
  if (APPROVE_RE.test(trimmed)) return { intent: "approve", source: "keyword" };
  return { intent: "feedback", text: trimmed, source: "keyword" };
}

function parseGroqIntent(raw: string): VoiceIntent | null {
  const match = raw.match(/"?intent"?\s*[:=]\s*"?(approve|feedback|close)"?/i);
  if (match) return match[1].toLowerCase() as VoiceIntent;
  const bare = raw.trim().toLowerCase();
  if (bare === "approve" || bare === "feedback" || bare === "close") return bare;
  return null;
}

async function classifyByGroq(text: string, apiKey: string, doFetch: typeof fetch): Promise<ClassifyResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const resp = await doFetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 20,
        messages: [
          {
            role: "system",
            content:
              'Classify a spoken reply to a task ready for review. Answer ONLY with JSON {"intent":"approve"|"feedback"|"close"}. ' +
              '"approve" = the person approves the delivery as it is. "close" = the person just wants to stop talking, without judging the delivery. ' +
              '"feedback" = anything else, including corrections or requests.',
          },
          { role: "user", content: text.slice(0, MAX_TEXT_CHARS) },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const intent = parseGroqIntent(content);
    if (!intent) return null;
    return intent === "feedback" ? { intent, text: text.trim(), source: "groq" } : { intent, source: "groq" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function classifyIntent(text: string, deps: IntentClassifierDeps = {}): Promise<ClassifyResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const doFetch = deps.fetchImpl ?? fetch;
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  const apiKey = env.GROQ_API_KEY;
  if (apiKey) {
    const viaGroq = await classifyByGroq(clipped, apiKey, doFetch);
    if (viaGroq) return viaGroq;
  }
  return classifyByKeyword(clipped);
}
