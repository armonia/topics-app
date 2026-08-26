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

function harness(initial: UnreadData = {}, archived: string[] = []) {
  let store: UnreadData = structuredClone(initial);
  const broadcasts: Array<Record<string, unknown>> = [];
  const deps: UnreadDeps = {
    loadUnread: () => store,
    saveUnread: (d) => { store = d; },
    broadcastToAll: (m) => { broadcasts.push(m as unknown as Record<string, unknown>); },
    isArchived: (id) => archived.includes(id),
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

  // ─── la topic archiviata ────────────────────────────────────────────────
  //
  // Archiving already zeroes the counter, so the invariant looked closed. It
  // was closed on the ARCHIVING edge only: nothing stopped a message arriving
  // AFTERWARDS from raising the badge again. Measured 26/08/2026, three weeks
  // after that fix: 475 archived topics carrying a badge, `last_read_at` up to
  // 23/08. These cases exist so that edge cannot reopen in silence.

  it("una topic archiviata NON prende il badge", () => {
    const h = harness({}, ["t1"]);
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1, "l'archiviata si e' presa una riga di non-letto").toBeUndefined();
  });

  it("e non annuncia niente: nessun client deve ridisegnare un badge che non esiste", () => {
    const h = harness({}, ["t1"]);
    bumpUnreadCount(h.deps, "t1");
    expect(h.broadcasts).toEqual([]);
  });

  it("un conteggio gia' presente su un'archiviata resta com'e', non cresce", () => {
    // Cleaning up here would be a cure on the wrong edge a second time: the
    // historical residue is removed once by the migration, and this function
    // only has to stop producing it.
    const h = harness({ t1: { lastReadAt: "2026-08-01T00:00:00.000Z", unreadCount: 3 } }, ["t1"]);
    bumpUnreadCount(h.deps, "t1");
    expect(h.read().t1.unreadCount).toBe(3);
  });

  it("l'archiviazione di UNA topic non silenzia le altre", () => {
    const h = harness({}, ["t1"]);
    bumpUnreadCount(h.deps, "t1");
    bumpUnreadCount(h.deps, "t2");
    expect(h.read().t1).toBeUndefined();
    expect(h.read().t2.unreadCount).toBe(1);
  });

  it("un errore di persistenza non propaga: il badge è accessorio, il messaggio no", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const deps: UnreadDeps = {
      loadUnread: () => { throw new Error("db locked"); },
      saveUnread: () => {},
      broadcastToAll: (m) => { broadcasts.push(m as unknown as Record<string, unknown>); },
      isArchived: () => false,
    };
    expect(() => bumpUnreadCount(deps, "t1")).not.toThrow();
    expect(broadcasts).toEqual([]);
  });
});
