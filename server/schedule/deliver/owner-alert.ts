/**
 * AN ALERT TO THE OWNER: A SUBJECT, A KEY, QUIET HOURS (rule R24).
 *
 * The door is generic on purpose: a job that failed three times in a row calls
 * it today, and the arrival of mail (which is not a job of the engine) calls
 * the same function. The caller gives:
 *  - `subject`: whose row it is on the bell (`job:<id>`), so it counts;
 *  - `scope`: the anti-duplicate key. One alert per scope and local day;
 *  - the text.
 * In quiet hours nothing is written and `quiet` is returned: the caller asks
 * again at its next beat, so the alert comes out in the morning. Outside the
 * app it goes through the same adapter and the same once-only register, to the
 * owner destination, when both are configured.
 */
import type { Database } from "bun:sqlite";
import { recordSubjectNotice } from "../../attention/owner-notices";
import { isQuietNow, localClock, type DeliverySettings } from "./settings";
import type { Sender } from "./send";

export type OwnerAlertResult = "sent" | "already_today" | "quiet";

export interface OwnerAlertRequest { subject: string; scope: string; title: string; body: string; jobId?: string }

export interface OwnerAlertOptions {
  db: Database;
  sender: Sender;
  settings: () => DeliverySettings;
  now?: () => Date;
  /** Writes the row on the bell. Production: `recordSubjectNotice`. */
  notice?: (row: { subject: string; title: string; body: string; dedupeKey: string }) => void;
}

export function createOwnerAlert(options: OwnerAlertOptions) {
  const now = options.now ?? (() => new Date());
  const notice = options.notice ?? recordSubjectNotice;

  return function raise(request: OwnerAlertRequest): OwnerAlertResult {
    const config = options.settings();
    const at = now();
    if (isQuietNow(config.quietHours, at)) return "quiet";
    const day = localClock(at, config.quietHours?.tz ?? null).day;
    const fresh = options.db.prepare("INSERT INTO owner_alerts (scope, day, sent_at) VALUES (?, ?, ?) ON CONFLICT(scope, day) DO NOTHING")
      .run(request.scope, day, at.toISOString()).changes === 1;
    if (!fresh) return "already_today";
    const dedupeKey = `alert:${request.scope}:${day}`;
    notice({ subject: request.subject, title: request.title, body: request.body, dedupeKey });
    if (config.owner) {
      void options.sender({
        key: dedupeKey, kind: "alert", text: `${request.title}\n${request.body}`,
        values: { ...config.owner, title: request.title, jobId: request.jobId ?? "", runId: "" },
      }).catch((error) => console.warn("[schedule] alert delivery failed:", error));
    }
    return "sent";
  };
}

export type OwnerAlert = ReturnType<typeof createOwnerAlert>;
