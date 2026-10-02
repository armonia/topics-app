/**
 * The motion recorder of the floating-surface contract (MOTION-04), shared by
 * `motion-floating-surfaces.spec.ts` and `motion-floating-surfaces-project.spec.ts`.
 *
 * The measurement is the animation object itself (name, duration, animated
 * properties, curve), read in the page on the frame the surface is inserted:
 * deterministic on a loaded machine, where a stopwatch on the frames is not.
 */
import { expect, type Page } from "@playwright/test";

/** `--ease-standard` / `--ease-exit` of the token table (client/src/lib/motion.ts). */
export const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";
export const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
/** A menu answers a click: its entrance and exit stay at or under this. */
export const POPOVER_MAX_MS = 120;
/** A dialog's veil moves with its panel, `--motion-fast`. */
export const MODAL_MAX_MS = 150;
/** What an entrance or exit may animate: the compositor-only properties. */
export const COMPOSITOR_PROPS = ["opacity", "scale", "transform"];

type AnimationInfo = { name: string; duration: number; props: string[] };
export type SurfaceRecord = {
  kind: "enter" | "ghost";
  ghost: string | null;
  testid: string | null;
  /** The element's class list, to tell two surfaces inserted together apart (a sheet and its scrim). */
  cls: string;
  ariaHidden: string | null;
  pointerEvents: string;
  timing: string;
  animations: AnimationInfo[];
  /** Painted box (`getBoundingClientRect`, transforms and `scale` included) against the layout box. */
  box: { painted: [number, number]; layout: [number, number] } | null;
  t: number;
};

/**
 * Installed before the app boots. Every element added to the document that
 * matches `window.__motionWatch`, and every exit copy (`[data-exit-ghost]`),
 * is described on the spot: the same task in which it was inserted, before
 * its first frame is painted.
 */
export function installRecorder(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __motionWatch: string; __motionLog: unknown[]; __ghostsGone: number };
    w.__motionWatch = "";
    w.__motionLog = [];
    w.__ghostsGone = 0;
    const describe = (el: Element, kind: "enter" | "ghost") => {
      const cs = getComputedStyle(el);
      const animations = el.getAnimations().map((a) => {
        const effect = a.effect as KeyframeEffect | null;
        const frames = effect?.getKeyframes() ?? [];
        const props = new Set<string>();
        for (const f of frames) {
          for (const k of Object.keys(f)) {
            if (!["offset", "computedOffset", "easing", "composite"].includes(k)) props.add(k);
          }
        }
        return {
          name: (a as CSSAnimation).animationName ?? "",
          duration: Number(effect?.getComputedTiming().duration ?? 0),
          props: [...props],
        };
      });
      w.__motionLog.push({
        kind,
        ghost: el.getAttribute("data-exit-ghost"),
        testid: el.getAttribute("data-testid"),
        cls: el.getAttribute("class") ?? "",
        ariaHidden: el.getAttribute("aria-hidden"),
        pointerEvents: cs.pointerEvents,
        timing: cs.animationTimingFunction,
        animations,
        box: el instanceof HTMLElement
          ? {
              painted: [el.getBoundingClientRect().width, el.getBoundingClientRect().height],
              layout: [el.offsetWidth, el.offsetHeight],
            }
          : null,
        t: performance.now(),
      });
    };
    const start = () => {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            if (n.hasAttribute("data-exit-ghost")) { describe(n, "ghost"); continue; }
            const selector = w.__motionWatch;
            if (!selector) continue;
            for (const el of [n, ...n.querySelectorAll(selector)]) {
              if (el.matches(selector)) describe(el, "enter");
            }
          }
          for (const n of m.removedNodes) {
            if (n instanceof Element && n.hasAttribute("data-exit-ghost")) w.__ghostsGone += 1;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}

export async function watch(page: Page, selector: string): Promise<void> {
  await page.evaluate((selector) => {
    const w = window as unknown as { __motionWatch: string; __motionLog: unknown[] };
    w.__motionWatch = selector;
    w.__motionLog = [];
  }, selector);
}

export async function log(page: Page): Promise<SurfaceRecord[]> {
  return page.evaluate(() => (window as unknown as { __motionLog: SurfaceRecord[] }).__motionLog);
}

/** The entrance of the surface: one animation, on the compositor, short, on the token curve.
 *  `withClass` picks one of several surfaces inserted together (a sheet and its scrim). */
export async function expectEntrance(page: Page, label: string, maxMs: number, props: string[], withClass?: string) {
  const picked = (r: SurfaceRecord) => r.kind === "enter" && (!withClass || r.cls.split(/\s+/).includes(withClass));
  await expect
    .poll(async () => (await log(page)).filter(picked).length, { message: `${label}: inserted` })
    .toBeGreaterThan(0);
  const enter = (await log(page)).find(picked)!;
  const moving = enter.animations.filter((a) => a.duration > 1);
  expect(moving.length, `${label}: an entrance animation runs on the inserted surface (${JSON.stringify(enter.animations)})`).toBeGreaterThan(0);
  for (const a of moving) {
    expect(a.duration, `${label}: ${a.name} lasts at most ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    for (const p of a.props) expect(props, `${label}: ${a.name} animates only ${props.join("/")}`).toContain(p);
  }
  expect(enter.timing, `${label}: entrance on --ease-standard`).toContain(EASE_STANDARD);
  // The menus place themselves by measuring the panel on this very frame
  // (Menu.tsx, DropdownPortal): a box scaled down by the entrance is placed
  // over its anchor and clamped short of the viewport edge. Read in the same
  // task the surface was inserted in, the painted box is the layout box.
  expect(enter.box, `${label}: the inserted surface is an HTML element`).not.toBeNull();
  const { painted, layout } = enter.box!;
  for (const i of [0, 1]) {
    expect(
      Math.abs(painted[i] - layout[i]),
      `${label}: on its first frame the surface measures at its final ${i ? "height" : "width"} (painted ${painted[i]}, layout ${layout[i]})`,
    ).toBeLessThanOrEqual(1);
  }
}

/** The exit: the surface is gone at once, and an inert copy of it fades.
 *  The copy is looked up by its kind: a sheet leaves with a `modal` copy of its scrim next to it. */
export async function expectExit(page: Page, label: string, kind: "popover" | "modal" | "sheet" | "drawer", maxMs: number) {
  await expect
    .poll(async () => (await log(page)).filter((r) => r.kind === "ghost").map((r) => r.ghost), { message: `${label}: a ${kind} exit copy plays` })
    .toContain(kind);
  const ghost = (await log(page)).find((r) => r.kind === "ghost" && r.ghost === kind)!;
  expect(ghost.ghost, `${label}: exit kind`).toBe(kind);
  expect(ghost.testid, `${label}: the copy carries no test id`).toBeNull();
  expect(ghost.ariaHidden, `${label}: the copy is hidden from assistive tech`).toBe("true");
  expect(ghost.pointerEvents, `${label}: the copy never takes a click`).toBe("none");
  const moving = ghost.animations.filter((a) => a.duration > 1);
  expect(moving.length, `${label}: the copy animates`).toBeGreaterThan(0);
  for (const a of moving) {
    expect(a.duration, `${label}: ${a.name} lasts at most ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    for (const p of a.props) expect(COMPOSITOR_PROPS, `${label}: ${a.name} animates only compositor properties`).toContain(p);
  }
  expect(ghost.timing, `${label}: exit on --ease-exit`).toContain(EASE_EXIT);
  await expect(page.locator("[data-exit-ghost]"), `${label}: the copy removes itself`).toHaveCount(0);
}

/** A sheet crosses a third of the screen: `--motion-base`, still on the entrance curve. */
export const SHEET_MAX_MS = 240;
/** The phone's scrim, the one element carrying both `fixed` and `bg-black/40`. */
export const SCRIM = 'div[class~="fixed"][class~="bg-black/40"]';
