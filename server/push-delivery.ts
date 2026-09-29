/**
 * THE WIRE of a web push: one signed, encrypted POST per device, and one log
 * line per outcome.
 *
 * Why this is its own module and not the body of `sendPushToAll`:
 *
 *  · PROOF. `push-service` is replaced wholesale by `push-triggers.test.ts`
 *    (`mock.module`), and in Bun a module mock outlives the file that declares
 *    it. A test that imported `push-service` to measure the delivery could get
 *    the fake and pass having measured nothing. This module is never mocked, so
 *    its test drives the REAL signing and encryption against a fake push
 *    endpoint.
 *
 *  · THE COUNT WAS A LIE. The old loop wrapped every `sendNotification` in a
 *    `.catch()` and then counted `fulfilled` results, so a push that Apple
 *    rejected was still reported as "Sent to 1/1". Here each outcome is decided
 *    from the HTTP status the push service returned, and logged as such.
 *
 *  · SILENCE WAS THE DEFAULT. With zero subscriptions the old code returned
 *    without a word, which is exactly the state this install sat in for months:
 *    nothing in the log said that no device would ever be reached.
 *
 * The request itself is composed by `web-push` (`generateRequestDetails`: VAPID
 * JWT + aes128gcm payload) and sent with `fetch`, so the path the test drives is
 * the path production takes, and the push service's own refusal reason (Apple
 * answers `{"reason":"BadJwtToken"}` and the like) lands in the log line.
 */
import webpush from "web-push";

/** A row that can be delivered to: flat columns, as SQLite returns them. */
export interface DeliveryTarget {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  /** The per-device JSON payload, already built by the caller. */
  body: string;
  /** Human label of the device ("iPhone", "Mac"): the log names a device, never its endpoint. */
  label: string | null;
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** What one POST to a push service returned. */
export interface PushResponse {
  status: number;
  text: string;
}

/** Sends one composed request. Injected in tests; `fetch` in production. */
export type PushTransport = (request: {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer> | null;
}) => Promise<PushResponse>;

export interface DeliverySummary {
  delivered: number;
  failed: number;
  /** Subscriptions the push service declared gone (404/410), removed from the table. */
  expired: string[];
}

/** A push service that never answers must not hold a turn-end hostage. */
const SEND_TIMEOUT_MS = 15_000;

/** How long the push service keeps a message for an offline device: one day. */
const TTL_SECONDS = 24 * 60 * 60;

const fetchTransport: PushTransport = async ({ endpoint, method, headers, body }) => {
  const res = await fetch(endpoint, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text().catch(() => "") };
};

/** Scheme + host of the endpoint: enough to tell Apple from Mozilla from Google, never the capability path. */
function pushHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Deliver one payload to every target. Never throws: each failure is a log
 * line and a count, because a broken device must not stop the others.
 *
 * `onExpired` is called for a 404/410, the push service's way of saying the
 * subscription no longer exists: the caller removes the row.
 */
export async function deliverPush(
  targets: readonly DeliveryTarget[],
  opts: {
    tag: string;
    vapid: VapidDetails;
    onExpired: (endpoint: string) => void;
    transport?: PushTransport;
    log?: (line: string) => void;
  },
): Promise<DeliverySummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const transport = opts.transport ?? fetchTransport;
  const summary: DeliverySummary = { delivered: 0, failed: 0, expired: [] };

  if (targets.length === 0) {
    log(`[Push] not sent tag=${opts.tag}: no subscribed device (push_subscriptions has no deliverable row)`);
    return summary;
  }

  await Promise.all(targets.map(async (target) => {
    const who = `to=${JSON.stringify(target.label ?? "unknown device")} via=${pushHost(target.endpoint)}`;
    let response: PushResponse;
    try {
      const details = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: { p256dh: target.keys_p256dh, auth: target.keys_auth } },
        target.body,
        { vapidDetails: opts.vapid, TTL: TTL_SECONDS, contentEncoding: "aes128gcm" },
      );
      const headers: Record<string, string> = {};
      // `fetch` computes the length from the body itself.
      for (const [name, value] of Object.entries(details.headers)) {
        if (name.toLowerCase() !== "content-length") headers[name] = String(value);
      }
      response = await transport({
        endpoint: details.endpoint,
        method: details.method,
        headers,
        body: details.body ? new Uint8Array(details.body) : null,
      });
    } catch (err) {
      summary.failed++;
      log(`[Push] FAILED tag=${opts.tag} ${who} error=${oneLine((err as Error)?.message || String(err))}`);
      return;
    }

    if (response.status >= 200 && response.status < 300) {
      summary.delivered++;
      log(`[Push] delivered tag=${opts.tag} ${who} status=${response.status}`);
      return;
    }
    if (response.status === 404 || response.status === 410) {
      summary.expired.push(target.endpoint);
      try { opts.onExpired(target.endpoint); } catch { /* the log line below still says what happened */ }
      log(`[Push] expired tag=${opts.tag} ${who} status=${response.status}: subscription removed, the device must subscribe again`);
      return;
    }
    summary.failed++;
    log(`[Push] FAILED tag=${opts.tag} ${who} status=${response.status} reason=${oneLine(response.text) || "(empty body)"}`);
  }));

  log(`[Push] tag=${opts.tag} delivered ${summary.delivered}/${targets.length}`
    + (summary.failed ? `, failed ${summary.failed}` : "")
    + (summary.expired.length ? `, expired ${summary.expired.length}` : ""));
  return summary;
}
