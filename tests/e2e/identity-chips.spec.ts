/**
 * THE IDENTITY CHIPS, MEASURED: one line, readable ink, pressable targets.
 *
 * The band at the foot of the column stopped being a wrapping flow of
 * borderless chips (8f58d75). Three things were decided there, and each one is
 * a number this file reads off the screen rather than a sentence in a docstring:
 *
 *  1. ONE LINE, AT EVERY WIDTH. The band used to take one line or three
 *     depending on how many groups you had joined that week, so its own shape
 *     moved with the data. It is now three mini-cards on a single row at 180,
 *     256 and 400, which are the real minimum, default and maximum of the
 *     column (`useSidebarAndLayout` clamps the drag to `max(180, min(400, x))`,
 *     and `DEFAULT_SETTINGS.sidebarWidth` is 256). The width is seeded through
 *     the same key the app persists it under and then VERIFIED on the sidebar
 *     box: a test that measures a 256px column three times measures nothing.
 *
 *  2. THE INK STILL READS OVER THE NEW VEIL. A filled chip is a background
 *     change under text whose tokens were tuned against the BARE chrome, so
 *     those tokens have to be re-measured against what the eye now sees:
 *     `helpers/contrast.ts` composites the ancestors up to the first opaque
 *     background instead of trusting the declared colour of the node. The empty
 *     states are measured too, and on purpose: they are the muted ones.
 *     axe-core runs on the same band, scoped, as the second opinion.
 *
 *  3. EVERY CHIP IS STILL A TARGET. `CHIP_TARGET_PX` is imported rather than
 *     spelled out here, so the floor and the assertion cannot drift apart.
 *
 * BOTH THEMES, because they lose in opposite directions: the veil is black over
 * a light chrome (which darkens the ground under dark ink) and white over a
 * dark one (which lifts it). Switching costs one `emulateMedia` and a reload,
 * so there is no reason to pick one and argue about the other.
 *
 * @covers STATUSLINE-01
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { AA_TESTO, contrastOf } from "./helpers/contrast";
import { clipDiConsegna } from "./helpers/clip";
import { beat } from "./helpers/evidence";
import { E2E_BASE } from "./helpers/test-server";
import { CHIP_TARGET_PX, ORG_MARKS_IN_CHIP } from "../../client/src/components/Sidebar/identityChip";

hermetic(test);

/** Everything this file produces goes in one place, evidence included. */
const SHOTS = "test-results/identity-chips";
/** `__dirname` and not `import.meta.url`: Playwright transpiles specs to CJS. */
const AXE_PATH = resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
const BAND = '[data-testid="identity-block"]';

/**
 * The three widths the column can actually be at. Not round numbers picked for
 * a test: 180 and 400 are the two ends the resize drag clamps to, 256 is what a
 * fresh installation starts on.
 */
const WIDTHS = [180, 256, 400] as const;

/** The three subjects, in the order they sit on the line. */
const SUBJECTS: string[] = ["identity-row-me", "identity-row-orgs", "identity-row-friends"];

/** Every chip the band can draw, so a run that finds fewer says so instead of
 *  reporting a green measurement of an empty band. */
const FILLED_CHIPS = ["identity-me-profile", "org-chip", "identity-friends-chip"];
const EMPTY_CHIPS = ["identity-me-profile", "org-chip-empty", "identity-friends-chip"];

/** A member as the route sends it: raw milliseconds, not a boolean. */
function member(id: string, name: string, lastSeenAt: number | null) {
  return { id, name, email: `${id}@example.test`, role: "member", lastSeenAt };
}

interface Population {
  /** What `/api/auth/orgs` answers. Empty is the state the outlined chip is for. */
  orgs: Array<{ id: string; name: string }>;
  /** What every organisation answers for its members. */
  members: ReturnType<typeof member>[];
  /** The address book: this is where the client learns who YOU are. */
  people: Array<{ id: string; displayName: string; isMe: boolean }>;
  /** Your FRIENDS, which is what the third subject draws since the friendship
   *  graph replaced the organisation address book behind it. `lastSeenAt` is
   *  what makes a face appear on the closed chip. */
  friends: Array<{ id: string; displayName: string; lastSeenAt: number | null }>;
}

/**
 * The minimum identity data needed for the band to be drawn at all.
 *
 * Copied in shape from `org-presence.spec.ts`, and the shapes are the REAL ones
 * of the routes rather than something already chewed. `/api/auth/session` has
 * to say `paired`: the whole band sits behind `session.status !== 'paired'`, so
 * an invented stub leaves it unmounted and the red blames the layout instead of
 * the fake server.
 *
 * Calling it twice on the same page is deliberate and supported: a later
 * `page.route` for the same pattern takes precedence, which is how one test
 * moves from the populated state to the empty one without a second context.
 */
async function stubIdentity(page: Page, population: Population): Promise<void> {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                             role: "owner", personId: "io" }) }));
  await page.route("**/api/auth/devices", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ devices: [{ connected: true, revokedAt: null }] }) }));
  await page.route("**/api/auth/orgs", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ orgs: population.orgs.map((o, i) => ({ ...o, installation: i === 0 })) }) }));
  await page.route("**/api/auth/orgs/*/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ members: population.members }) }));
  // The WHOLE shape of a person, `stats` and the follow fields included: a half
  // stub is not a smaller stub, it is a different server.
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        people: population.people.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: { prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null },
          counts: { followers: 0, following: 0 },
          viewerFollows: false,
          followsViewer: false,
          lastSeenAt: null,
          ...p,
        })),
      }) }));
  await page.route("**/api/people/*/follow*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ people: [] }) }));
  // The friendship graph: three lists from one read, the shape `friendsApi`
  // expects. Unrouted it would reach the real server, which knows none of
  // these ids, and the third subject would measure an empty chip while the
  // test believed it was measuring a full one.
  await page.route("**/api/friendships", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        friends: population.friends.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: null,
          isMe: false,
          counts: null,
          viewerFollows: false,
          followsViewer: false,
          since: 0,
          ...p,
        })),
        incoming: [],
        outgoing: [],
      }) }));
  // THE WORST CASE FOR THE LINE, not a quiet machine. Three signals is the cap
  // `workSignals` enforces, so this is the widest the "me" chip can ever get,
  // which is exactly the pressure the 180px column has to survive.
  await page.route("**/api/system/presence", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ openSessions: 12, workingSessions: 3, activeTasks: 2, focusProject: null }) }));
}

/** Groups you are in, with two colleagues seen a moment ago and one who is not.
 *  The display name is a placeholder on purpose and stays one: the repository
 *  is public, and a plausible first-name-plus-surname in a tracked file is what
 *  `tests/unit/no-personal-data-tracked.test.ts` exists to refuse. */
function populated(orgCount: number): Population {
  const now = Date.now();
  return {
    orgs: Array.from({ length: orgCount }, (_, i) => ({ id: `org${i + 1}`, name: `Gruppo ${i + 1}` })),
    members: [
      member("io", "Io", now),               // you do not count yourself
      member("a", "Anna", now - 30_000),
      member("b", "Bruno", now - 60_000),
      member("c", "Carla", now - 3_600_000), // an hour ago: past the threshold
    ],
    people: [
      { id: "io", displayName: "Utente Locale", isMe: true },
      { id: "a", displayName: "Anna", isMe: false },
      { id: "b", displayName: "Bruno", isMe: false },
      { id: "c", displayName: "Carla", isMe: false },
    ],
    // Two friends here now and one who is not: the same pressure the chip used
    // to get from the organisation members, on the relation it actually names.
    friends: [
      { id: "a", displayName: "Anna", lastSeenAt: now - 30_000 },
      { id: "b", displayName: "Bruno", lastSeenAt: now - 60_000 },
      { id: "c", displayName: "Carla", lastSeenAt: now - 3_600_000 },
    ],
  };
}

/** In no group and knowing nobody: the two subjects that used to vanish. */
function alone(): Population {
  return {
    orgs: [],
    members: [],
    people: [{ id: "io", displayName: "Utente Locale", isMe: true }],
    friends: [],
  };
}

/**
 * Put the column at `width` and come back with what it actually measures.
 *
 * The width lives in `app-settings` under `sidebarWidth`, one of the three
 * DEVICE-LOCAL keys the server strips out of the settings it hydrates
 * (`DEVICE_LOCAL_SETTING_KEYS`): localStorage is therefore the only authority,
 * so writing it and reloading is not a race with the network. Written and
 * reloaded rather than pushed through `addInitScript` because init scripts
 * accumulate on a page, and three of them disagreeing about one number is a
 * worse way to be wrong than one reload.
 */
async function setSidebarWidth(page: Page, width: number): Promise<number> {
  await page.evaluate((w) => {
    const raw = localStorage.getItem("app-settings");
    const base: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    // `sidebarWidthExpanded` too: it is the width a reopen restores to, and
    // leaving it behind lets a collapse round trip undo the seed.
    localStorage.setItem("app-settings", JSON.stringify({
      ...base, sidebarWidth: w, sidebarWidthExpanded: w, sidebarCollapsed: false,
    }));
  }, width);
  await page.reload();
  const column = page.locator('[aria-label="Topics sidebar"]');
  await expect(column).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("identity-block")).toBeVisible({ timeout: 20000 });
  const box = await column.boundingBox();
  return Math.round(box?.width ?? 0);
}

interface BandGeometry {
  /** One entry per subject: its box, rounded to whole pixels. */
  subjects: Array<{ id: string; top: number; bottom: number; left: number; width: number; height: number }>;
  /**
   * The chips themselves, which is NOT the same measurement as the subjects.
   * A subject is elastic and may be squeezed to zero width; the chip inside it
   * carries `min-w-[24px]` and therefore keeps its size, spilling out of a
   * parent that has none. Only the chip boxes can say whether the three cards
   * are side by side or on top of one another.
   *
   * `spill` is how far the chip's own CONTENT is painted past its right edge.
   * It is a third measurement again, and the one the pixels agree with: a chip
   * squeezed to its floor still lays its glyph, its name and its signals out at
   * full size, and with nothing clipping them they land on the neighbour. The
   * box can be innocent while the ink is not.
   */
  chips: Array<{ id: string; left: number; right: number; spill: number }>;
  /** The band's own overflow budget. Equal means nothing is cropped sideways. */
  scrollWidth: number;
  clientWidth: number;
}

/** The band's geometry, read in one round trip so the three subjects cannot be
 *  measured a frame apart from each other. */
async function bandGeometry(page: Page): Promise<BandGeometry> {
  return page.evaluate((wanted) => {
    const band = document.querySelector('[data-testid="identity-block"]');
    if (!band) throw new Error("no identity band on screen");
    return {
      subjects: wanted.map((id) => {
        const el = band.querySelector(`[data-testid="${id}"]`);
        if (!el) throw new Error(`subject ${id} is not on the line`);
        const r = el.getBoundingClientRect();
        return {
          id,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }),
      chips: Array.from(band.querySelectorAll<HTMLElement>("button")).map((b) => {
        const r = b.getBoundingClientRect();
        let far = r.right;
        for (const child of Array.from(b.querySelectorAll<HTMLElement>("*"))) {
          const c = child.getBoundingClientRect();
          if (c.width <= 0) continue;
          // A CLIPPED CHILD DOES NOT PAINT. This measures ink, not layout, and
          // the two stopped agreeing the day a chip got `overflow-hidden`: a
          // clipped box still reports its full geometric rect, so the raw
          // `right` reads a spill that nothing ever draws. Clamping to every
          // clipping ancestor up to the chip is what makes the number mean
          // what the assertion says it means.
          //
          // The gate does NOT get weaker: a chip that lets its contents out
          // still fails, and the overlap check next door still refuses two
          // boxes sharing pixels. What goes away is a red about paint that
          // does not exist.
          let right = c.right;
          for (let a = child.parentElement; a; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
              right = Math.min(right, a.getBoundingClientRect().right);
            }
            if (a === b) break;
          }
          if (right > far) far = right;
        }
        return {
          id: b.getAttribute("data-testid") ?? "(unnamed button)",
          left: Math.round(r.left),
          right: Math.round(r.right),
          spill: Math.round(far - r.right),
        };
      }),
      scrollWidth: band.scrollWidth,
      clientWidth: band.clientWidth,
    };
  }, SUBJECTS);
}

/**
 * Tag every element in the band that paints TEXT of its own, and hand back a
 * selector for each.
 *
 * The attribute exists so `contrastOf` (which takes a selector) can point at a
 * node found by walking the DOM: the WCAG arithmetic and the compositing walk
 * stay in the shared helper instead of being copied here, which is how a
 * contrast gate quietly stops measuring what it believes it measures.
 */
async function probeInk(page: Page): Promise<Array<{ label: string; selector: string; text: string }>> {
  return page.evaluate(() => {
    const band = document.querySelector('[data-testid="identity-block"]');
    if (!band) throw new Error("no identity band on screen");
    for (const stale of Array.from(document.querySelectorAll("[data-ink-probe]"))) {
      stale.removeAttribute("data-ink-probe");
    }
    const out: Array<{ label: string; selector: string; text: string }> = [];
    let n = 0;
    for (const el of Array.from(band.querySelectorAll<HTMLElement>("*"))) {
      // Only the element that OWNS the text node paints it. Measuring a parent
      // would judge ink it does not draw, and would count one chip three times.
      const own = Array.from(el.childNodes)
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent ?? "")
        .join("")
        .trim();
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const chip = el.closest("[data-testid]")?.getAttribute("data-testid") ?? "identity-block";
      el.setAttribute("data-ink-probe", String(n));
      out.push({ label: `${chip} "${own}"`, selector: `[data-ink-probe="${n}"]`, text: own });
      n++;
    }
    return out;
  });
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string }>;
}

/** axe-core on the band only. Scoped, because the rest of the app has its own
 *  audits and a violation from the topic tree would be noise here. */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const res = await axe.run(
      { include: [[sel]] },
      { resultTypes: ["violations"], rules: { "color-contrast": { enabled: true } } },
    );
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
    }));
  }, BAND) as Promise<AxeViolation[]>;
}

/** The numbers reach disk BEFORE they are judged: a red that only says
 *  "expected >= 4.5" costs a whole rerun to find out what it actually read. */
function persist(name: string, payload: unknown): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.json`), JSON.stringify(payload, null, 2));
}

/** Enough of the column to recognise it, with the band at the bottom of the
 *  frame. A crop of the band alone proves the measurement and is unreadable as
 *  a thumbnail, which is how this evidence gets looked at. */
async function shootColumn(page: Page, file: string): Promise<void> {
  const box = await page.getByTestId("identity-block").boundingBox();
  const width = 720;
  const height = 500;
  await page.screenshot({
    path: join(SHOTS, file),
    clip: {
      x: 0,
      y: Math.max(0, Math.round((box?.y ?? 700) + (box?.height ?? 24) + 10 - height)),
      width,
      height,
    },
  });
}

/** The chips actually on screen, with their boxes. */
async function chipTargets(page: Page): Promise<Array<{ testid: string; width: number; height: number }>> {
  return page.evaluate(() => {
    const band = document.querySelector('[data-testid="identity-block"]');
    if (!band) throw new Error("no identity band on screen");
    return Array.from(band.querySelectorAll<HTMLElement>("button")).map((b) => {
      const r = b.getBoundingClientRect();
      return {
        testid: b.getAttribute("data-testid") ?? "(unnamed button)",
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
      };
    });
  });
}

test.describe("identity chips", () => {
  test("CHIPS-01: the three subjects hold one line at 180, 256 and 400", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // TWO POPULATIONS, because the failure modes are opposite: one group is the
    // ordinary case, four is the one that stacks marks and adds a count inside
    // the single card, and is therefore the widest that subject can get.
    const cases = [
      { name: "one-group", population: populated(1), mark: "org-chip" },
      { name: "four-groups", population: populated(4), mark: "org-chip-count" },
    ];
    const measures: Array<{ case: string; asked: number; column: number } & BandGeometry> = [];

    await stubIdentity(page, cases[0]!.population);
    await page.goto("/");
    for (const c of cases) {
      await stubIdentity(page, c.population);
      for (const width of WIDTHS) {
        const column = await setSidebarWidth(page, width);
        await expect(page.getByTestId(c.mark).first()).toBeVisible({ timeout: 20000 });
        measures.push({ case: c.name, asked: width, column, ...(await bandGeometry(page)) });
        await shootColumn(page, c.name === "one-group" ? `after-${width}.png` : `after-${width}-four-groups.png`);
      }
    }
    persist("one-line", measures);

    for (const m of measures) {
      const where = `${m.case} at ${m.asked}px`;
      // THE COLUMN REALLY IS THAT WIDE. Without this the assertions below would
      // pass three times over the same 256px band and prove nothing.
      expect(m.column, `${where}: sidebar measured ${m.column}px`).toBe(m.asked);

      const tops = m.subjects.map((s) => s.top);
      const bottoms = m.subjects.map((s) => s.bottom);
      const say = m.subjects.map((s) => `${s.id} top=${s.top} h=${s.height}`).join(", ");
      // ONE LINE: same top AND same bottom. Tops alone would still agree if a
      // subject grew a second row downwards, which is exactly how the group
      // chips broke the band before their faces were capped at two.
      expect(Math.max(...tops) - Math.min(...tops), `${where}: tops disagree (${say})`)
        .toBeLessThanOrEqual(1);
      expect(Math.max(...bottoms) - Math.min(...bottoms), `${where}: bottoms disagree (${say})`)
        .toBeLessThanOrEqual(1);
      // AND NOTHING IS PUSHED OUT SIDEWAYS. `overflow-hidden` is what stops the
      // column growing a scrollbar; it is also what would hide a subject in
      // silence if one of them refused to shrink. The two numbers agreeing is
      // the difference between "it fits" and "it is cropped".
      expect(m.scrollWidth, `${where}: band overflows, ${m.scrollWidth} > ${m.clientWidth}`)
        .toBeLessThanOrEqual(m.clientWidth + 1);

      // AND THE THREE CARDS ARE SIDE BY SIDE, not stacked.
      //
      // "One line" and "no overflow" can both hold while the band is broken,
      // and this is the case that proves it: the "me" subject is the elastic
      // one, so when the other two want more than the column has, it is handed
      // a width of ZERO. Its chip does not shrink with it (the width floor in
      // `identityChip.ts` is the pointer target), so it keeps painting those
      // pixels inside a parent that occupies none, on top of whatever comes
      // next. The band still reports
      // one line and a scrollWidth that fits, because the spill is INTERNAL.
      const spread = [...m.chips].sort((a, b) => a.left - b.left);
      for (let i = 1; i < spread.length; i++) {
        const before = spread[i - 1]!;
        const after = spread[i]!;
        expect(
          after.left,
          `${where}: ${before.id} (${before.left}..${before.right}) overlaps ${after.id} (${after.left}..${after.right})`,
        ).toBeGreaterThanOrEqual(before.right);
      }
      // AND NO CHIP PAINTS OUTSIDE ITSELF. Nothing clips a chip's contents, so
      // a chip pressed down to its width floor keeps drawing its full width of
      // glyph, name and signals straight over the next card. This is the one
      // that matches the screenshot: the box measurements above can all be
      // clean while the band reads as a pile.
      for (const chip of m.chips) {
        expect(chip.spill, `${where}: ${chip.id} paints ${chip.spill}px past its own right edge`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  test("CHIPS-02: every chip is at least CHIP_TARGET_PX on both sides", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // Measured at 180: the narrowest column is where a chip would be squeezed
    // under its floor, and the outlined ones are the smallest of the set
    // because they carry a glyph and a digit instead of a name and faces.
    const cases = [
      { name: "populated", population: populated(4), expected: FILLED_CHIPS },
      { name: "alone", population: alone(), expected: EMPTY_CHIPS },
    ];
    const targets: Array<{ case: string; testid: string; width: number; height: number }> = [];

    await stubIdentity(page, cases[0]!.population);
    await page.goto("/");
    for (const c of cases) {
      await stubIdentity(page, c.population);
      await setSidebarWidth(page, 180);
      await expect(page.getByTestId(c.expected[1]!).first()).toBeVisible({ timeout: 20000 });
      const seen = await chipTargets(page);
      // The whole set, not "some buttons": a band that lost a chip would
      // otherwise report a green measurement of what is left.
      expect(seen.map((s) => s.testid).sort(), `${c.name}: chips on screen`)
        .toEqual([...c.expected].sort());
      for (const s of seen) targets.push({ case: c.name, ...s });
    }
    persist("targets", { floor: CHIP_TARGET_PX, targets });

    for (const t of targets) {
      expect(t.height, `${t.case}/${t.testid} is ${t.height}px tall`).toBeGreaterThanOrEqual(CHIP_TARGET_PX);
      expect(t.width, `${t.case}/${t.testid} is ${t.width}px wide`).toBeGreaterThanOrEqual(CHIP_TARGET_PX);
    }
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`CHIPS-03 (${scheme}): the ink reads over the chip's real background`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
      await page.emulateMedia({ colorScheme: scheme });
      await stubIdentity(page, populated(4));
      await page.goto("/");
      await setSidebarWidth(page, 256);
      // The theme really switched: Topics follows the system by default and
      // paints through the `.dark` class, so this reads the same signal the app
      // does instead of trusting the emulation.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");
      await expect(page.getByTestId("org-chip").first()).toBeVisible({ timeout: 20000 });

      const readings: Array<{ state: string; label: string; ratio: number; color: string; bg: string }> = [];
      const read = async (state: string) => {
        for (const probe of await probeInk(page)) {
          const r = await contrastOf(page, probe.selector);
          readings.push({
            state,
            label: probe.label,
            ratio: Math.round(r.ratio * 100) / 100,
            color: r.color,
            bg: r.bg,
          });
        }
      };
      await read("populated");
      // Then the outlined states, which is where the muted tokens live: muted
      // ink over a veil is the losing combination, so it is the one that has to
      // be in the measurement rather than reasoned about.
      await stubIdentity(page, alone());
      await page.reload();
      await expect(page.getByTestId("org-chip-empty")).toBeVisible({ timeout: 20000 });
      await read("alone");

      const violations = await runAxe(page);
      persist(`contrast-${scheme}`, { floor: AA_TESTO, readings, axe: violations });

      expect(readings.length, "nothing was measured: the band painted no text").toBeGreaterThanOrEqual(6);
      for (const r of readings) {
        expect(
          r.ratio,
          `${scheme}/${r.state} ${r.label}: ${r.ratio}:1 (${r.color} on ${r.bg})`,
        ).toBeGreaterThanOrEqual(AA_TESTO);
      }
      expect(violations.map((v) => `${v.id}: ${v.help}`), `axe on the identity band (${scheme})`).toEqual([]);
    });
  }

  test("CHIPS-04: in no group at all, the slot stays and opens its panel", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // The subject used to return null at zero, which made the band two chips
    // wide and left "which groups am I in" unanswered for the only person who
    // needed the answer.
    await stubIdentity(page, alone());
    await page.goto("/");
    await setSidebarWidth(page, 256);
    const empty = page.getByTestId("org-chip-empty");
    await expect(empty).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip")).toHaveCount(0);
    await shootColumn(page, "after-alone.png");
    // Still a door, not a placeholder.
    await empty.click();
    await expect(page.getByTestId("org-empty-panel")).toBeVisible();
  });

  test("CHIPS-05: four groups are ONE card, and the panel has all four", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    await stubIdentity(page, populated(4));
    await page.goto("/");
    await setSidebarWidth(page, 256);
    const card = page.getByTestId("org-chip");
    await expect(card).toBeVisible({ timeout: 20000 });
    // ONE SLOT, WHATEVER THE COUNT. This is the assertion the previous shape
    // could not make: the subject used to be one chip, or two, or two and a
    // counter, so its width moved with the data and the band changed shape
    // between two installations that differ only in how many groups they joined.
    expect(await card.count()).toBe(1);
    // The marks stack inside it, bounded, and the number carries the rest:
    // nothing is hidden without something saying how much.
    expect(await page.getByTestId("identity-row-orgs").getByTestId("identity-glyph").count())
      .toBeLessThanOrEqual(ORG_MARKS_IN_CHIP);
    await expect(page.getByTestId("org-chip-count")).toHaveText("4");

    const geometry = await bandGeometry(page);
    const tops = geometry.subjects.map((s) => s.top);
    expect(Math.max(...tops) - Math.min(...tops), `tops ${tops.join(", ")}`).toBeLessThanOrEqual(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);

    // AND ALL FOUR ARE BEHIND IT, one section each. The old `+n` panel listed
    // only the groups that had not fitted: the two on the line had a panel
    // apiece, so comparing four groups took three clicks and two of the panels
    // did not exist.
    await card.click();
    await expect(page.getByTestId("org-panel")).toBeVisible();
    await expect(page.getByTestId("org-section")).toHaveCount(4);
  });

  test("CHIPS-06: the delivery clip, the band at the three widths", async () => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // No video outside `E2E_CLIP=1`: the same code path runs either way, so the
    // clip never proves a road the gate does not walk.
    await clipDiConsegna({
      nome: "identity-chips-tour",
      dir: resolve(__dirname, "../..", SHOTS),
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1180, height: 760 },
        reducedMotion: "reduce",
      },
      // Reaching a paired app with four groups is setup: it runs on a page
      // whose video is thrown away.
      prologo: async (p) => {
        await stubIdentity(p, populated(4));
        await p.goto("/");
        await expect(p.getByTestId("org-chip")).toBeVisible({ timeout: 20000 });
      },
      scena: async (p) => {
        await stubIdentity(p, populated(4));
        await p.goto("/");
        await expect(p.getByTestId("identity-block")).toBeVisible({ timeout: 20000 });
        for (const width of WIDTHS) {
          await setSidebarWidth(p, width);
          await beat(p, 1300);
        }
        await p.getByTestId("org-chip").click();
        await expect(p.getByTestId("org-panel")).toBeVisible();
        await beat(p, 2200);
      },
    });
  });
});
