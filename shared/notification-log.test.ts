/**
 * Il contratto del registro delle notifiche — prove sulle decisioni pure.
 *
 * La più importante è l'ultima: le CHIAVI. Il dedup funziona solo se le due
 * porte (banner del client, push del server) scrivono la stessa stringa per lo
 * stesso evento; se divergessero, ogni consegna lascerebbe due righe e nessuno
 * se ne accorgerebbe leggendo il codice di una sola delle due parti.
  * @covers NOTIF-LOG-02
 */

import { describe, expect, test } from "bun:test";
import {
  chatNotificationKey,
  defaultNotificationGroupKey,
  isNotificationKind,
  notificationTargetUrl,
  parseNotificationInput,
  taskParkedNotificationKey,
  taskReviewNotificationKey,
  TERMINAL_TARGET_KIND,
  terminalNotificationGroupKey,
} from "./notification-log";

describe("parseNotificationInput", () => {
  test("rifiuta ciò che non è registrabile", () => {
    expect(parseNotificationInput(null)).toBeNull();
    expect(parseNotificationInput("x")).toBeNull();
    // Senza titolo la riga non è leggibile; senza chiave non è deduplicabile.
    expect(parseNotificationInput({ dedupeKey: "k" })).toBeNull();
    expect(parseNotificationInput({ title: "t" })).toBeNull();
    expect(parseNotificationInput({ title: "   ", dedupeKey: "k" })).toBeNull();
  });

  test("un kind sconosciuto non butta via la riga, la declassa", () => {
    const p = parseNotificationInput({ title: "t", dedupeKey: "k", kind: "inventato" });
    expect(p?.kind).toBe("other");
  });

  test("un bersaglio a metà non è un bersaglio", () => {
    expect(parseNotificationInput({ title: "t", dedupeKey: "k", targetKind: "task" })?.targetId).toBeNull();
    expect(parseNotificationInput({ title: "t", dedupeKey: "k", targetId: "abc" })?.targetKind).toBeNull();
    const ok = parseNotificationInput({ title: "t", dedupeKey: "k", targetKind: "topic", targetId: "abc" });
    expect(ok?.targetKind).toBe("topic");
    expect(ok?.targetId).toBe("abc");
  });

  test("taglia titolo e corpo — è una lista, non un archivio di testi", () => {
    const p = parseNotificationInput({ title: "t".repeat(500), body: "b".repeat(999), dedupeKey: "k" });
    expect(p?.title.length).toBe(140);
    expect(p?.body?.length).toBe(400);
  });

  test("la sorgente è banner salvo dichiarazione contraria", () => {
    expect(parseNotificationInput({ title: "t", dedupeKey: "k" })?.source).toBe("banner");
    expect(parseNotificationInput({ title: "t", dedupeKey: "k", source: "push" })?.source).toBe("push");
    expect(parseNotificationInput({ title: "t", dedupeKey: "k", source: "inventata" })?.source).toBe("banner");
  });
});

describe("il bersaglio", () => {
  test("le due rotte sono quelle dei deep-link", () => {
    expect(notificationTargetUrl("task", "abc")).toBe("/task/abc");
    expect(notificationTargetUrl("topic", "abc")).toBe("/topic/abc");
    expect(notificationTargetUrl(null, "abc")).toBeNull();
    expect(notificationTargetUrl("task", null)).toBeNull();
  });

  test("il gruppo di default è il bersaglio, e senza bersaglio non c'è gruppo", () => {
    expect(defaultNotificationGroupKey("task", "abc")).toBe("task:abc");
    expect(defaultNotificationGroupKey(null, null)).toBeNull();
  });
});

describe("le chiavi", () => {
  test("sono stabili e distinte per famiglia", () => {
    expect(chatNotificationKey("t1")).toBe("chat:t1");
    expect(taskReviewNotificationKey("t1")).toBe("task-review:t1");
    expect(taskParkedNotificationKey("t1")).toBe("task-parked:t1");
    // Review e park dello STESSO task non devono collassare: sono due notizie
    // opposte, e la seconda non è la ripetizione della prima.
    expect(taskReviewNotificationKey("t1")).not.toBe(taskParkedNotificationKey("t1"));
  });

  test("isNotificationKind riconosce solo il vocabolario", () => {
    expect(isNotificationKind("task-review")).toBe(true);
    expect(isNotificationKind("nope")).toBe(false);
    expect(isNotificationKind(42)).toBe(false);
  });
});

/**
 * BIRTH KEY AND EXTINGUISH KEY MUST BE THE SAME BYTE.
 *
 * A terminal notification is born with `terminalNotificationGroupKey(id)` in
 * the client, and is cleared server-side by `markTargetNotificationsSeen`,
 * which recomposes the key from `kind:id` on its own. Two hand-written
 * literals drifting by one character would leave the rows lit without breaking
 * anything visible - which is precisely how 325 of them piled up.
 *
 * @covers NOTIF-SEEN-01
 */
describe("terminalNotificationGroupKey", () => {
  test("agrees, byte for byte, with the key the server rebuilds", () => {
    const rebuilt = defaultNotificationGroupKey(TERMINAL_TARGET_KIND as never, "sess-1");
    expect(rebuilt).not.toBeNull();
    expect(terminalNotificationGroupKey("sess-1")).toBe(rebuilt as string);
  });

  test("a terminal has a group even with no target at all", () => {
    // The hole itself: without a target the default is null, and a row with a
    // null group cannot be addressed by any gesture.
    expect(defaultNotificationGroupKey(null, "sess-1")).toBeNull();
    expect(terminalNotificationGroupKey("sess-1")).toBe("terminal:sess-1");
  });
});
