/**
 * @covers BROWSER-LOGIN-01
 */
import { describe, expect, test } from "bun:test";
import { loginNoticeInput } from "./login-notice";

describe("loginNoticeInput", () => {
  test("links the notice to the topic and names the site", () => {
    const n = loginNoticeInput({ contextId: "ctx1", url: "https://github.com/login", topicId: "t1" });
    expect(n.title).toContain("github.com");
    expect(n.targetKind).toBe("topic");
    expect(n.targetId).toBe("t1");
    expect(n.dedupeKey).toBe("login-request:ctx1");
  });
  test("has no target without a topic", () => {
    expect(loginNoticeInput({ contextId: "c", url: "not a url" }).targetKind).toBeNull();
  });
});
