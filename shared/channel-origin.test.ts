import { describe, expect, test } from "bun:test";
import { channelKindOfIcon } from "./channel-origin";

describe("channelKindOfIcon", () => {
  test("the brand names jarvis-channels writes in `icon` are channels", () => {
    expect(channelKindOfIcon("Discord")).toBe("discord");
    expect(channelKindOfIcon("WhatsApp")).toBe("whatsapp");
    expect(channelKindOfIcon("Telegram")).toBe("telegram");
  });
  test("an ordinary chat, an emoji or nothing is no channel", () => {
    expect(channelKindOfIcon("MessageSquare")).toBeNull();
    expect(channelKindOfIcon("💬")).toBeNull();
    expect(channelKindOfIcon("constructor")).toBeNull();
    expect(channelKindOfIcon(null)).toBeNull();
    expect(channelKindOfIcon(undefined)).toBeNull();
  });
});
