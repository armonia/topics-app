/**
 * The Mac's native pane as the source of the DOM mirror (NATIVE-HOST-01..03).
 *
 * Before this, a second device watching a context pulled the Mac off its
 * WKWebView and onto the server's Chromium: every gesture took a round trip
 * through the server, the page ran twice, and the Mac felt it ("lentissimo",
 * 13/10). Now the native pane stays where it is and records its own DOM with
 * rrweb; the server is a relay. It keeps what a late viewer needs to rebuild the
 * page (the last Meta, FullSnapshot and the incrementals after it), rewrites the
 * resources only the Mac can reach, and forwards the viewers' input back to the
 * pane. No Chromium context exists while a host is live.
 *
 * Pure and transport-agnostic, like browser-native-delegate.ts: the host's
 * `send` is injected when it declares itself, so the protocol is tested without
 * a socket. The frames are raw, outside the browser-ws schema, for the same
 * reason the delegation frames are: that schema is the streaming protocol.
 */
import { rewriteDomEventResources } from "./dom-resource-rewrite";
import type { HostViewportCommand } from "../browser-host-viewport";

/** Server -> host pane. */
export type HostCommand =
  /** Someone is watching the mirror: arm the recorder and start draining. */
  | { type: "host_dom_start" }
  /** Nobody is watching any more: detach the recorder, stop draining. */
  | { type: "host_dom_stop" }
  /** A viewer needs a FullSnapshot the buffer cannot rebuild: take a fresh one. */
  | { type: "host_dom_snapshot" }
  /** A viewer touched the mirror: the same action and page coordinates it sent. */
  | { type: "host_input"; action: string; payload: unknown }
  /** A viewer moved the page: the pane runs it through its own toolbar path. */
  | { type: "host_nav"; action: "navigate" | "back" | "forward" | "reload"; url?: string }
  /** Another device is using the page: lay it out at its size, or (no size) at the pane's own. */
  | HostViewportCommand;

/** Where the host page is: what viewers show in their address bar. */
export interface HostPage {
  url: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

/** Host pane -> server. */
export type HostFrame =
  /** `used`: the person at the Mac used the page while its socket was down. */
  | { type: "native_dom_host"; used?: boolean }
  | { type: "host_dom_events"; events: unknown[] }
  /** The person at the Mac used the page in its own pane (a real gesture, not a relayed one). */
  | { type: "host_local_use" }
  | ({ type: "host_page" } & HostPage);

/** Classify a raw frame from a browser socket; null when it is not a host frame. */
export function parseHostFrame(raw: unknown): HostFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.type === "native_dom_host") return m.used === true ? { type: "native_dom_host", used: true } : { type: "native_dom_host" };
  if (m.type === "host_local_use") return { type: "host_local_use" };
  if (m.type === "host_dom_events") {
    return Array.isArray(m.events) ? { type: "host_dom_events", events: m.events } : null;
  }
  if (m.type === "host_page" && typeof m.url === "string") {
    return {
      type: "host_page",
      url: m.url,
      ...(typeof m.title === "string" ? { title: m.title } : {}),
      ...(typeof m.canGoBack === "boolean" ? { canGoBack: m.canGoBack } : {}),
      ...(typeof m.canGoForward === "boolean" ? { canGoForward: m.canGoForward } : {}),
    };
  }
  return null;
}

/** rrweb event types the buffer cares about. */
const META = 4;
const FULL_SNAPSHOT = 2;

/**
 * Incrementals kept after the last FullSnapshot. Past this the prefix is
 * dropped whole and the next viewer asks the host for a fresh snapshot: a
 * bootstrap with a hole in the middle replays into a broken mirror. A pointer
 * moving over the page alone emits ~20 events per second, so this fills in a
 * few minutes of use.
 */
export const MAX_HOST_INCREMENTALS = 4000;

interface HostEntry {
  owner: unknown;
  send: (cmd: HostCommand) => void;
  recording: boolean;
  meta: unknown | null;
  full: unknown | null;
  increments: unknown[];
  overflowed: boolean;
  /** A fresh snapshot was asked for and has not arrived yet. */
  snapshotPending: boolean;
}

export interface DomHostRegistry {
  /** The native executor of `contextId` says it can stream its DOM. The newer
   *  declaration wins: only the registered delegate reaches this (the caller
   *  checks), and a second one is that same pane after a reconnect. */
  declare(contextId: string, owner: unknown, send: (cmd: HostCommand) => void): void;
  /** The host socket went away. True when `owner` was the current host. */
  withdraw(contextId: string, owner: unknown): boolean;
  isHosting(contextId: string): boolean;
  isHost(contextId: string, owner: unknown): boolean;
  /** Start or stop the recorder on the host: wanted while a viewer has the mirror on screen. */
  setWanted(contextId: string, wanted: boolean): void;
  /** What a viewer that just joined the mirror replays now. Empty when it has
   *  to wait: the host's next snapshot reaches it as a broadcast. */
  bootstrap(contextId: string): unknown[];
  /** Events from the host, in order: buffered, rewritten, and returned for broadcast. */
  ingest(contextId: string, owner: unknown, events: unknown[]): unknown[];
  /** Record where the host page is. True when it moved. */
  notePage(contextId: string, owner: unknown, page: HostPage): boolean;
  /** The host page, or the last one a host reported before leaving (the
   *  server's Chromium takes over from there). */
  page(contextId: string): HostPage | null;
  /** Send a command to the host. False when there is none. */
  command(contextId: string, cmd: HostCommand): boolean;
}

export function createDomHostRegistry(maxIncrements = MAX_HOST_INCREMENTALS): DomHostRegistry {
  const hosts = new Map<string, HostEntry>();
  const pages = new Map<string, HostPage>();

  const clearBuffer = (h: HostEntry): void => {
    h.meta = null;
    h.full = null;
    h.increments = [];
    h.overflowed = false;
    h.snapshotPending = false;
  };
  const sendTo = (h: HostEntry, cmd: HostCommand): boolean => {
    try {
      h.send(cmd);
      return true;
    } catch {
      return false;
    }
  };
  const ownEntry = (contextId: string, owner: unknown): HostEntry | null => {
    const h = hosts.get(contextId);
    return h && h.owner === owner ? h : null;
  };

  return {
    declare(contextId, owner, send) {
      const h: HostEntry = {
        owner, send, recording: false,
        meta: null, full: null, increments: [], overflowed: false, snapshotPending: false,
      };
      hosts.set(contextId, h);
    },
    withdraw(contextId, owner) {
      if (!ownEntry(contextId, owner)) return false;
      hosts.delete(contextId);
      return true;
    },
    isHosting(contextId) {
      return hosts.has(contextId);
    },
    isHost(contextId, owner) {
      return ownEntry(contextId, owner) !== null;
    },
    setWanted(contextId, wanted) {
      const h = hosts.get(contextId);
      if (!h || h.recording === wanted) return;
      h.recording = wanted;
      // Either way the buffer starts over: a stopped recorder leaves a hole,
      // and a started one opens with its own Meta + FullSnapshot.
      clearBuffer(h);
      sendTo(h, { type: wanted ? "host_dom_start" : "host_dom_stop" });
    },
    bootstrap(contextId) {
      const h = hosts.get(contextId);
      if (!h || !h.recording) return [];
      if (h.overflowed) {
        if (!h.snapshotPending) {
          h.snapshotPending = true;
          sendTo(h, { type: "host_dom_snapshot" });
        }
        return [];
      }
      if (!h.full) return [];
      return h.meta ? [h.meta, h.full, ...h.increments] : [h.full, ...h.increments];
    },
    ingest(contextId, owner, events) {
      const h = ownEntry(contextId, owner);
      // Events of a recorder nobody asked for (a late drain after a stop) are
      // not forwarded: they would land on mirrors that were told to rebuild.
      if (!h || !h.recording) return [];
      const out: unknown[] = [];
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const e = event as { type?: number; data?: unknown };
        // Before buffering, so a viewer joining later gets the same URLs.
        rewriteDomEventResources(contextId, e);
        if (e.type === META) {
          h.meta = e;
        } else if (e.type === FULL_SNAPSHOT) {
          h.full = e;
          h.increments = [];
          h.overflowed = false;
          h.snapshotPending = false;
        } else if (!h.full) {
          // An increment with no snapshot under it since the recorder started
          // belongs to a page no mirror has: nobody could replay it.
          continue;
        } else if (!h.overflowed) {
          h.increments.push(e);
          if (h.increments.length > maxIncrements) {
            h.increments = [];
            h.overflowed = true;
          }
        }
        out.push(e);
      }
      return out;
    },
    notePage(contextId, owner, page) {
      if (!ownEntry(contextId, owner)) return false;
      const prev = pages.get(contextId);
      pages.set(contextId, page);
      return !prev || prev.url !== page.url || prev.title !== page.title
        || prev.canGoBack !== page.canGoBack || prev.canGoForward !== page.canGoForward;
    },
    page(contextId) {
      return pages.get(contextId) ?? null;
    },
    command(contextId, cmd) {
      const h = hosts.get(contextId);
      return h ? sendTo(h, cmd) : false;
    },
  };
}
