/**
 * `resolveBoardActor`: who signs a comment/status row on the human board
 * route. Only a true interface call may sign as the owner.
 * @covers KANBAN-113
 */
import { describe, test, expect } from "bun:test";
import { resolveBoardActor } from "./created-by";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/boards/pX/tasks/t1/comments", { method: "POST", headers });
}

describe("resolveBoardActor", () => {
  test("an interface call signs as the owner", () => {
    expect(resolveBoardActor(req({ "X-Topics-Action-Origin": "interface" }))).toBe("user");
  });

  test("a bare call with no marker is automation, never the owner", () => {
    expect(resolveBoardActor(req())).not.toBe("user");
  });

  test("a caller that names itself is credited by that name, not the owner", () => {
    expect(resolveBoardActor(req({ "X-Topics-Agent": "Jarvis" }))).toBe("Jarvis");
  });
});
