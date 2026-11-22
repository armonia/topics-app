/** Waiting for a person to finish a login the agent never types itself. */

// Path fragments that mean "still on the way in": the sign-in form itself plus
// the second-factor, passkey and consent screens that follow it.
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|sessions?(\/new)?|auth(orize|enticate)?|sso|oauth|two-factor|2fa|mfa|verify|challenge|passkey|password|u\/login)(\/|$|\?)/i;

export function looksLikeLogin(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_PATH.test(u.pathname) || /^(login|signin|accounts|auth|sso|id)\./i.test(u.hostname);
  } catch {
    return false;
  }
}

/** The page left the login: it is no longer a login URL and it is not the one we started on. */
export function hasLeftLogin(startUrl: string, currentUrl: string): boolean {
  if (!currentUrl || currentUrl === "about:blank") return false;
  if (looksLikeLogin(currentUrl)) return false;
  return currentUrl.split("#")[0] !== startUrl.split("#")[0];
}

export interface LoginWaitOptions {
  /** Reads the pane's current URL; null when it cannot be read this time. */
  readUrl: () => Promise<string | null>;
  startUrl: string;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type LoginWaitResult = { status: "logged_in"; url: string } | { status: "timeout"; url: string };

export async function waitForLoginExit(opts: LoginWaitOptions): Promise<LoginWaitResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  let last = opts.startUrl;
  while (now() < deadline) {
    const url = await opts.readUrl().catch(() => null);
    if (url) {
      last = url;
      if (hasLeftLogin(opts.startUrl, url)) return { status: "logged_in", url };
    }
    await sleep(opts.intervalMs);
  }
  return { status: "timeout", url: last };
}
