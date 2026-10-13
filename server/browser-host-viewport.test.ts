/**
 * Whose size a page the Mac hosts is laid out at, and when the host is told.
 *
 * @covers NATIVE-HOST-04
 */
import { describe, expect, test } from "bun:test";
import { createHostViewport, type HostViewportCommand } from "./browser-host-viewport";

function setup() {
  const sent: HostViewportCommand[] = [];
  const viewport = createHostViewport({ send: (_ctx, cmd) => sent.push(cmd) });
  return { viewport, sent };
}

const IPAD = "dev-ipad/pane-1";
const PHONE = "dev-phone/pane-1";

describe("browser-host-viewport (TOPIC-BROWSER-05 on a hosted page)", () => {
  test("a viewer that only looks does not move the Mac's layout", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    expect(sent).toEqual([]);
    expect(viewport.driver("ctx")).toBeUndefined();
  });

  test("the viewer that uses the page gets its own size, and its resizes after", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteSize("ctx", IPAD, 820, 1180);
    expect(sent).toEqual([
      { type: "host_viewport", width: 1180, height: 820 },
      { type: "host_viewport", width: 820, height: 1180 },
    ]);
  });

  test("using the page again with the same size tells the host nothing new", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteSize("ctx", IPAD, 1180, 820);
    expect(sent).toHaveLength(1);
  });

  test("a claim that arrives before its size waits for it", () => {
    const { viewport, sent } = setup();
    viewport.noteRemoteUse("ctx", IPAD);
    expect(sent).toEqual([]);
    viewport.noteSize("ctx", IPAD, 1024, 700);
    expect(sent).toEqual([{ type: "host_viewport", width: 1024, height: 700 }]);
  });

  test("the Mac using its own pane takes the page back to its slot", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteHostUse("ctx");
    expect(sent.at(-1)).toEqual({ type: "host_viewport" });
    expect(viewport.driver("ctx")).toBeUndefined();
    // and a resize of the iPad, now only watching, changes nothing
    viewport.noteSize("ctx", IPAD, 820, 1180);
    expect(sent).toHaveLength(2);
  });

  test("the Mac using its pane while nobody else drives sends nothing", () => {
    const { viewport, sent } = setup();
    viewport.noteHostUse("ctx");
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteHostUse("ctx");
    expect(sent).toEqual([]);
  });

  test("the driving device leaving gives the page back; a watcher leaving does not", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteSize("ctx", PHONE, 390, 700);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteViewerGone("ctx", PHONE);
    expect(sent).toHaveLength(1);
    viewport.noteViewerGone("ctx", IPAD);
    expect(sent.at(-1)).toEqual({ type: "host_viewport" });
  });

  test("another device using the page takes it over at its size", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteSize("ctx", PHONE, 390, 700);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteRemoteUse("ctx", PHONE);
    expect(sent.at(-1)).toEqual({ type: "host_viewport", width: 390, height: 700 });
  });

  test("a host that comes back is told again whose page it is", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.noteHostReady("ctx");
    expect(sent).toEqual([
      { type: "host_viewport", width: 1180, height: 820 },
      { type: "host_viewport", width: 1180, height: 820 },
    ]);
  });

  test("a forgotten context starts over", () => {
    const { viewport, sent } = setup();
    viewport.noteSize("ctx", IPAD, 1180, 820);
    viewport.noteRemoteUse("ctx", IPAD);
    viewport.forget("ctx");
    viewport.noteHostReady("ctx");
    viewport.noteHostUse("ctx");
    expect(sent).toHaveLength(1);
    expect(viewport.driver("ctx")).toBeUndefined();
  });
});
