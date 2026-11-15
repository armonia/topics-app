import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import { type BrowserWsMessage } from "../../shared/browser-ws-messages";
import { buildPresenceSnapshot } from "../presence";
import type { BootScope } from "../../server";

export function createBrowserWsPresence(d: {
  wsClients: BootScope["wsClients"];
  broadcastToAll: BootScope["broadcastToAll"];
  ctx: BootScope["ctx"];
}) {
  const { wsClients, broadcastToAll, ctx } = d;

  // Phase 30 BROWSER-CHAT-03 — registry of active /ws/browser/:contextId
  // connections keyed by contextId. Multiple panels may watch the same context
  // (UI plus E2E spies); the broadcast iterates the whole set. Populated by the
  // websocket.open browser branch and cleaned by websocket.close.
  const browserWsClients = new Map<string, Set<ServerWebSocket<WSData>>>();

  // Make that registry observable on `/api/system/status`, next to `wsClients`.
  // Two numbers, because they fail apart: `sockets` stuck above zero with every
  // pane closed means a `close` handler did not run; `contexts` stuck with
  // `sockets` at zero means the empty-Set delete did not. Cheap - the Map holds
  // one entry per open pane, so this walk is a handful of iterations per poll.
  ctx.browserWsCounts = () => {
    let sockets = 0;
    for (const set of browserWsClients.values()) sockets += set.size;
    return { contexts: browserWsClients.size, sockets };
  };

  // Cross-window presence: broadcast the FULL list of windows that have declared
  // their presence (via `hello`/`presence:announce`) plus the topics each holds.
  // A full-snapshot (not deltas) is trivially idempotent across reconnects; the
  // list self-heals because a dead socket drops out of `wsClients` before its
  // close handler re-broadcasts. Purely WS-ephemeral — nothing is persisted.
  // The dedup/build logic is pure in server/presence.ts (unit-tested).
  function broadcastPresence() {
    const windows = buildPresenceSnapshot(
      (function* () {
        // `alive`: un socket mezzo aperto (chiuso lato client senza che il close
        // handler sia scattato) restava una "finestra" per sempre — `wsClients`
        // lo ripulisce solo per quella via. Tutte le altre vie di broadcast qui
        // dentro filtrano già su readyState; questa era l'unica che non lo faceva.
        for (const client of wsClients) yield { ...client.data, alive: client.readyState === 1 };
      })(),
    );
    broadcastToAll({ type: 'presence:windows', windows });
  }

  function broadcastToBrowserWs(contextId: string, msg: BrowserWsMessage, except?: { data: unknown } | null): void {
    const set = browserWsClients.get(contextId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState !== 1 || (except && ws === except)) continue;
      try {
        ws.send(payload);
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[broadcastToBrowserWs] send failed for ${contextId}:`, m);
      }
    }
  }

  return { browserWsClients, broadcastPresence, broadcastToBrowserWs };
}
