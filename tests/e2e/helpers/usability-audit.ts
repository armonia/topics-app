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
 * 3. AXE. `color-contrast`, `target-size`, `button-name`, `link-name`, the WCAG
 *    subset that a DOM can decide. Contrast is run per theme by the caller.
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
      const all: Array<{ el: HTMLElement; r: DOMRect }> = [];
      for (const root of roots) {
        const list = [...(root.matches(interactive) ? [root] : []), ...root.querySelectorAll<HTMLElement>(interactive)];
        for (const el of list) {
          if (seen.has(el)) continue;
          seen.add(el);
          if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (!visible(el)) continue;
          // WCAG 2.5.8 "Inline": a link inside a sentence takes its size from the
          // line it sits on. Same exemption as ui-audit.js.
          const cs = getComputedStyle(el);
          if (cs.display === "inline" && el.tagName === "A") {
            const host = el.parentElement;
            const ownText = (el.textContent ?? "").trim().length;
            if (host && (host.textContent ?? "").trim().length > ownText + 8) continue;
          }
          if (!reachable(el, r.left + r.width / 2, r.top + r.height / 2)) continue;
          all.push({ el, r });
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
      }> = [];
      /** The band through the centre that answers to `el`, or null if the centre does not. */
      const band = (el: HTMLElement, r: DOMRect) => {
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const mine = owns(el);
        const at = (x: number, y: number) => mine(document.elementFromPoint(x, y));
        if (!at(cx, cy)) return { cx, cy, hit: null };
        let left = cx, right = cx, top = cy, bottom = cy;
        while (cx - left < CAP && at(left - 1, cy)) left--;
        while (right - cx < CAP && at(right + 1, cy)) right++;
        while (cy - top < CAP && at(cx, top - 1)) top--;
        while (bottom - cy < CAP && at(cx, bottom + 1)) bottom++;
        return { cx, cy, hit: { w: right - left + 1, h: bottom - top + 1 } };
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
      for (const { el, r } of all) {
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
          const h = document.elementFromPoint(cx, cy);
          targets.push({ ...base, hit: { w: 0, h: 0 }, ownsCentre: false, coveredBy: h ? describe(h) : "nothing", spacingOk });
          continue;
        }
        if (short_(m.hit, rect)) targets.push({ ...base, hit: m.hit, ownsCentre: true, spacingOk });
      }

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
    if (!document.querySelector(scope)) return { violations: [], incomplete: [] };
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
    return { violations: map(res.violations), incomplete: map(res.incomplete.filter((r) => r.id === "color-contrast")) };
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
