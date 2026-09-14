/**
 * The Cloudflare Workers globals this Worker actually touches, declared here
 * because `@cloudflare/workers-types` is NOT a dependency of this repo.
 *
 * WHY NOT THE REAL PACKAGE. `relay/src/*` imports `shared/relay-*.ts`, which
 * the Bun server imports too, so this program has to keep `lib.dom` and the
 * Bun globals. `@cloudflare/workers-types` redeclares `Request`, `Response`,
 * `WebSocket`, `Headers` and friends with workerd's own shapes: pulled into
 * the same program it collides with lib.dom on every one of them, and the way
 * out is a second copy of `shared/` compiled apart. Four names are cheaper.
 *
 * WHY IT IS SAFE TO HAND-WRITE THEM. Every member below has a call site in
 * `relay/src/`, and every call site is exercised by the relay tests against a
 * stand-in (`StatoFinto`, `CoppiaFinta`). A member nobody calls would be a
 * shape nobody checks, which is how a hand-written platform type drifts from
 * the platform. Keep the rule: add a name here only when the Worker uses it.
 *
 * If `@cloudflare/workers-types` ever becomes a dependency, delete this file
 * and split the tests into their own program. Do not keep both: two
 * declarations of `WebSocketPair` do not merge, they conflict.
 */

/** `new WebSocketPair()` returns the two ends of one socket: `[0]` goes back to
 *  the client in the 101, `[1]` is the end this Worker keeps. */
interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
declare const WebSocketPair: { new (): WebSocketPair };

/** The name of a Durable Object instance. Opaque on purpose: the Worker only
 *  ever mints one from a string and hands it straight back to `get`. */
interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/**
 * The 101 carries a socket, and that field exists only on workerd.
 *
 * Merged into the DOM `ResponseInit` rather than declared as a Workers-only
 * type: `new Response(null, { status: 101, webSocket })` is written inline, so
 * a separate name would have to be spelled at every call site and the one that
 * forgot it would be the one that compiles by cast.
 */
interface ResponseInit {
  webSocket?: WebSocket | null;
}
