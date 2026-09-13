/**
 * @covers TOPIC-BROWSER-05
 */
import { test, expect } from "bun:test";
import { createViewportArbiter, isDrivingInput } from "./browser-viewport-arbiter";

const CTX = "ctx-1";

test("the first connected client drives while nobody has touched the page", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  expect(arbiter.driver(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, "mac")).toBe(true);
});

test("a client that connects without interacting cannot change the viewport", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  arbiter.noteConnect(CTX, "phone");
  expect(arbiter.canResize(CTX, "phone")).toBe(false);
  expect(arbiter.canResize(CTX, "mac")).toBe(true);
});

test("whoever sends an input takes the viewport, and the other one loses it", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  arbiter.noteConnect(CTX, "phone");
  arbiter.noteInput(CTX, "phone");
  expect(arbiter.driver(CTX)).toBe("phone");
  expect(arbiter.canResize(CTX, "phone")).toBe(true);
  expect(arbiter.canResize(CTX, "mac")).toBe(false);
});

test("when the driver leaves, the oldest client left drives again", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  arbiter.noteConnect(CTX, "phone");
  arbiter.noteInput(CTX, "phone");
  arbiter.noteDisconnect(CTX, "phone");
  expect(arbiter.driver(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, "mac")).toBe(true);
});

test("a client that never connected is refused, and cannot claim the wheel", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  expect(arbiter.canResize(CTX, "ghost")).toBe(false);
  arbiter.noteInput(CTX, "ghost");
  expect(arbiter.driver(CTX)).toBe("mac");
});

test("a context with no socket at all is not arbitrated", () => {
  const arbiter = createViewportArbiter();
  expect(arbiter.canResize("never-seen", "whoever")).toBe(true);
  expect(arbiter.driver("never-seen")).toBeUndefined();
});

test("the last disconnect forgets the context instead of leaking it", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, "mac");
  arbiter.noteInput(CTX, "mac");
  arbiter.noteDisconnect(CTX, "mac");
  expect(arbiter.driver(CTX)).toBeUndefined();
  // A context that comes back starts clean: the new first client drives.
  arbiter.noteConnect(CTX, "phone");
  expect(arbiter.driver(CTX)).toBe("phone");
});

test("moving the mouse is reading, not driving", () => {
  expect(isDrivingInput("mousemove")).toBe(false);
  for (const action of ["click", "type", "scroll", "keypress"]) {
    expect(isDrivingInput(action)).toBe(true);
  }
});
