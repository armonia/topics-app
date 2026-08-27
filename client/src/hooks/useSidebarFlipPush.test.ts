/**
 * @covers LAYOUT-28
 *
 * THE GREY BAND WHEN REOPENING THE SIDEBAR, executed rather than eyeballed.
 *
 * The reported defect: closing and reopening the sidebar revealed a grey band
 * along the edge, i.e. a strip nobody painted. The cause is in the FLIP: the
 * layer is moved by a transform while the pad is committed in the same frame,
 * but the layer is a flex child — committing the pad SHRINKS it, so the
 * transform uncovers a strip as wide as the move. The cure is to widen it by
 * `|delta|` while it slides.
 *
 * THIS HOOK HAD NO TEST AT ALL. The commit that cures it (`d1895237e`) says
 * "280 hook tests green", but none of those 280 touch this file: it was one of
 * the two Windows fixes out of six verified by eye only.
 *
 * The hook is actually RUN, against a fake DOM that answers measurements:
 * reading the source would prove a line exists, not that the layer ends up
 * wide.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createElement } from "react";
import { mount } from "../test/reactHarness";
import { useSidebarFlipPush } from "./useSidebarFlipPush";

type Stile = Record<string, string>;

/**
 * A fake layer that behaves like the real one: its position depends on the
 * `paddingLeft` written on the content, exactly as in a real flex row.
 *
 * This is the part that makes the test a MEASUREMENT rather than a reading: the
 * hook reads the position BEFORE committing the pad (First) and again AFTER
 * (Last), all inside the same effect. A fake that always answers the same would
 * give a zero delta and the hook would bail out without animating - green for
 * the wrong reason.
 */
function layerLegatoAlPad(content: { style: Stile }) {
  const style: Stile = {};
  return {
    style,
    getBoundingClientRect: () => ({
      // The layer is NOT the content: it is a flex child beside the pad, so its
      // left edge follows the `paddingLeft` COMMITTED on the content. Reading it
      // on every call is what makes First differ from Last: First is read while
      // the pad is still the old one, Last after the hook wrote the new one. It
      // is the real DOM's own sequence — the only difference is that the reflow
      // here is a subtraction.
      left: parseFloat(content.style.paddingLeft || "0"),
      right: 0, top: 0, bottom: 0, width: 0, height: 0,
    }),
  } as unknown as HTMLElement & { style: Stile };
}

/** The content: all it has to do is carry the `paddingLeft`. */
function fakeContent() {
  const style: Stile = {};
  return { style } as unknown as HTMLElement & { style: Stile };
}

const globals = globalThis as unknown as Record<string, unknown>;
let originals: Record<string, unknown> = {};
beforeEach(() => {
  originals = {
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    window: globals.window,
  };
  // THE FRAME IS HELD, and that is the difference between measuring something
  // and measuring nothing. Play (`translateX(0)`, the end of the slide) runs
  // inside a rAF: running it immediately completes the animation in the same
  // instant, and what one then observes is the END state — where there is no
  // band left to uncover. The state that matters is INVERT: the layer moved by
  // `delta` with the width that has to cover it. So the frame is SWALLOWED and
  // never run: the assertions below read the layer while it is still inverted.
  globals.requestAnimationFrame = () => 1;
  globals.cancelAnimationFrame = () => {};
  globals.window = { clearTimeout: () => {}, setTimeout: () => 1 };
});

afterEach(() => {
  for (const [k, v] of Object.entries(originals)) globals[k] = v;
});

/**
 * Mounts the hook and allows re-rendering it with different arguments: the
 * RE-RENDER is what matters, because the defect lives in the transition between
 * two states.
 */
function mountHook(layer: HTMLElement, content: HTMLElement, stato: { collapsed: boolean; expandedPad: number }) {
  const corrente = { ...stato };
  const Probe = () => {
    useSidebarFlipPush(
      { current: content },
      { current: layer },
      { collapsed: corrente.collapsed, expandedPad: corrente.expandedPad, enabled: true },
    );
    return null;
  };
  const h = mount(createElement(Probe));
  return {
    aggiorna(next: Partial<typeof corrente>) {
      Object.assign(corrente, next);
      h.rerender();
    },
    smonta: () => h.unmount(),
  };
}

describe("useSidebarFlipPush — the strip the transform uncovers", () => {
  test("reopening the sidebar WIDENS the layer, not just moves it", () => {
    // Reopening: the layer starts on the left (0) and ends further right (255),
    // so `delta` is negative - the transform carries it back and uncovers 255px
    // on the edge. Those are the ones `width` has to cover.
    const content = fakeContent();
    const layer = layerLegatoAlPad(content);
    // First pass: closed. Fixes the starting state and writes pad 0, without
    // animating (`firstRun`).
    const h = mountHook(layer, content, { collapsed: true, expandedPad: 255 });
    expect(content.style.paddingLeft, "the first pass must commit pad 0").toBe("0px");
    // Second pass: it reopens. The pad goes 0 -> 255, so between First (read
    // while the pad is still 0) and Last (read at 255) the layer moves 255px:
    // delta is NEGATIVE, the transform pulls it back and uncovers the edge.
    h.aggiorna({ collapsed: false });

    // The move happened and is the expected one: the pad went 0 -> 255, so the
    // transform pulls the layer back by 255px.
    expect(layer.style.transform, "the layer was not moved").toBe("translateX(-255px)");
    // AND THE PART THAT CURES THE BAND: the width covers exactly those 255px.
    // `calc(100% + 255px)` and not `100%`: without the pixel term the transform
    // would uncover 255px that nobody paints.
    expect(layer.style.width, "THE DEFECT: moved without being widened = band uncovered")
      .toBe("calc(100% + 255px)");
  });

  test("leftover width is cleared before the next measurement", () => {
    // Two cycles in a row: on the second, `width` must not carry the first
    // one's value into the measurements. If it accumulated, a repeated
    // close/reopen would shift the page further on every pass.
    const content = fakeContent();
    const layer = layerLegatoAlPad(content);
    const h = mountHook(layer, content, { collapsed: true, expandedPad: 255 });
    h.aggiorna({ collapsed: false });
    const afterFirst = layer.style.width;

    // Closing: positive delta, no extra to add — and the previous pass's width
    // must NOT survive.
    h.aggiorna({ collapsed: true });

    expect(afterFirst, "the first pass did not widen the layer").toBe("calc(100% + 255px)");
    expect(layer.style.width, "the previous pass's width survived").toBe("");
  });

  test("a RESIZE (collapsed unchanged) does not animate: it settles at once", () => {
    // A width change arrives as a single commit at drag end. Animating it would
    // slide the page 200ms after the handle is released: motion nobody asked
    // for.
    const content = fakeContent();
    const layer = layerLegatoAlPad(content);
    const h = mountHook(layer, content, { collapsed: false, expandedPad: 255 });
    h.aggiorna({ expandedPad: 315 });

    expect(layer.style.transform).toBe("none");
    expect(layer.style.width).toBe("");
  });
});
