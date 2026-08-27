/**
 * THE HEADSTONE OF A TURN THAT WAS NOT OURS — and when it can be reused.
 *
 * -- The failure, measured ---------------------------------------------------
 * The CLI delivers background-task notifications (`<task-notification>`: a
 * Monitor firing, a background shell finishing) by OPENING A TURN OF ITS OWN.
 * If a human send has just started at that moment, that turn's `result` —
 * empty, because a notification on its own does not deserve an answer —
 * reaches the send's handler, which takes it for the end of ITS OWN turn and
 * stamps the failure notice onto the row — «Nessuna risposta: il turno si e' chiuso senza produrre niente». allow-italian: quotes the notice the route writes
 * The real prompt starts right after, but by then nobody is
 * listening: it gets adopted as a spontaneous turn and the answer lands in a
 * NEW row.
 *
 * On screen: the human's message, a failure notice under it, and under that
 * the answer the notice declared missing.
 *
 * The trace (topic:205d1fbb, 2026-08-21, from the CLI transcript):
 *
 *   10:51:13.325  user  <task-notification> <task-id>b2mec56st</task-id> …
 *   10:51:13.343  user  <context> You are working in the project "Songs" …
 *   10:51:20.396  assistant  (the real answer)
 *
 * and in the database the chain `user -> notice -> answer`, with the notice as
 * the parent. In the log, `chat.send OK for topic:205d1fbb, runId: woken`: the
 * answer really did come through the spontaneous-turn adoption. Across the
 * whole DB: 14 notices, 8 of them followed by the real answer within two
 * minutes.
 *
 * -- Why REUSE the row instead of deleting it --------------------------------
 * There is no «message deleted» event: whoever is watching the chat would keep
 * the notice bubble until the next reload. Reusing the row instead points the
 * adoption's `stream:start` at THAT bubble, and the notice becomes the answer
 * under the reader's eyes. It is the same road the post-restart reattach has
 * always taken (`reuseOrCreatePartialForReattach`).
 *
 * -- The boundary ------------------------------------------------------------
 * Only a row that is exactly that headstone is reused: assistant, closed,
 * carrying the notice text, with no tools and no blocks beyond the error one.
 * If the previous turn had produced something, it is not a headstone and it is
 * somebody's history: it is not touched.
 *
 * The time window is not the discriminator — that is the headstone being the
 * LAST row, which is to say nobody has answered that message yet — but it is
 * the safety belt: a Monitor waking a session half an hour after a turn that
 * really did come back empty finds the notice where it was, and that notice is
 * still true.
 */

/** The notice prefix, exactly as `routes/chat.ts` writes it. */
export const HEADSTONE_PREFIX = "⚠️ Nessuna risposta:";

/** Past this, the notice has stopped being about the message just sent. */
export const HEADSTONE_WINDOW_MS = 120_000;

export interface RowToReuse {
  role: string;
  content: string;
  /** The `tool_calls` column exactly as SQLite holds it. */
  toolCallsJson: string | null;
  /** The `blocks` column exactly as SQLite holds it. */
  blocksJson: string | null;
  /** The row's ISO `timestamp`. */
  timestamp: string;
  /** `partial`: a row still alive is not a headstone. */
  partial: boolean;
}

/** An empty or absent JSON list. */
function emptyList(raw: string | null): boolean {
  if (!raw) return true;
  const t = raw.trim();
  if (t === "" || t === "[]" || t === "null") return true;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) && v.length === 0;
  } catch {
    return false;
  }
}

/** Are the blocks ONLY the error notice, and nothing else? */
function soloIlBloccoDErrore(raw: string | null): boolean {
  if (emptyList(raw)) return true;
  try {
    const v = JSON.parse(String(raw));
    if (!Array.isArray(v)) return false;
    return v.length === 1 && v[0] && typeof v[0] === "object" && (v[0] as { kind?: unknown }).kind === "error";
  } catch {
    return false;
  }
}

/**
 * Is this row the freshly written headstone of an empty turn, and therefore
 * reusable for the spontaneous turn that is arriving?
 */
export function isReusableHeadstone(
  riga: RowToReuse | null | undefined,
  oraMs: number,
  finestraMs: number = HEADSTONE_WINDOW_MS,
): boolean {
  if (!riga) return false;
  if (riga.role !== "assistant") return false;
  if (riga.partial) return false;
  if (!riga.content.startsWith(HEADSTONE_PREFIX)) return false;
  if (!emptyList(riga.toolCallsJson)) return false;
  if (!soloIlBloccoDErrore(riga.blocksJson)) return false;
  const nata = Date.parse(riga.timestamp);
  if (!Number.isFinite(nata)) return false;
  const eta = oraMs - nata;
  return eta >= 0 && eta <= finestraMs;
}
