/** @covers HUBBR-21 */
import { describe, expect, test } from "bun:test";
import { SCREEN_DATA_PATH, SCREEN_SESSIONS_PATH, isScreenAllowedRequest } from "./screen-scope";

describe("the screen scope", () => {
  test("a screen reads the two routes of the page, with a read verb", () => {
    for (const p of [SCREEN_DATA_PATH, SCREEN_SESSIONS_PATH]) {
      expect(isScreenAllowedRequest(p, "GET")).toBe(true);
      expect(isScreenAllowedRequest(p, "head")).toBe(true);
    }
  });

  test("nothing else is open to it: not a write, not the owner's consumption route, not the chat or the board", () => {
    expect(isScreenAllowedRequest(SCREEN_DATA_PATH, "POST")).toBe(false);
    expect(isScreenAllowedRequest(SCREEN_SESSIONS_PATH, "DELETE")).toBe(false);
    for (const p of ["/api/usage/consumption", "/api/topics", "/api/boards/x/tasks", "/api/system/status", "/api/system/screen-data/extra", "/ws"]) {
      expect(isScreenAllowedRequest(p, "GET")).toBe(false);
    }
  });
});
