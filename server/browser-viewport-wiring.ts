/**
 * THE WIRING BETWEEN THE BROWSER SOCKETS AND THE VIEWPORT ARBITER.
 *
 * `browser-viewport-arbiter.ts` holds the RULE (who may resize a shared page)
 * and is pure. This file holds the other half, which turned out to be where the
 * bugs actually were: translating a WebSocket into a claimant, and calling the
 * arbiter on the five events that move it (open, native registration, input,
 * resize, close). That half used to live inline in `server.ts`, and inline it
 * was reachable only by an end-to-end test with a real Chromium, which does not
 * run on pull requests. Two independent reviews found real regressions in these
 * few lines while every unit test stayed green. It is a module so that the
 * translation and the calls can be driven directly, in milliseconds.
 *
 * THE IDENTITY OF THE MAC IS THE INTERESTING PART. The arbiter keys on the
 * DEVICE, and the device id comes from the pairing of a remote client. The Tauri
 * shell, though, loads the app from the local server through its own proxy, so
 * it arrives over loopback, and loopback is the owner BY DEFINITION: no pairing,
 * no session, `deviceId === null` (see `evaluateIdentity` in
 * `server/lib/device-auth.ts`). Falling back to the socket id there put the Mac
 * back exactly where the socket-keyed version had it: the shell swaps its native
 * socket for a streaming one when the pane goes shared, the new socket arrives
 * after the phone, and the phone, which is merely watching, keeps the viewport.
 * Only a PAIRED phone had a stable identity, which is the opposite of what the
 * rule is for.
 *
 * So loopback is one claimant, `LOOPBACK_OWNER`: it is the machine the server
 * runs on, and every pane on it is the same person at the same desk. Two windows
 * on that machine now share the wheel, and that is the intended reading: they
 * are one device. A REMOTE client without a device id keeps the socket-shaped
 * behaviour, because there is nothing else to key it on and guests must not all
 * collapse into a single shared identity.
 */
import {
  createViewportArbiter,
  isDrivingInput,
  type ViewportArbiter,
  type ViewportClient,
} from './browser-viewport-arbiter';

/**
 * The claimant key shared by every pane that reaches the server over loopback.
 * Not a socket id and not a device id: it stands for the owner of the machine,
 * who has no pairing record precisely because being on the machine is proof
 * enough. The `@` keeps it from ever colliding with a real device id (a uuid).
 */
export const LOOPBACK_OWNER = 'owner@loopback';

/** The part of a browser socket this file needs. `WSData` satisfies it. */
export interface ViewportSocket {
  /** Socket id, unique per connection. */
  id: string;
  /** Paired device behind the socket, or null (loopback owner, daemon). */
  deviceId?: string | null;
  /** What the pane calls itself (`?client=`), stable across its sockets. */
  clientId?: string | null;
  /**
   * Was there a network between this socket and its peer, as stamped at the
   * upgrade. Absent means nobody classified it, which the rest of the server
   * reads as local (see `WSData.remote`), and so does this file.
   */
  remote?: boolean;
}

/** A socket we can talk back to, to ask a pane for its size. */
export interface ViewportSink {
  readyState: number;
  data: ViewportSocket;
  send(payload: string): unknown;
}

/** Who is claiming the viewport behind this socket. */
export function viewportClaimantOf(socket: ViewportSocket): ViewportClient {
  // WHO the socket belongs to. The paired device first, and on loopback there
  // is none to have: the owner IS this machine and `evaluateIdentity` hands it
  // `deviceId: null`. Note the tunnel, which looks like the opposite trap: a
  // phone reaching us through it has a loopback peer address (the other end of
  // that socket is `relay-client.ts`, here) and is stamped `remote: false`, so
  // asked about the network it says "local" while carrying a device id all the
  // same. Asking WHO first is what keeps that phone a phone.
  const owner = socket.deviceId ?? (socket.remote !== true ? LOOPBACK_OWNER : null);

  // WHICH PANE of that owner, when it told us (`?client=`). Namespaced under
  // the owner and never read on its own: a guest that claimed the owner's pane
  // name would still be a guest here. Without it the pane is its socket, which
  // is a new client on every reconnection: that is the old bug, kept only for
  // whoever does not send the id at all.
  if (owner && socket.clientId) {
    return { socket: socket.id, device: `${owner}/${socket.clientId}`, owner };
  }
  return { socket: socket.id, device: owner ?? socket.id, owner: owner ?? undefined };
}

/**
 * The frames of the client protocol that carry a viewport claim. Shaped as the
 * parsed message already is (`shared/browser-ws-messages.ts`), so the server
 * branch hands over what it has without building anything.
 */
export type ViewportFrame =
  | { type: 'input'; action: string }
  | {
      type: 'resize';
      width: number;
      height: number;
      deviceScaleFactor?: number;
      /**
       * The pane saying this size comes with an input it just sent. It has to be
       * said out loud because input can go down the WebRTC DataChannel straight
       * to the sidecar, and then no `input` frame ever reaches this file.
       */
      driving?: boolean;
    };

/** What the wiring did with a frame. Returned for the log and for the test. */
export type ViewportVerdict =
  /** A `resize` from the driver: the shared page was resized. */
  | 'applied'
  /** A `resize` from a spectator: dropped, silently and on purpose. */
  | 'dropped'
  /** An `input`: the claim, if any, was recorded. Nothing to apply. */
  | 'noted';

export interface ViewportWiring {
  /** A browser socket opened: arrival order decides until somebody types. */
  onOpen(contextId: string, socket: ViewportSocket): void;
  /** This socket declared itself the native executor: it leaves the audience. */
  onNativeExecutor(contextId: string, socket: ViewportSocket): void;
  /**
   * A client frame that bears on the viewport arrived. THE DECISION AND THE
   * APPLICATION ARE BOTH HERE, and that is the point: while the server branch
   * held `if (!onResize(...)) return; browserService.resize(...)`, deleting the
   * `if` or hardcoding the claim to `false` was invisible to every test that
   * does not boot a Chromium. There is nothing left in that branch to mutate
   * but the call itself, which the textual gate sees.
   */
  onFrame(contextId: string, socket: ViewportSocket, frame: ViewportFrame): ViewportVerdict;
  /**
   * A browser socket closed. Returns the device that INHERITS the viewport when
   * the departure changed hands, for `askViewportOf`. The asking is a second
   * step on purpose: it must happen once the leaving socket is out of the
   * broadcast set, so the question cannot be answered by the pane that left.
   */
  onClose(contextId: string, socket: ViewportSocket): string | undefined;
  /**
   * Ask that device's panes for their size. Without the question the page keeps
   * the size of whoever left: the heir sent this size once already and its pane
   * deduplicates it (`useRemoteBrowser`), so it will never say it again.
   */
  askViewportOf(contextId: string, device: string): void;
  /** Which device owns the viewport right now (for logs and tests). */
  driverDevice(contextId: string): string | undefined;
}

export interface ViewportWiringDeps {
  /** The live browser sockets of a context, as the broadcast set knows them. */
  socketsOf(contextId: string): Iterable<ViewportSink> | undefined;
  /**
   * Hand a size to the shared page. Called ONLY for a frame that won the
   * arbitration, which is why it is injected here instead of being called by
   * the server next to the question: one door, and the question is inside it.
   */
  resize(contextId: string, width: number, height: number, deviceScaleFactor?: number): void;
  /** Injected for the test; the arbiter is created here otherwise. */
  arbiter?: ViewportArbiter;
}

export function createViewportWiring(deps: ViewportWiringDeps): ViewportWiring {
  const arbiter = deps.arbiter ?? createViewportArbiter();

  return {
    onOpen(contextId, socket) {
      arbiter.noteConnect(contextId, viewportClaimantOf(socket));
    },
    onNativeExecutor(contextId, socket) {
      arbiter.noteExecutor(contextId, viewportClaimantOf(socket));
    },
    onFrame(contextId, socket, frame) {
      const client = viewportClaimantOf(socket);
      if (frame.type === 'input') {
        // Using the page is what makes a client the driver of its viewport.
        // `mousemove` is not using it: see the arbiter.
        if (isDrivingInput(frame.action)) arbiter.noteInput(contextId, client);
        return 'noted';
      }
      if (frame.driving === true) arbiter.noteInput(contextId, client);
      if (!arbiter.canResize(contextId, client)) return 'dropped';
      deps.resize(contextId, frame.width, frame.height, frame.deviceScaleFactor);
      return 'applied';
    },
    onClose(contextId, socket) {
      return arbiter.noteDisconnect(contextId, viewportClaimantOf(socket));
    },
    askViewportOf(contextId, device) {
      for (const sink of deps.socketsOf(contextId) ?? []) {
        if (sink.readyState !== 1) continue;
        if (viewportClaimantOf(sink.data).device !== device) continue;
        try {
          sink.send(JSON.stringify({ type: 'viewport_request' }));
        } catch {
          // Socket already gone: the next pane on the list may still answer.
        }
      }
    },
    driverDevice(contextId) {
      return arbiter.driverDevice(contextId);
    },
  };
}
