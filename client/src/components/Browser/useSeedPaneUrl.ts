/**
 * Seeding a pane's server context with the url the pane is supposed to be on.
 *
 * Lifted out of RemoteBrowserPanel unchanged in behaviour: it is one
 * self-contained decision with two probes and a piece of state, and it was the
 * largest single block in a file the bloat gate already watches.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isLoopbackUrl } from './navErrorMessage';
import { loopbackAlive } from '../../lib/loopbackAlive';
import { contextHasPage } from '../../lib/contextHasPage';


/**
 * Whether a persisted pane url is safe to auto-seed into a blank server-side
 * browser context (streaming path). A pane's url can point at a host reachable
 * ONLY from the machine that owns the native pane — a bare hostname ("macbook"),
 * a *.local name, loopback, or a private-LAN IP. Seeding those hangs the headless
 * goto → ERR_CONNECTION_REFUSED, worse than an honest blank pane. Only public
 * http(s) hosts (a registrable dotted name or a public IP) are seedable.
 */
function canSeedUrl(raw: string | undefined): raw is string {
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  let host: string;
  try { host = new URL(raw).hostname; } catch { return false; }
  if (!host) return false;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') return false;
  if (lower.endsWith('.local') || lower.endsWith('.localhost')) return false;
  // Bare single-label hostname (no dot) → not publicly resolvable (e.g. "macbook").
  const isIPv6 = host.includes(':');
  if (!isIPv6 && !host.includes('.')) return false;
  // Private / link-local IPv4 ranges.
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

export type DeadLoopback = { url: string; checkedAt: Date };

export function useSeedPaneUrl(args: {
  contextId: string;
  connected: boolean;
  knownPaneUrl: string | undefined;
  navigate: (url: string) => void;
}): {
  deadLoopback: DeadLoopback | null;
  retryDeadLoopback: () => void;
  dismissDeadLoopback: () => void;
} {
  const { contextId, connected, knownPaneUrl, navigate } = args;

    // Seed a blank server context with the pane's persisted URL (initialUrl). A
  // browser pane's page can live entirely on ANOTHER client — most notably the
  // Mac's NATIVE WKWebView pane (Tauri path), which never touches this server
  // context. Without this, a web/mobile client connecting to that context finds
  // it blank and sits at "Browser ready" instead of showing the page. The Tauri
  // path already navigates to initialUrl on mount (useTauriBrowser); this is its
  // streaming-path counterpart. Fire once, and only when the server context is
  // genuinely blank — never clobber a context already on a live page.
  //
  // LOOPBACK IS SEEDED TOO, AFTER ASKING WHETHER ANYONE IS THERE.
  //
  // The defect this closes (card 30f55ca9): on the web client a pane opened
  // from the chat on a loopback address stayed on the new-tab page forever. The
  // framable probe refuses every loopback by design (its SSRF guard must not be
  // loosened), so there is no iframe; and this seed — the streaming fallback the
  // requirement asks for — refused loopback wholesale, so nothing navigated at
  // all. The pane held the right URL in its store and showed a blank new tab.
  //
  // The original refusal was not wrong about its own case: a DEAD preview port
  // hangs the server-side goto for 30s and then fails. But "dead" is a question
  // with an answer, `/api/browsers/port-listening`, which is loopback-only and
  // costs one TCP connect. So the rule splits in two, and neither half is a
  // silence: the port answers and the pane loads it through the server (which
  // runs on the same machine, so it CAN reach it); nothing answers and the pane
  // says which port is dead and when it looked.
  const [deadLoopback, setDeadLoopback] = useState<{ url: string; checkedAt: Date } | null>(null);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !connected) return;
    // The url the pane IS on, from the store or from the mount seed. Reading
    // `initialUrl` alone missed the case this card is about: a chat-opened pane
    // gets its url through the pane store, and its `initialUrl` is empty.
    const seedUrl = knownPaneUrl;
    if (!seedUrl || !/^https?:\/\//i.test(seedUrl)) return;
    const loopback = isLoopbackUrl(seedUrl);
    // Every OTHER not-publicly-reachable host keeps the old refusal: a bare
    // hostname, a .local name, a private-LAN address can be reachable from the
    // machine that owns the native pane and from nowhere else, and there is no
    // cheap probe that can tell.
    if (!canSeedUrl(seedUrl)) return;
    let stopped = false;
    // WHETHER THE CONTEXT IS ALREADY IN USE IS A QUESTION FOR THE SERVER.
    //
    // It used to be answered by comparing two local strings, and that answer is
    // wrong in both directions. `browser.url` holds the url the pane was OPENED
    // on, before anything has loaded it, so "not blank" skipped the navigation
    // in exactly this card's case; and treating `current === seedUrl` as "not
    // loaded yet" reloads a context that IS on that page, because once
    // `onUrlChange` has persisted the url the two strings are always equal.
    // That second one costs a live page: a client reload or a second device
    // refills the url within milliseconds, the timer fires, and `page.goto`
    // throws away scroll, a half-filled form and session state for everyone
    // watching a shared session.
    //
    // `contextHasPage` asks the only party that can tell the difference: the
    // server answers 404 while no context exists, which is the whole of this
    // card's case, and reports the real url once one does.
    const stillNeedsSeed = async (): Promise<boolean> => {
      if (stopped || seededRef.current) return false;
      const busy = await contextHasPage(contextId);
      return !stopped && !seededRef.current && !busy;
    };
    const t = setTimeout(() => {
      void (async () => {
        if (!(await stillNeedsSeed())) {
          if (!stopped) seededRef.current = true;
          return;
        }
        if (!loopback) {
          seededRef.current = true;
          navigate(seedUrl);
          return;
        }
        const alive = await loopbackAlive(seedUrl);
        // Ask again: the probe is a round trip, and a real navigation may have
        // landed meanwhile. Seeding over that one would be a reload.
        if (!(await stillNeedsSeed())) return;
        seededRef.current = true;
        if (alive) navigate(seedUrl);
        else setDeadLoopback({ url: seedUrl, checkedAt: new Date() });
      })();
    }, 400);
    return () => { stopped = true; clearTimeout(t); };
    // Every dep here is a plain argument of the hook, so the exhaustive-deps
    // rule is satisfied on its own and the old disable directive is gone. The
    // pane's CURRENT url is deliberately not among them: the seed no longer
    // reads it (the server answers that question), and while it was a dep every
    // url the pane reported restarted the 400 ms timer.
  }, [connected, knownPaneUrl, navigate, contextId]);

  // Looking again is the whole point of the button: the port that was dead a
  // minute ago is the dev server you have just restarted.
  const retryDeadLoopback = useCallback(() => {
    const url = deadLoopback?.url;
    if (!url) return;
    setDeadLoopback(null);
    void loopbackAlive(url).then((alive) => {
      if (alive) navigate(url);
      else setDeadLoopback({ url, checkedAt: new Date() });
    });
  }, [deadLoopback, navigate]);

  const dismissDeadLoopback = useCallback(() => setDeadLoopback(null), []);

  return { deadLoopback, retryDeadLoopback, dismissDeadLoopback };
}
