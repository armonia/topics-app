/**
 * @covers TOPIC-BROWSER-05
 */
import { test, expect } from "bun:test";
import { createViewportArbiter, isDrivingInput } from "./browser-viewport-arbiter";

const CTX = "ctx-1";

/** A device with one socket, which is the ordinary case. */
const on = (device: string, socket = `${device}-ws`) => ({ device, socket });

test("the first connected client drives while nobody has touched the page", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  expect(arbiter.driverDevice(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, on("mac"))).toBe(true);
});

test("a client that connects without interacting cannot change the viewport", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  arbiter.noteConnect(CTX, on("phone"));
  expect(arbiter.canResize(CTX, on("phone"))).toBe(false);
  expect(arbiter.canResize(CTX, on("mac"))).toBe(true);
});

test("whoever sends an input takes the viewport, and the other one loses it", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("phone"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
  expect(arbiter.canResize(CTX, on("phone"))).toBe(true);
  expect(arbiter.canResize(CTX, on("mac"))).toBe(false);
});

test("when the driver leaves, the oldest client left drives again", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("phone"));
  const heir = arbiter.noteDisconnect(CTX, on("phone"));
  // The departure hands the viewport over: the caller is told, because nobody
  // else would ever re-send a size the new driver's pane already sent once.
  expect(heir).toBe("mac");
  expect(arbiter.driverDevice(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, on("mac"))).toBe(true);
});

test("a spectator leaving hands nothing over: the driver did not change", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("mac"));
  expect(arbiter.noteDisconnect(CTX, on("phone"))).toBeUndefined();
});

test("a client that never connected is refused, and cannot claim the wheel", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  expect(arbiter.canResize(CTX, on("ghost"))).toBe(false);
  arbiter.noteInput(CTX, on("ghost"));
  expect(arbiter.driverDevice(CTX)).toBe("mac");
});

test("a context with no socket at all is not arbitrated", () => {
  const arbiter = createViewportArbiter();
  expect(arbiter.canResize("never-seen", on("whoever"))).toBe(true);
  expect(arbiter.driverDevice("never-seen")).toBeUndefined();
});

test("the last disconnect forgets the context instead of leaking it", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac"));
  arbiter.noteInput(CTX, on("mac"));
  arbiter.noteDisconnect(CTX, on("mac"));
  expect(arbiter.driverDevice(CTX)).toBeUndefined();
  // A context that comes back starts clean: the new first client drives.
  arbiter.noteConnect(CTX, on("phone"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
});

test("an executor-only context is forgotten too when its socket goes", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "native"));
  arbiter.noteExecutor(CTX, on("mac", "native"));
  expect(arbiter.driverDevice(CTX)).toBeUndefined();
  arbiter.noteDisconnect(CTX, on("mac", "native"));
  // Nothing was kept: the next context with this id starts from scratch.
  arbiter.noteConnect(CTX, on("phone"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
});

test("the native executor neither drives nor resizes: it executes", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "native"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteExecutor(CTX, on("mac", "native"));
  arbiter.noteInput(CTX, on("mac", "native"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
  expect(arbiter.canResize(CTX, on("mac", "native"))).toBe(false);
});

test("the shell swapping its native socket for a streaming one keeps its turn", () => {
  // The sequence that used to hand a watching phone the viewport of a Mac that
  // was working: the Tauri pane is on the context alone (native executor), the
  // phone opens the same context, the pane flips to shared, and the Mac's
  // streaming socket only arrives AFTER the phone's.
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "native"));
  arbiter.noteExecutor(CTX, on("mac", "native"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteDisconnect(CTX, on("mac", "native"));
  arbiter.noteConnect(CTX, on("mac", "mac-stream"));
  expect(arbiter.driverDevice(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, on("mac", "mac-stream"))).toBe(true);
  expect(arbiter.canResize(CTX, on("phone"))).toBe(false);
});

test("the driver that reconnects is still the driver, socket or no socket", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "mac-1"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("mac", "mac-1"));
  // The laptop sleeps, or the server reloads: the socket dies, the person does
  // not. While it is away the oldest present pane drives.
  arbiter.noteDisconnect(CTX, on("mac", "mac-1"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
  arbiter.noteConnect(CTX, on("mac", "mac-2"));
  expect(arbiter.driverDevice(CTX)).toBe("mac");
  expect(arbiter.canResize(CTX, on("mac", "mac-2"))).toBe(true);
  expect(arbiter.canResize(CTX, on("phone"))).toBe(false);
});

test("the driver that reconnects wins over whoever got here first", () => {
  // The case the arrival order cannot cover for it: the phone opened the
  // context, the Mac joined later and is the one working. When the Mac's socket
  // dies the phone takes over (it is the oldest present), and the Mac has to
  // find its page again when it comes back, not the phone's.
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteConnect(CTX, on("mac", "mac-1"));
  arbiter.noteInput(CTX, on("mac", "mac-1"));
  arbiter.noteDisconnect(CTX, on("mac", "mac-1"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
  arbiter.noteConnect(CTX, on("mac", "mac-2"));
  expect(arbiter.driverDevice(CTX)).toBe("mac");
});

test("somebody else using the page meanwhile keeps it when the sleeper returns", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "mac-1"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("mac", "mac-1"));
  arbiter.noteDisconnect(CTX, on("mac", "mac-1"));
  arbiter.noteInput(CTX, on("phone"));
  arbiter.noteConnect(CTX, on("mac", "mac-2"));
  expect(arbiter.driverDevice(CTX)).toBe("phone");
});

test("two panes of the same device are one claimant", () => {
  const arbiter = createViewportArbiter();
  arbiter.noteConnect(CTX, on("mac", "mac-1"));
  arbiter.noteConnect(CTX, on("mac", "mac-2"));
  arbiter.noteConnect(CTX, on("phone"));
  arbiter.noteInput(CTX, on("mac", "mac-1"));
  // The drawer and the pane of one machine do not fight each other.
  expect(arbiter.canResize(CTX, on("mac", "mac-2"))).toBe(true);
  // One of the two closing leaves the device driving, and hands nothing over.
  expect(arbiter.noteDisconnect(CTX, on("mac", "mac-1"))).toBeUndefined();
  expect(arbiter.driverDevice(CTX)).toBe("mac");
});

test("moving the mouse is reading, not driving", () => {
  expect(isDrivingInput("mousemove")).toBe(false);
  for (const action of ["click", "type", "scroll", "keypress"]) {
    expect(isDrivingInput(action)).toBe(true);
  }
});

test("a claimant of the same owner inherits the seat of one that is gone", () => {
  // The Mac restarts (the updater relaunches the app), or the pane moves into
  // a new window: the pane name lived in the session storage of a webview that
  // no longer exists, so the same screen comes back under a new name. It must
  // not queue behind a phone that has been watching all along.
  const arbiter = createViewportArbiter();
  const phone = { socket: "s-phone", device: "phone-1/pane-p", owner: "phone-1" };
  const mac = { socket: "s-mac", device: "owner/pane-a", owner: "owner" };

  arbiter.noteConnect(CTX, phone);
  arbiter.noteConnect(CTX, mac);
  arbiter.noteInput(CTX, mac);
  arbiter.noteDisconnect(CTX, mac);

  const reborn = { socket: "s-mac-2", device: "owner/pane-b", owner: "owner" };
  arbiter.noteConnect(CTX, reborn);

  expect(arbiter.canResize(CTX, reborn), "il Mac tornato non riprende la pagina").toBe(true);
  expect(arbiter.canResize(CTX, phone), "il telefono che guardava tiene il viewport").toBe(false);
});

test("two panes of the same owner, both here, stay two claimants", () => {
  // Inheritance is for a seat nobody is sitting in. Two live windows of the
  // same person are two viewers with two container sizes, and the second one
  // must not walk in and take the first one's viewport.
  const arbiter = createViewportArbiter();
  const first = { socket: "s-1", device: "owner/pane-a", owner: "owner" };
  const second = { socket: "s-2", device: "owner/pane-b", owner: "owner" };

  arbiter.noteConnect(CTX, first);
  arbiter.noteInput(CTX, first);
  arbiter.noteConnect(CTX, second);

  expect(arbiter.canResize(CTX, first), "chi sta usando la pagina la perde").toBe(true);
  expect(arbiter.canResize(CTX, second), "la seconda finestra ruba il viewport").toBe(false);
});
