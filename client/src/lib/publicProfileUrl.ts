/**
 * THE ADDRESS OF THE PUBLIC PROFILE PAGE, and the question the button has to
 * answer before it copies it: does this link reach anybody but me?
 *
 * The page is served by the local process. Under the Tauri shell the UI comes
 * from the embedded bundle, so `window.location.origin` is `tauri://localhost`
 * (macOS) or `http://tauri.localhost` (Windows/Linux): a scheme no browser can
 * open and a host no network resolves. Copying it hands over a link that is
 * broken for everyone, and the failure only shows up after pasting.
 *
 * There is no string that makes a personal machine reachable. What there is:
 * the relay, when it is on, and the truth otherwise. So this returns the best
 * address available AND how far it travels, and the caller says it out loud.
 */

/** Where the link can be opened from. */
export type PublicProfileReach = 'public' | 'lan' | 'thisComputer';

export interface RelayEndpoint {
  enabled: boolean;
  baseUrl: string | null;
  relayId: string | null;
}

export interface PublicProfileLink {
  /** Full URL, token included. `null` while the page is not published. */
  url: string | null;
  /** Base without the token: usable for display before publishing. */
  base: string;
  reach: PublicProfileReach;
  /** True only when someone on another machine can open it. */
  shareable: boolean;
}

/** Does this origin give an address a browser can actually open? */
function usableOrigin(origin: string): boolean {
  if (!origin) return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // The Tauri shell's own host on Windows/Linux: it resolves inside the
  // webview and nowhere else, not even on the machine that runs it.
  if (parsed.hostname === 'tauri.localhost') return false;
  return true;
}

function reachOf(origin: string): PublicProfileReach {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return 'thisComputer'; }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'thisComputer';
  if (/^127\./.test(host) || host === '::1' || host === '[::1]' || host === '0.0.0.0') return 'thisComputer';
  return 'lan';
}

/**
 * @param origin      the page origin (`window.location.origin`), which under
 *                    the desktop shell is not an address at all
 * @param serverOrigin the http origin of the data server as the shell knows it
 *                    (`serverHttpBase()`), '' when the server is same-origin
 * @param relay       the relay endpoint, when one is configured
 * @param token       the share token, `null` while unpublished
 */
export function publicProfileUrl(
  origin: string,
  serverOrigin: string,
  relay: RelayEndpoint | null,
  token: string | null,
): PublicProfileLink {
  if (relay?.enabled && relay.baseUrl && relay.relayId) {
    const base = `${relay.baseUrl}/i/${relay.relayId}/public/profile`;
    return { url: token ? `${base}/${token}` : null, base, reach: 'public', shareable: true };
  }
  // The page origin first: on web it IS the address other people would use.
  // The shell's origin is not an address, so there the server's own http base
  // takes over - loopback, and said as such.
  const chosen = usableOrigin(origin) ? origin : serverOrigin;
  const base = `${chosen}/public/profile`;
  const reach = usableOrigin(chosen) ? reachOf(chosen) : 'thisComputer';
  return { url: token ? `${base}/${token}` : null, base, reach, shareable: false };
}
