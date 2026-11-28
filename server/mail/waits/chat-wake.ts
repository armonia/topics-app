/**
 * THE WAKE OF A CHAT (rule P4): one turn, keyed by the wait id, marked as the machine's.
 *
 * The request goes through the chat route of this process, the way the wake at
 * the end of a command does (`lib/process-exit-wake.ts`), once the session has
 * no turn in flight. The key is the durable one of the route
 * (`x-idempotency-key`, written on the user row): a restart between the turn
 * and the mark `delivered` sends the wake again and the route answers
 * `duplicate_message`, which is the proof the turn already exists. The row is
 * marked as the board's words (`cardOutcome`), so the transcript never shows a
 * person saying it.
 */
import type { MailWait } from "./store";
import { sleep } from "../../lib/unref-sleep";

type ChatRoute = (req: Request, url: URL, pathname: string, method: string) => Response | null | Promise<Response | null>;

const END_GRACE_MS = 20_000;
export const MAIL_WAKE_KEY_PREFIX = "mail-wait:";

export interface ChatWakeDeps {
  route: ChatRoute;
  /** A turn in flight on the session. */
  isBusy(sessionKey: string): boolean;
  /** False when the chat is archived or gone. */
  chatOpen(sessionKey: string): boolean;
  /** True while the chat's provider is held: the wake waits for the hold to lift. */
  providerHeld?(sessionKey: string): boolean;
  log?: (message: string) => void;
  pollMs?: number;
}

export function chatWake(deps: ChatWakeDeps): (wait: MailWait) => Promise<"done" | "retry" | "gone"> {
  return async (wait) => {
    const sessionKey = wait.ownerId;
    if (!deps.chatOpen(sessionKey)) return "gone";
    if (deps.isBusy(sessionKey) || deps.providerHeld?.(sessionKey)) return "retry";
    const url = new URL("http://localhost/api/chat");
    const resp = await deps.route(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-idempotency-key": `${MAIL_WAKE_KEY_PREFIX}${wait.id}` },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: wait.wakeText ?? "" }], cardOutcome: true }),
      }),
      url, "/api/chat", "POST",
    );
    if (resp?.status === 409) {
      const code = ((await resp.json().catch(() => null)) as { code?: unknown } | null)?.code;
      if (code === "duplicate_message") return "done";
      if (code === "stream_in_flight") return "retry";
      deps.log?.(`${wait.id}: the chat route answered 409 ${String(code ?? "without a code")}`);
      return "retry";
    }
    if (!resp?.ok) {
      deps.log?.(`${wait.id}: the chat route answered ${resp?.status ?? "nothing"}`);
      return "retry";
    }
    // The turn runs inside the stream: read it to its end so the next wake of the session waits for it.
    if (resp.body) {
      const reader = resp.body.getReader();
      let read = reader.read();
      let freeSince: number | null = null;
      for (;;) {
        const step = await Promise.race([read, sleep(deps.pollMs ?? 500).then(() => null)]);
        if (step?.done) break;
        if (step) read = reader.read();
        if (deps.isBusy(sessionKey)) { freeSince = null; continue; }
        // A stream left open after its turn ended: the session free for the grace is the end.
        freeSince ??= Date.now();
        if (Date.now() - freeSince >= END_GRACE_MS) { void reader.cancel().catch(() => {}); break; }
      }
    }
    return "done";
  };
}
