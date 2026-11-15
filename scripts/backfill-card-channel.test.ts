/**
 * The proof rules that link an open card to its Jarvis channel chat.
 * @covers KANBAN-05
 */
import { describe, expect, test } from "bun:test";
import { chatsByName, chatsForDiscordId, judge } from "./backfill-card-channel";

const CONV = {
  "discord:7002:7001": { id: "chan-video", name: "#Video Zeno: musica e voce da rifare" },
  "discord:visione:7002:7001": { id: "visione-video", name: "#Video Zeno: musica e voce da rifare" },
  "jarvis:discord:7002:7001": { id: "work-video", name: "#Video Zeno: musica e voce da rifare · lavoro di Jarvis" },
  "discord:7003:7004": { id: "chan-f24-a", name: "#Invio F24" },
  "discord:7005:7006": { id: "chan-f24-b", name: "#Invio F24" },
  "whatsapp:39333:g1": { id: "chan-wa", name: "Gruppo Studio" },
  "cron:abc": { id: "cron-chat", name: "Controllo" },
} as const;

const card = (over: Partial<Parameters<typeof judge>[0]> = {}) => ({ id: "c1", title: "Altro", texts: [], registryChats: [], ...over });

describe("backfill-card-channel", () => {
  test("a thread id maps to the channel chat only, never to the Visione or work chats of the same thread", () => {
    expect([...chatsForDiscordId(CONV, "7001")]).toEqual(["chan-video"]);
    expect(chatsForDiscordId(CONV, "999").size).toBe(0);
  });

  test("a Discord link in any text links the card to that channel chat, with the link as proof", () => {
    const v = judge(card({ texts: ["thread: https://discord.com/channels/7000/7001"] }), CONV);
    expect(v).toMatchObject({ link: { topicId: "chan-video", rule: "discord-link" } });
  });

  test("the tracked-thread registry wins and two different chats stop the card", () => {
    expect(judge(card({ registryChats: ["chan-video"], texts: ["x"] }), CONV)).toMatchObject({ link: { rule: "thread-registry" } });
    expect(judge(card({ registryChats: ["a", "b"] }), CONV)).toEqual({ skip: "thread registry names 2 different chats" });
  });

  test("links to two different chats are doubt: nothing is linked", () => {
    const v = judge(card({ texts: [
      "https://discord.com/channels/1/1/7001", "https://discord.com/channels/1/1/7004",
    ] }), CONV);
    expect("skip" in v && v.skip).toContain("2 different chats");
  });

  test("a title equal to exactly one channel name links; a name shared by two chats does not", () => {
    expect(judge(card({ title: "Gruppo studio" }), CONV)).toMatchObject({ link: { topicId: "chan-wa", rule: "same-title" } });
    expect(judge(card({ title: "Invio F24" }), CONV)).toEqual({ skip: "the title names more than one channel chat" });
    expect(chatsByName(CONV).has("controllo")).toBe(false);
  });

  test("a channel name only cited in the text proves nothing", () => {
    const v = judge(card({ texts: ["i risultati vanno nel thread «Video Zeno: musica e voce da rifare»"] }), CONV);
    expect("skip" in v).toBe(true);
  });
});
