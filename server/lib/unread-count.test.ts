/**
 * La politica di lettura, fissata.
 *
 * Fino al 05/08/2026 questa logica viveva nella closure di
 * `createTopicsRouter` e non aveva un solo test: il gate «presente = letto» che
 * il commento del modulo racconta è stato tolto senza che niente lo impedisse
 * di tornare. Questi casi esistono perché torni rosso.
 *
 * @covers UNREAD-01
 */
import { describe, expect, it } from "bun:test";
import { bumpUnreadCount, type UnreadDeps } from "./unread-count";
import type { UnreadData } from "../../shared/types";

function harness(initial: UnreadData = {}) {
  let store: UnreadData = structuredClone(initial);
  const broadcasts: Array<Record<string, unknown>> = [];
  const deps: UnreadDeps = {
    loadUnread: () => store,
    saveUnread: (d) => { store = d; },
    broadcastToAll: (m) => { broadcasts.push(m as unknown as Record<string, unknown>); },
  };
  return { deps, broadcasts, read: () => store };
}

describe("bumpUnreadCount", () => {
  it("crea la riga quando la topic non ne ha una, e parte da 1", () => {
    const h = harness();
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1.unreadCount).toBe(1);
    expect(typeof h.read().t1.lastReadAt).toBe("string");
  });

  it("incrementa SEMPRE, anche a raffica: nessun collasso di messaggi vicini", () => {
    const h = harness();
    bumpUnreadCount(h.deps, "t1");
    bumpUnreadCount(h.deps, "t1");
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1.unreadCount).toBe(3);
  });

  it("non tocca il non-letto delle altre topic", () => {
    const h = harness({
      t1: { lastReadAt: "2026-08-01T00:00:00.000Z", unreadCount: 4 },
      t2: { lastReadAt: "2026-08-01T00:00:00.000Z", unreadCount: 9 },
    });
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1.unreadCount).toBe(5);
    expect(h.read().t2.unreadCount).toBe(9);
  });

  it("non azzera `lastReadAt` di una riga che esiste già: solo un read esplicito lo muove", () => {
    const before = "2026-07-30T12:00:00.000Z";
    const h = harness({ t1: { lastReadAt: before, unreadCount: 2 } });
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1.lastReadAt).toBe(before);
  });

  it("annuncia il conteggio NUOVO, non quello prima dell'incremento", () => {
    const h = harness({ t1: { lastReadAt: "2026-08-01T00:00:00.000Z", unreadCount: 7 } });
    bumpUnreadCount(h.deps, "t1");
    expect(h.broadcasts).toEqual([{ type: "unread:updated", topicId: "t1", unreadCount: 8 }]);
  });

  it("un errore di persistenza non propaga: il badge è accessorio, il messaggio no", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const deps: UnreadDeps = {
      loadUnread: () => { throw new Error("db locked"); },
      saveUnread: () => {},
      broadcastToAll: (m) => { broadcasts.push(m as unknown as Record<string, unknown>); },
    };
    expect(() => bumpUnreadCount(deps, "t1")).not.toThrow();
    expect(broadcasts).toEqual([]);
  });
});
