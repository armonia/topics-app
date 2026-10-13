/**
 * THE NAVIGATIONS A CONTEXT IS WAITING ON, AND WHO HEARS ABOUT THEM.
 *
 * A pane that cannot reach its page has to say so to whoever is looking at it,
 * a device that arrives while the server is still waiting included. On 13/10
 * an iPad opened a tab whose page lived on a dev server of the Mac that took
 * connections and never answered. The server's goto waited its 30 s, twice,
 * and the pane said "starting the shared session" for as long as anybody looked.
 * Three things were missing, and they are this file:
 *
 *   - the outcome went to the socket that had asked, and that socket was gone:
 *     the iPad had reloaded in the meantime;
 *   - the reloaded pane asked for the same url again, which aborted the goto
 *     already running and started the 30 s over;
 *   - a socket opening in the middle heard nothing at all, neither "loading"
 *     nor "failed".
 *
 * So the outcome is published to every viewer of the context, a second request
 * for the url being loaded joins the first, and `replay` tells a newcomer where
 * things stand. Pure, with the clock and the publisher injected.
 */

/** What every viewer of a context hears about its navigations. */
export type NavFlightMessage =
  | { type: "nav"; phase: "loading"; url: string; elapsedMs: number }
  | { type: "nav"; phase: "error"; url: string; error: string };

export interface NavFlightDeps {
  publish(contextId: string, msg: NavFlightMessage): void;
  now?: () => number;
}

export interface NavFlight {
  /**
   * Run `go` toward `url`, or join the run already going there. A run toward
   * ANOTHER url is not joined: the newer request wins, as in any browser.
   */
  run<R extends { error?: string }>(contextId: string, url: string, go: () => Promise<R>): Promise<R>;
  /** Is the context waiting on a navigation right now? */
  inFlight(contextId: string): boolean;
  /** What a socket that opens now should be told, if anything. */
  replay(contextId: string): NavFlightMessage | null;
  /** A page loaded by any route: an old failure no longer describes it. */
  noteLoaded(contextId: string): void;
  /** The context is gone. */
  forget(contextId: string): void;
}

interface Flight {
  url: string;
  startedAt: number;
  done: Promise<unknown>;
}

export function createNavFlight(deps: NavFlightDeps): NavFlight {
  const now = deps.now ?? (() => Date.now());
  const flights = new Map<string, Flight>();
  const failures = new Map<string, { url: string; error: string }>();

  const settle = (contextId: string, flight: Flight, error: string | undefined): void => {
    // A newer navigation took over: its outcome is the one that counts.
    if (flights.get(contextId) !== flight) return;
    flights.delete(contextId);
    if (error === undefined) {
      failures.delete(contextId);
      return;
    }
    failures.set(contextId, { url: flight.url, error });
    deps.publish(contextId, { type: "nav", phase: "error", url: flight.url, error });
  };

  return {
    run(contextId, url, go) {
      const running = flights.get(contextId);
      if (running && running.url === url) return running.done as ReturnType<typeof go>;
      const flight: Flight = { url, startedAt: now(), done: Promise.resolve() };
      const done = (async () => {
        try {
          const result = await go();
          settle(contextId, flight, result.error);
          return result;
        } catch (err) {
          settle(contextId, flight, err instanceof Error ? (err.message.split("\n")[0] || "Navigation failed") : String(err));
          throw err;
        }
      })();
      flight.done = done;
      flights.set(contextId, flight);
      failures.delete(contextId);
      deps.publish(contextId, { type: "nav", phase: "loading", url, elapsedMs: 0 });
      return done;
    },
    inFlight: (contextId) => flights.has(contextId),
    replay(contextId) {
      const flight = flights.get(contextId);
      if (flight) return { type: "nav", phase: "loading", url: flight.url, elapsedMs: Math.max(0, now() - flight.startedAt) };
      const failure = failures.get(contextId);
      return failure ? { type: "nav", phase: "error", ...failure } : null;
    },
    noteLoaded(contextId) {
      failures.delete(contextId);
    },
    forget(contextId) {
      flights.delete(contextId);
      failures.delete(contextId);
    },
  };
}
