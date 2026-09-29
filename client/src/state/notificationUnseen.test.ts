/**
 * Opening a chat must reach the server whenever there is something to clear,
 * unread messages OR an unseen notification of that chat (NOTIF-ONE-01,
 * "opening a chat with unseen rows and unread zero"). Reading the unread alone
 * skipped the POST and left the bell lit.
 *
 * @covers NOTIF-ONE-01
 */
import { describe, expect, test } from "bun:test";
import { openingChatClearsSomething, unseenKeysOf, useUnseenNotificationsStore } from "./notificationUnseen";

const unread = (n: number) => ({ a: { lastReadAt: "2026-09-29T00:00:00.000Z", unreadCount: n } });

describe("openingChatClearsSomething", () => {
  test("unread zero but an unseen notification of the chat: the seen goes out", () => {
    expect(openingChatClearsSomething(unread(0), new Set(["topic:a"]), "a")).toBe(true);
  });

  test("unread messages: the seen goes out", () => {
    expect(openingChatClearsSomething(unread(3), new Set(), "a")).toBe(true);
  });

  test("nothing of THIS chat: no round-trip (another chat's row does not count)", () => {
    expect(openingChatClearsSomething(unread(0), new Set(["topic:b", "task:a"]), "a")).toBe(false);
  });
});

describe("unseenKeysOf", () => {
  test("takes the server's keys when it sends them", () => {
    expect(unseenKeysOf({ unseen: 2, unseenKeys: ["topic:a", "x"] })).toEqual(["topic:a", "x"]);
  });

  test("an older server that sends the number only still counts right", () => {
    expect(unseenKeysOf({ unseen: 2 })).toHaveLength(2);
    expect(unseenKeysOf({})).toEqual([]);
  });
});

describe("the store", () => {
  test("keeps its identity when the same keys come back", () => {
    const st = useUnseenNotificationsStore.getState();
    st.setKeys(["topic:a"]);
    const first = useUnseenNotificationsStore.getState().keys;
    st.setKeys(["topic:a"]);
    expect(useUnseenNotificationsStore.getState().keys).toBe(first);
    st.setKeys([]);
    expect(useUnseenNotificationsStore.getState().keys.size).toBe(0);
  });
});
