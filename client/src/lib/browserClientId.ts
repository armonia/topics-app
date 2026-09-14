/**
 * THE STABLE NAME OF THIS PANE, ACROSS ITS SOCKETS.
 *
 * The server arbitrates who may resize a shared browser context, and to do that
 * it has to recognise a client that comes BACK: the Mac pane flipping from the
 * native executor to streaming, or reconnecting after the machine slept, is the
 * same client and must keep its place. The socket id cannot say that (it is new
 * every time) and neither can the paired device: on loopback there is no paired
 * device at all, the owner IS the machine and `evaluateIdentity` gives it
 * `deviceId: null`. Only a phone carries a device id.
 *
 * So the pane says who it is, once, and keeps saying it: an id in
 * `sessionStorage`, sent as `?client=` when the browser socket opens. In
 * `sessionStorage` and not in `localStorage` on purpose, and the difference is
 * the behaviour we want in both directions:
 *   - it survives a RELOAD of the same tab, which is exactly the reconnection
 *     the arbiter must see through;
 *   - it does NOT cross tabs or windows, so two panes of this same machine are
 *     two clients and the one that is only watching cannot reflow the page
 *     under the other. Two windows of one Mac are the same person, but they are
 *     not the same screen, which is what a viewport is about.
 *
 * The server never trusts this as an identity: it namespaces it under the
 * authenticated device (see `viewportClaimantOf`), so a guest cannot claim to
 * be the owner's pane.
 */

const KEY = 'topics-browser-client-id';

/**
 * Id of this pane, created on first use.
 *
 * Falls back to a per-call random id where there is no storage at all (a
 * hardened webview, a server-side render): the arbiter then treats the pane as
 * a newcomer on every socket, which is the behaviour it had before this id
 * existed, not a crash.
 */
export function browserClientId(): string {
  try {
    const seen = sessionStorage.getItem(KEY);
    if (seen) return seen;
    const born = crypto.randomUUID();
    sessionStorage.setItem(KEY, born);
    return born;
  } catch {
    return crypto.randomUUID();
  }
}
