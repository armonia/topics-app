/**
 * USABILITY, MEASURED: the three numbers a person feels before reading a word.
 *
 * 1. TARGET SIZE. The area that RECEIVES the click, not the box: the repo grows
 *    small targets with `.tap-expand` / `.tap-expand-y` (an `::after`), which no
 *    `getBoundingClientRect()` can see. The band is probed out of the centre with
 *    `elementFromPoint`, the method of `helpers/hit-area.ts` (proved there on the
 *    tab's close ring), applied here to EVERY interactive element of a scope
 *    instead of a list of selectors. A control whose `<label>` is clickable owns
 *    the label's pixels too: that is what the pointer finds.
 * 2. TEXT SIZE. Every visible text node under the scope, read at its computed
 *    `font-size`. The project floor is 11px (`--text-mini`, «THE default of this
 *    UI»): anything smaller is a finding.
 *    Commands revealed on hover are measured too when they keep
 *    `pointer-events` at opacity 0: the pointer finds them all the same.
 * 2b. STEALS. A projected area is painted over the neighbours: every target
 *    with a pseudo-element is asked, around its box, which points it answers
 *    that another clickable element answers once the pseudo is switched off.
 * 3. AXE. `color-contrast`, `target-size`, `button-name`, `link-name`, the WCAG
 *    subset that a DOM can decide. Contrast is run per theme by the caller.
 *    The `color-contrast` nodes axe leaves `incomplete` are decided here, on
 *    the ancestors' composited grounds (`contrastDecided`).
 *
 * Plus `ui-audit.js` (the repo copy of `~/.claude/jarvis/scripts/ui-audit.js`,
 * hardened against SVG and scroll false positives), kept in the raw report for
 * overflow and overlap. Its own `tapTargets` reads the BOX, so it is never the
 * verdict on size: the probe above is.
 *
 * Every finding carries the nearest `data-testid` (own or ancestor), which is
 * how `componentFilesFor` finds the source file that draws it.
 */
import type { Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const UI_AUDIT_PATH = resolve(__dirname, "ui-audit.js");
const AXE_PATH = resolve(__dirname, "../../../node_modules/axe-core/axe.min.js");
const CLIENT_SRC = resolve(__dirname, "../../../client/src");
const REPO_ROOT = resolve(__dirname, "../../..");

export interface TargetFinding {
  selector: string;
  testid: string | null;
  label: string;
  tag: string;
  box: { w: number; h: number };
  /** The band that answers to the pointer through the centre. */
  hit: { w: number; h: number };
  /** False = the centre belongs to another element: it cannot be clicked there. */
  ownsCentre: boolean;
  /** What answers at the centre when it is not the target. */
  coveredBy?: string;
  /** WCAG 2.5.8 spacing exception: a 24px circle on the centre touches no other target. */
  spacingOk: boolean;
  /** What answers one pixel past each edge of a short band. */
  edges?: { left: string; right: string; top: string; bottom: string };
}

export interface TextFinding {
  selector: string;
  testid: string | null;
  fontSize: number;
  sample: string;
}

export interface AxeFinding {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string; testid: string | null; summary: string }>;
}

export interface ContrastDecision {
  target: string;
  testid: string | null;
  /** axe's own reason for leaving it undecided (`bgOverlap`, …). */
  reason: string;
  text: string;
  ratio: number | null;
  needed: number | null;
  /** Set when the ground is an image or a gradient: no verdict from the DOM. */
  undecided?: string;
  /** Disabled control (WCAG 1.4.3 exemption). */
  exempt: boolean;
}

export interface StealFinding {
  thief: string;
  thiefTestid: string | null;
  victim: string;
  victimTestid: string | null;
  /** CSS px (sampled on a 2px grid) where the thief answers instead of the victim. */
  px: number;
  sample: string;
}

export interface SurfaceAudit {
  scope: string;
  minTap: number;
  coarse: boolean;
  scanned: { targets: number; texts: number };
  targets: TargetFinding[];
  smallText: TextFinding[];
  axe: AxeFinding[];
  /** `color-contrast` nodes axe could not decide (translucent or image grounds). */
  axeIncomplete: AxeFinding[];
  /** The same nodes, decided here on the ancestors' composited grounds. */
  contrastDecided: ContrastDecision[];
  /** Points a target's projected area takes from ANOTHER clickable element. */
  steals: StealFinding[];
  uiAudit: unknown;
}

/** The interactive roles and elements whose size the pointer has to find. */
const INTERACTIVE = [
  "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemradio]",
  "[role=menuitemcheckbox]", "[role=option]", "[role=checkbox]", "[role=switch]", "[role=radio]",
  "[role=treeitem]", "[role=slider]", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Measures a scope in the page. `scope` is a CSS selector; all matches are measured. */
export async function auditSurface(page: Page, scope: string, minTap: number): Promise<SurfaceAudit> {
  const inPage = await page.evaluate(
    ({ scope, minTap, interactive }) => {
      const roots = [...document.querySelectorAll<HTMLElement>(scope)];
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const nearestTestId = (el: Element | null): string | null => {
        const t = el?.closest("[data-testid]");
        return t ? t.getAttribute("data-testid") : null;
      };
      const short = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
        return cls ? `${tag}.${cls}` : tag;
      };
      /** `[data-testid=…] > … > tag.cls` up to the nearest testid, at most 3 hops. */
      const describe = (el: Element): string => {
        const own = el.getAttribute("data-testid");
        if (own) return `[data-testid="${own}"]`;
        const parts: string[] = [];
        let cur: Element | null = el;
        for (let i = 0; cur && i < 4; i++) {
          const id = cur.getAttribute("data-testid");
          if (id) { parts.unshift(`[data-testid="${id}"]`); break; }
          const parent: Element | null = cur.parentElement;
          let piece = short(cur);
          if (parent) {
            const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
            if (same.length > 1) piece += `:nth-of-type(${same.indexOf(cur) + 1})`;
          }
          parts.unshift(piece);
          cur = parent;
        }
        return parts.join(" > ");
      };
      const labelOf = (el: Element): string =>
        (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el.textContent ?? "").trim()).slice(0, 60);

      const visible = (el: Element): boolean => {
        const anyEl = el as Element & { checkVisibility?: (o: unknown) => boolean };
        if (typeof anyEl.checkVisibility === "function") {
          if (!anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
        }
        for (let p: Element | null = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
        }
        return true;
      };
      /** Rendered at opacity 0 somewhere up the tree, but not display:none / hidden. */
      const transparentOnly = (el: Element): boolean => {
        let transparent = false;
        for (let p: Element | null = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === "none" || s.visibility === "hidden") return false;
          if (parseFloat(s.opacity) === 0) transparent = true;
        }
        return transparent;
      };
      /**
       * A command revealed on hover sits at opacity 0 at rest, and opacity does
       * not take it out of hit-testing: if it keeps `pointer-events`, the
       * pointer already finds it, so it is a target and is measured. Skipping
       * every opacity-0 element (the first version) left 108 of them unmeasured,
       * among them the browser tab's Reload at 16x16.
       */
      const answersPointer = (el: Element): boolean =>
        visible(el) || (transparentOnly(el) && getComputedStyle(el).pointerEvents !== "none");
      /** Inside every clipping ancestor and the viewport: reachable without scrolling. */
      const reachable = (el: Element, x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const r = p.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
        }
        return true;
      };

      // ── targets ───────────────────────────────────────────────────────────
      const seen = new Set<Element>();
      const all: Array<{ el: HTMLElement; r: DOMRect; transparent: boolean }> = [];
      for (const root of roots) {
        const list = [...(root.matches(interactive) ? [root] : []), ...root.querySelectorAll<HTMLElement>(interactive)];
        for (const el of list) {
          if (seen.has(el)) continue;
          seen.add(el);
          if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (!answersPointer(el)) continue;
          // WCAG 2.5.8 "Inline": a link inside a sentence takes its size from the
          // line it sits on. Same exemption as ui-audit.js.
          const cs = getComputedStyle(el);
          if (cs.display === "inline" && el.tagName === "A") {
            const host = el.parentElement;
            const ownText = (el.textContent ?? "").trim().length;
            if (host && (host.textContent ?? "").trim().length > ownText + 8) continue;
          }
          if (!reachable(el, r.left + r.width / 2, r.top + r.height / 2)) continue;
          all.push({ el, r, transparent: !visible(el) });
        }
      }
      const owns = (el: HTMLElement) => {
        const labels = [...((el as HTMLInputElement).labels ?? [])];
        return (h: Element | null) => !!h && (el === h || el.contains(h) || labels.some((l) => l === h || l.contains(h)));
      };
      const CAP = 70;
      const targets: Array<{
        selector: string; testid: string | null; label: string; tag: string;
        box: { w: number; h: number }; hit: { w: number; h: number };
        ownsCentre: boolean; coveredBy?: string; spacingOk: boolean;
        edges?: { left: string; right: string; top: string; bottom: string };
      }> = [];
      /** The band through the centre that answers to `el`, or null if the centre does not. */
      const band = (el: HTMLElement, r: DOMRect) => {
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const mine = owns(el);
        const at = (x: number, y: number) => mine(document.elementFromPoint(x, y));
        if (!at(cx, cy)) return { cx, cy, hit: null, edges: undefined };
        let left = cx, right = cx, top = cy, bottom = cy;
        while (cx - left < CAP && at(left - 1, cy)) left--;
        while (right - cx < CAP && at(right + 1, cy)) right++;
        while (cy - top < CAP && at(cx, top - 1)) top--;
        while (bottom - cy < CAP && at(cx, bottom + 1)) bottom++;
        // Who answers one pixel past each edge of the band: the name of what
        // takes the missing pixels, so a short band says where to look.
        const past = (x: number, y: number) => {
          const h = document.elementFromPoint(x, y);
          return h ? describe(h) : "nothing";
        };
        const edges = { left: past(left - 1, cy), right: past(right + 1, cy), top: past(cx, top - 1), bottom: past(cx, bottom + 1) };
        return { cx, cy, hit: { w: right - left + 1, h: bottom - top + 1 }, edges };
      };
      /**
       * Short on an axis = under the threshold, with ONE pixel of grace when the
       * box starts at a fractional offset on that axis. Measured on WebKit: model
       * rows laid out at y = 340.875 → 384.875 (44 tall, contiguous) answer
       * `elementFromPoint` on 43 integer rows each, because the hit test snaps a
       * fractional box to the pixel grid. On a box at a whole-pixel offset there
       * is no grace: 23 is 23.
       */
      const short_ = (hit: { w: number; h: number } | null, r?: DOMRect) => {
        if (!hit) return true;
        const graceX = r && r.left % 1 !== 0 ? 1 : 0;
        const graceY = r && r.top % 1 !== 0 ? 1 : 0;
        return hit.w < minTap - graceX || hit.h < minTap - graceY;
      };
      for (const { el, r, transparent } of all) {
        const base = {
          selector: describe(el),
          testid: nearestTestId(el),
          label: labelOf(el),
          tag: el.tagName.toLowerCase(),
          box: { w: Math.round(r.width), h: Math.round(r.height) },
        };
        let rect = el.getBoundingClientRect();
        let m = band(el, rect);
        // A row that sits at the edge of a scroller is half under whatever floats
        // over that edge (the changes strip over the transcript's last line):
        // that is where the list was left, not the size of the target. A short
        // band is measured once more with the target in the middle of its
        // scroller; something FIXED over it (the phone's bottom row over a
        // banner) is still over it there, and still a finding.
        if (short_(m.hit, rect)) {
          // Put every scroller back afterwards: the next targets were found
          // reachable where the page was, and must be measured there.
          const scrolled: Array<{ node: Element; top: number; left: number }> = [];
          for (let p = el.parentElement; p; p = p.parentElement) scrolled.push({ node: p, top: p.scrollTop, left: p.scrollLeft });
          el.scrollIntoView({ block: "center", inline: "nearest" });
          const againRect = el.getBoundingClientRect();
          const again = band(el, againRect);
          for (const sc of scrolled) { sc.node.scrollTop = sc.top; sc.node.scrollLeft = sc.left; }
          if (again.hit && (!short_(again.hit, againRect) || !m.hit || again.hit.w * again.hit.h > m.hit.w * m.hit.h)) { m = again; rect = againRect; }
        }
        const { cx, cy } = m;
        // WCAG spacing: a 24px circle on this centre against every other target's box.
        const spacingOk = all.every((o) => {
          if (o.el === el || o.el.contains(el) || el.contains(o.el)) return true;
          const or = o.el.getBoundingClientRect();
          const nx = Math.max(or.left, Math.min(cx, or.right));
          const ny = Math.max(or.top, Math.min(cy, or.bottom));
          return Math.hypot(nx - cx, ny - cy) >= 12;
        });
        if (!m.hit) {
          // An invisible command that something else covers is not under the
          // pointer either: there is nothing to find there, nor to miss.
          if (transparent) continue;
          const h = document.elementFromPoint(cx, cy);
          targets.push({ ...base, hit: { w: 0, h: 0 }, ownsCentre: false, coveredBy: h ? describe(h) : "nothing", spacingOk });
          continue;
        }
        if (short_(m.hit, rect)) targets.push({ ...base, hit: m.hit, ownsCentre: true, spacingOk, edges: m.edges });
      }

      // ── projection steals ─────────────────────────────────────────────────
      // A `.tap-expand` area is a pseudo-element painted OVER the neighbours:
      // the band above proves the target is big enough, never that it took
      // nothing from anyone. Measured on 04/10 at 390x844: the task drawer's
      // project chip (`tap-expand-y`, 17 tall, 44 under a finger) answered the
      // top 10px of the task title below it, and «open a tab» (22x22 -> 44x44)
      // the right 7px of the «workspace» button beside it. Both bands were
      // fine seen from their centres.
      //
      // So, for every target that carries an `::after` or `::before`: every
      // point of a 24px ring around its box that answers to IT, asked again
      // with its pseudo-elements switched off. A different element answering
      // there is a victim, unless it contains the target or sits inside it (a
      // close button taking a corner of its own row is the point of the
      // projection). A victim is anything a click means something on: an
      // interactive role, or an element that DECLARES a click cursor without
      // one (the title's `<p onClick>` with `cursor:text` is not a button).
      const RING = 24;
      const STEP = 2;
      const OFF_ATTR = "data-usability-pseudo-off";
      const offStyle = document.createElement("style");
      offStyle.textContent = `[${OFF_ATTR}]::after,[${OFF_ATTR}]::before{display:none!important}`;
      document.head.appendChild(offStyle);
      const CLICK_CURSORS = new Set(["pointer", "text", "grab", "col-resize", "row-resize", "ew-resize", "ns-resize"]);
      /** The element a click at this hit means something to, or null. */
      const clickOwner = (h: Element | null): Element | null => {
        if (!h) return null;
        const semantic = h.closest(interactive);
        if (semantic) return semantic;
        // The element that declares the cursor, not a child that inherits it.
        for (let p: Element | null = h; p && p !== document.body; p = p.parentElement) {
          const c = getComputedStyle(p).cursor;
          if (!CLICK_CURSORS.has(c)) return null;
          const parent = p.parentElement;
          if (!parent || getComputedStyle(parent).cursor !== c) return p;
        }
        return null;
      };
      const hasPseudo = (el: Element): boolean => ["::after", "::before"].some((ps) => {
        const c = getComputedStyle(el, ps).content;
        return !!c && c !== "none" && c !== "normal";
      });
      const steals = new Map<string, { thief: string; thiefTestid: string | null; victim: string; victimTestid: string | null; px: number; sample: string }>();
      for (const { el } of all) {
        if (!hasPseudo(el)) continue;
        const r = el.getBoundingClientRect();
        const mine = (h: Element | null) => !!h && (h === el || el.contains(h));
        const ring: Array<[number, number]> = [];
        for (let x = Math.floor(r.left - RING) + 0.5; x < r.right + RING; x += STEP) {
          for (let y = Math.floor(r.top - RING) + 0.5; y < r.bottom + RING; y += STEP) {
            if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) continue;
            if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
            if (mine(document.elementFromPoint(x, y))) ring.push([x, y]);
          }
        }
        if (!ring.length) continue;
        el.setAttribute(OFF_ATTR, "");
        for (const [x, y] of ring) {
          const v = clickOwner(document.elementFromPoint(x, y));
          if (!v || v === el || el.contains(v) || v.contains(el)) continue;
          const key = `${describe(el)}|${describe(v)}`;
          const prev = steals.get(key);
          if (prev) prev.px += STEP * STEP;
          else steals.set(key, { thief: describe(el), thiefTestid: nearestTestId(el), victim: describe(v), victimTestid: nearestTestId(v), px: STEP * STEP, sample: `${x},${y}` });
        }
        el.removeAttribute(OFF_ATTR);
      }
      offStyle.remove();

      // ── text size ─────────────────────────────────────────────────────────
      const smallText = new Map<string, { selector: string; testid: string | null; fontSize: number; sample: string }>();
      let texts = 0;
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent ?? "").trim();
          if (!text) continue;
          const p = n.parentElement;
          if (!p || p.closest("script,style,noscript,template")) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const rr = range.getBoundingClientRect();
          // sr-only text is clipped to 1px: nobody reads it with the eyes.
          if (rr.width < 2 || rr.height < 2) continue;
          if (rr.right < 0 || rr.bottom < 0 || rr.left > vw || rr.top > vh) continue;
          if (!visible(p)) continue;
          texts++;
          const fs = parseFloat(getComputedStyle(p).fontSize);
          if (fs < 11) {
            const selector = describe(p);
            const key = `${selector}|${fs}`;
            if (!smallText.has(key)) smallText.set(key, { selector, testid: nearestTestId(p), fontSize: fs, sample: text.slice(0, 40) });
          }
        }
      }

      return {
        coarse: matchMedia("(pointer: coarse)").matches,
        scanned: { targets: all.length, texts },
        targets,
        smallText: [...smallText.values()],
        steals: [...steals.values()],
      };
    },
    { scope, minTap, interactive: INTERACTIVE },
  );

  // ── axe ────────────────────────────────────────────────────────────────
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const axe = await page.evaluate(async (scope) => {
    type Node = { target: string[]; html: string; failureSummary?: string };
    type Rule = { id: string; impact: string | null; nodes: Node[] };
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } }).axe;
    if (!document.querySelector(scope)) return { violations: [], incomplete: [], decided: [] };
    const res = await axe.run({ include: [[scope]] }, {
      runOnly: { type: "rule", values: ["color-contrast", "target-size", "button-name", "link-name"] },
      resultTypes: ["violations", "incomplete"],
    });
    const testIdOf = (sel: string) => {
      try { return document.querySelector(sel)?.closest("[data-testid]")?.getAttribute("data-testid") ?? null; } catch { return null; }
    };
    const map = (rules: Rule[]) => rules.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), testid: testIdOf(n.target[n.target.length - 1]!), summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 220) })),
    }));
    // ── contrast axe could not decide, decided here ──────────────────────
    // axe leaves a node `incomplete` when another element overlaps it
    // (bgOverlap), its ground is translucent or an image: 406 nodes on 04/10,
    // the whole transcript, the tool rows, the board cards. Unread, they were
    // a pass by silence, and one of them was under AA (the card's «worked
    // here» chip, 4.15:1 at 11px on the dark theme). Each one is computed
    // here: the text colour over the element's ancestors' grounds composited
    // bottom-up, every colour converted by a canvas (the tokens are oklch, a
    // regexp on rgb() reads them as black). The ancestors' opacity fades the
    // text only, never the ground: the lower ratio of the two readings.
    // An image or gradient ground under the text cannot be composited from
    // the DOM: that node is `undecided`, and the caller must rule on it.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const toChannels = (c: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const a = d[3]! / 255;
      return a === 0 ? [0, 0, 0, 0] : [d[0]!, d[1]!, d[2]!, a];
    };
    const over = (top: number[], bot: number[]): number[] => {
      const a = top[3]! + bot[3]! * (1 - top[3]!);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i]! * top[3]! + bot[i]! * bot[3]! * (1 - top[3]!)) / a).concat([a]);
    };
    const lum = (c: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const contrastOf = (el: Element): { ratio: number; needed: number; undecided?: string } | null => {
      if (el.closest("[disabled],[aria-disabled='true']")) return null; // WCAG 1.4.3: inactive controls are exempt
      const cs = getComputedStyle(el);
      let opacity = 1;
      for (let q: Element | null = el; q; q = q.parentElement) opacity *= parseFloat(getComputedStyle(q).opacity);
      if (opacity === 0) return null;
      const layers: number[][] = [];
      let undecided: string | undefined;
      let opaque = false;
      for (let q: Element | null = el; q; q = q.parentElement) {
        const s = getComputedStyle(q);
        if (s.backgroundImage && s.backgroundImage !== "none" && !undecided) undecided = `image ground on ${q.tagName.toLowerCase()}`;
        const bg = toChannels(s.backgroundColor);
        if (bg[3]! > 0) layers.push(bg);
        if (bg[3] === 1) { opaque = true; break; }
      }
      let ground = opaque ? [0, 0, 0, 0] : [255, 255, 255, 1]; // the canvas behind an unpainted page
      for (let i = layers.length - 1; i >= 0; i--) ground = over(layers[i]!, ground);
      const fg = toChannels(cs.color);
      const text = over([fg[0]!, fg[1]!, fg[2]!, fg[3]! * opacity], ground);
      const la = lum(text), lb = lum(ground);
      const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      const fs = parseFloat(cs.fontSize);
      const fw = parseInt(cs.fontWeight, 10) || 400;
      const needed = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;
      return { ratio: Math.round(ratio * 100) / 100, needed, ...(undecided ? { undecided } : {}) };
    };
    type IncompleteNode = Node & { any?: Array<{ data?: { messageKey?: string } }> };
    const decided = res.incomplete.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes.map((n) => {
      const selector = n.target[n.target.length - 1]!;
      let el: Element | null = null;
      try { el = document.querySelector(selector); } catch { /* a selector axe built and the DOM no longer has */ }
      const reason = ((n as IncompleteNode).any ?? []).map((a) => a.data?.messageKey).filter(Boolean).join(",") || "unknown";
      const c = el ? contrastOf(el) : null;
      return {
        target: n.target.join(" "),
        testid: testIdOf(selector),
        reason,
        text: (el?.textContent ?? "").trim().slice(0, 40),
        ...(c ?? { ratio: null, needed: null }),
        exempt: !!el && !c,
      };
    }));
    return { violations: map(res.violations), incomplete: map(res.incomplete.filter((r) => r.id === "color-contrast")), decided };
  }, scope);

  // ── ui-audit (raw, for overflow and overlap) ─────────────────────────────
  if (!(await page.evaluate(() => "__uiAudit" in window))) await page.addScriptTag({ path: UI_AUDIT_PATH });
  const uiAudit = await page.evaluate(
    (opts) => {
      if (!document.querySelector(opts.scope)) return null;
      return JSON.parse((window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit(opts));
    },
    { scope, tol: 4, maxEls: 600, minTap, limit: 25 },
  );

  return {
    scope,
    minTap,
    coarse: inPage.coarse,
    scanned: inPage.scanned,
    targets: inPage.targets,
    smallText: inPage.smallText,
    axe: axe.violations,
    axeIncomplete: axe.incomplete,
    contrastDecided: axe.decided,
    steals: inPage.steals,
    uiAudit,
  };
}

// ── testid → source file ───────────────────────────────────────────────────

let sourceIndex: Array<{ file: string; text: string }> | null = null;
function sources(): Array<{ file: string; text: string }> {
  if (sourceIndex) return sourceIndex;
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: relative(REPO_ROOT, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(CLIENT_SRC);
  sourceIndex = out;
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The files that write this testid. Exact literal first; then, for testids
 * built from an id (`tool-call-row-run-0`, `task-card-<uuid>`), the longest
 * prefix that appears as the head of a template literal or a string.
 */
export function componentFilesFor(testid: string | null): string[] {
  if (!testid) return [];
  const exact = new RegExp(`(["'\`])${escape(testid)}\\1`);
  let hits = sources().filter((s) => exact.test(s.text)).map((s) => s.file);
  if (hits.length) return hits.slice(0, 3);
  const parts = testid.split("-");
  for (let n = parts.length - 1; n >= 1; n--) {
    const stem = parts.slice(0, n).join("-");
    const prefix = stem + "-";
    const re = new RegExp(`(["'\`])${escape(prefix)}(\\$\\{|\\1)`);
    hits = sources().filter((s) => re.test(s.text)).map((s) => s.file);
    if (hits.length) return hits.slice(0, 3);
    // A shared control that suffixes the `testId` it was handed
    // (`testId="appearance-theme"` -> `appearance-theme-light`): the caller.
    const handed = new RegExp(`[tT]est[iI]d[=:]\\s*\\{?["'\`]${escape(stem)}["'\`]`);
    hits = sources().filter((s) => handed.test(s.text)).map((s) => s.file);
    if (hits.length) return hits.slice(0, 3);
  }
  // `testId="x"` props passed down to a shared component.
  const prop = new RegExp(`[tT]est[iI]d[=:]\\s*\\{?["'\`]${escape(testid)}`);
  return sources().filter((s) => prop.test(s.text)).map((s) => s.file).slice(0, 3);
}
