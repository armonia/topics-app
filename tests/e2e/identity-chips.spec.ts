/**
 * THE FOOT OF THE COLUMN, MEASURED: chips that scroll, one card that fits.
 *
 * The band used to be three mini-cards on one line (me, my groups, my
 * friends), each a door to a panel of its own. It is now two things and no
 * more (STATUSLINE-04): a row of CHIPS, one per friend who is here right now,
 * that scrolls sideways and is not drawn at all when nobody is around; and ONE
 * CARD that is you, as wide as the column, carrying your face, your first
 * name and what the machine is spending. Everything else is behind the card.
 *
 * Each of those decisions is a number this file reads off the screen rather
 * than a sentence in a docstring:
 *
 *  1. THE CARD FITS, AT EVERY WIDTH. The column can be 180, 256 or 400 wide
 *     (`useSidebarAndLayout` clamps the drag to `max(180, min(400, x))`, and
 *     `DEFAULT_SETTINGS.sidebarWidth` is 256). At each of them the band does
 *     not overflow its box and the card does not overflow its own: a name that
 *     does not fit truncates, it does not push the numbers off the edge. The
 *     width is seeded through the key the app persists it under and then
 *     VERIFIED on the sidebar box: a test that measures a 256px column three
 *     times measures nothing.
 *
 *  2. THE CHIPS SCROLL, THEY DO NOT WRAP. Three people at 180 do not fit on
 *     one line, and the answer is a row that scrolls, not a band that grows a
 *     second line: the ONLY box in the band allowed to hold more than it
 *     shows is the chip row. `flex-wrap` is read from the computed style and
 *     the chips are checked to share one top.
 *
 *  3. EVERY CHIP AND THE CARD ARE STILL TARGETS. `CHIP_TARGET_PX` is imported
 *     rather than spelled out here, so the floor and the assertion cannot
 *     drift apart.
 *
 *  4. THE INK STILL READS OVER THE VEIL. A filled chip is a background change
 *     under text whose tokens were tuned against the BARE chrome, so those
 *     tokens are re-measured against what the eye sees: `helpers/contrast.ts`
 *     composites the ancestors up to the first opaque background instead of
 *     trusting the declared colour of the node. axe-core runs on the same
 *     band, scoped, as the second opinion.
 *
 * BOTH THEMES, because they lose in opposite directions: the veil is black over
 * a light chrome (which darkens the ground under dark ink) and white over a
 * dark one (which lifts it). Switching costs one `emulateMedia` and a reload,
 * so there is no reason to pick one and argue about the other.
 *
 * @covers STATUSLINE-04, STATUSLINE-01
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { AA_TESTO, contrastOf } from "./helpers/contrast";
import { clipDiConsegna } from "./helpers/clip";
import { beat } from "./helpers/evidence";
import { E2E_BASE } from "./helpers/test-server";
import { CHIP_TARGET_PX } from "../../client/src/components/Sidebar/identityChip";

hermetic(test);

/** Everything this file produces goes in one place, evidence included. */
const SHOTS = "test-results/identity-chips";
/** The two delivery shots the card asks for, by name, in their own folder. */
const REDESIGN_SHOTS = "test-results/sidebar-redesign";
/** `__dirname` and not `import.meta.url`: Playwright transpiles specs to CJS. */
const AXE_PATH = resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
const BAND = '[data-testid="identity-block"]';

/**
 * The three widths the column can actually be at. Not round numbers picked for
 * a test: 180 and 400 are the two ends the resize drag clamps to, 256 is what a
 * fresh installation starts on.
 */
const WIDTHS = [180, 256, 400] as const;

/** A member as the route sends it: raw milliseconds, not a boolean. */
function member(id: string, name: string, lastSeenAt: number | null) {
  return { id, name, email: `${id}@example.test`, role: "member", lastSeenAt };
}

interface Population {
  /** What `/api/auth/orgs` answers. */
  orgs: Array<{ id: string; name: string }>;
  /** What every organisation answers for its members. */
  members: ReturnType<typeof member>[];
  /** The address book: this is where the client learns who YOU are. */
  people: Array<{ id: string; displayName: string; isMe: boolean }>;
  /** Your FRIENDS, which is what the chips draw: the friendship graph, not
   *  the organisation address book. `lastSeenAt` is what puts a person on the
   *  row, and takes them off it. */
  friends: Array<{ id: string; displayName: string; lastSeenAt: number | null }>;
}

/**
 * The minimum identity data needed for the band to be drawn at all.
 *
 * Shared in shape with `org-presence.spec.ts`, and the shapes are the REAL ones
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
  const person = (p: { id: string; displayName: string; isMe: boolean }) => ({
    email: null,
    githubLogin: null,
    github: null,
    stats: { prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null },
    counts: { followers: 0, following: 0 },
    viewerFollows: false,
    followsViewer: false,
    lastSeenAt: null,
    ...p,
  });
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ people: population.people.map(person) }) }));
  await page.route("**/api/people/*/follow*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ people: [] }) }));
  // A chip is a door to ONE person, and that person's page asks for them by
  // id. Unrouted it would reach the real server, which knows none of these
  // ids, and the pane would open on an error screen while the test believed
  // it was looking at a person.
  await page.route(/\/api\/people\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    const p = population.people.find((x) => x.id === id);
    return p
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(person(p)) })
      : r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  // The friendship graph: three lists from one read, the shape `friendsApi`
  // expects. Unrouted it would reach the real server, which knows none of
  // these ids, and the row would be measured empty while the test believed it
  // was measuring three people.
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
  // THE WORST CASE FOR THE MENU HEADER, not a quiet machine. Three signals is
  // the cap `workSignals` enforces; they ride on the menu's title now, not on
  // the card, and the card has to stay the same width either way.
  await page.route("**/api/system/presence", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ openSessions: 12, workingSessions: 3, activeTasks: 2, focusProject: null }) }));
}

/**
 * THE MACHINE'S NUMBERS, so the card has something to say. The shell command
 * the dot samples is `perf_metrics`, and without a shell (plain Chromium) the
 * card would show no memory and no CPU: a green on an empty span would prove
 * the layout of nothing.
 */
async function withMachineNumbers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (cmd: string) => {
        if (cmd !== "perf_metrics") throw new Error(`unmocked command: ${cmd}`);
        return {
          version: "e2e", total_mb: 1989, resident_mb: 594,
          renderer_mb: 1400, gpu_mb: 130, other_mb: 459,
          cpu_percent: 8, cpu_renderer: 4, cpu_gpu: 1,
          cpu_sampled: 3, cpu_pids: 3, process_count: 8, partial: false,
        };
      },
    };
  });
}

/** The address book every population shares. The display names are
 *  placeholders on purpose and stay ones: the repository is public, and a
 *  plausible first-name-plus-surname in a tracked file is what
 *  `tests/unit/no-personal-data-tracked.test.ts` exists to refuse. */
const PEOPLE = [
  { id: "io", displayName: "Utente Locale", isMe: true },
  { id: "a", displayName: "Anna Prova", isMe: false },
  { id: "b", displayName: "Bruno Prova", isMe: false },
  { id: "c", displayName: "Carla Prova", isMe: false },
];

/** Two friends here now and one who is not: the ordinary morning. */
function populated(orgCount = 1): Population {
  const now = Date.now();
  return {
    orgs: Array.from({ length: orgCount }, (_, i) => ({ id: `org${i + 1}`, name: `Gruppo ${i + 1}` })),
    members: [
      member("io", "Io", now),               // you do not count yourself
      member("a", "Anna", now - 30_000),
      member("b", "Bruno", now - 60_000),
      member("c", "Carla", now - 3_600_000), // an hour ago: past the threshold
    ],
    people: PEOPLE,
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 30_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: now - 60_000 },
      { id: "c", displayName: "Carla Prova", lastSeenAt: now - 3_600_000 },
    ],
  };
}

/** Three friends here at once: more chips than a 180px row can show. */
function crowd(): Population {
  const now = Date.now();
  return {
    ...populated(),
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 30_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: now - 60_000 },
      { id: "c", displayName: "Carla Prova", lastSeenAt: now - 90_000 },
    ],
  };
}

/** Friends, none of whom is here: the row must not be drawn, the menu must
 *  still list them. */
function friendsAway(): Population {
  const now = Date.now();
  return {
    ...populated(),
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 3_600_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: null },
    ],
  };
}

/** In no group and knowing nobody: the card alone. */
function alone(): Population {
  return {
    orgs: [],
    members: [],
    people: [PEOPLE[0]!],
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
  await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
  const box = await column.boundingBox();
  return Math.round(box?.width ?? 0);
}

interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }

interface BandGeometry {
  /** The band's own overflow budget. Equal means nothing is cropped sideways. */
  band: Box & { scrollWidth: number; clientWidth: number; innerWidth: number };
  /** The card: its box, and whether its CONTENT fits in it. */
  card: Box & { scrollWidth: number; clientWidth: number };
  /** The chip row, or `null` when nobody is here and the row is not drawn. */
  row: (Box & { scrollWidth: number; clientWidth: number; flexWrap: string }) | null;
  /**
   * Every button in the band, chips and card alike.
   *
   * `spill` is how far a button's own CONTENT is painted past its right edge.
   * It is a measurement of ink, not of boxes, and it is the one the pixels
   * agree with: a box can be innocent while the glyph, the name and the
   * numbers inside it are laid out at full size over the neighbour.
   */
  buttons: Array<{ id: string; label: string } & Box & { spill: number }>;
}

/** The band's geometry, read in one round trip so no two boxes are measured a
 *  frame apart from each other. */
async function bandGeometry(page: Page): Promise<BandGeometry> {
  return page.evaluate(() => {
    const band = document.querySelector<HTMLElement>('[data-testid="identity-block"]');
    if (!band) throw new Error("no identity band on screen");
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        left: Math.round(r.left), right: Math.round(r.right),
        width: Math.round(r.width), height: Math.round(r.height),
      };
    };
    const card = band.querySelector<HTMLElement>('[data-testid="identity-me-profile"]');
    if (!card) throw new Error("no user card in the band");
    const row = band.querySelector<HTMLElement>('[data-testid="friend-chips"]');
    const bandStyle = getComputedStyle(band);
    return {
      band: {
        ...box(band),
        scrollWidth: band.scrollWidth,
        clientWidth: band.clientWidth,
        innerWidth: band.clientWidth - parseFloat(bandStyle.paddingLeft) - parseFloat(bandStyle.paddingRight),
      },
      card: { ...box(card), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth },
      row: row
        ? { ...box(row), scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, flexWrap: getComputedStyle(row).flexWrap }
        : null,
      buttons: Array.from(band.querySelectorAll<HTMLElement>("button")).map((b) => {
        const r = b.getBoundingClientRect();
        let far = r.right;
        for (const child of Array.from(b.querySelectorAll<HTMLElement>("*"))) {
          const c = child.getBoundingClientRect();
          if (c.width <= 0) continue;
          // A CLIPPED CHILD DOES NOT PAINT. This measures ink, not layout: a
          // clipped box still reports its full geometric rect, so the raw
          // `right` would read a spill that nothing ever draws. Clamping to
          // every clipping ancestor up to the button is what makes the number
          // mean what the assertion says it means.
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
          label: b.getAttribute("aria-label") ?? "",
          ...box(b),
          spill: Math.round(far - r.right),
        };
      }),
    };
  });
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

/** Open the one door of the chrome and hand back the menu. */
async function openMenu(page: Page) {
  await page.getByTestId("identity-me-profile").click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}

test.describe("the foot of the column", () => {
  test("CHIPS-01: the card fits and the chips scroll, at 180, 256 and 400", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    // TWO POPULATIONS, because the failure modes are opposite: two chips is
    // the ordinary morning and fits at every width, three is the one that
    // does not fit at 180 and has to SCROLL rather than wrap. The machine's
    // numbers are on for both, because the card with memory, CPU and a dot is
    // the widest the card ever gets, and that is the pressure the 180px column
    // has to survive.
    await withMachineNumbers(page);
    const cases = [
      { name: "two-here", population: populated(), chips: 2 },
      { name: "three-here", population: crowd(), chips: 3 },
    ];
    const measures: Array<{ case: string; asked: number; column: number; chips: number } & BandGeometry> = [];

    await stubIdentity(page, cases[0]!.population);
    await page.goto("/");
    for (const c of cases) {
      await stubIdentity(page, c.population);
      for (const width of WIDTHS) {
        const column = await setSidebarWidth(page, width);
        await expect(page.getByTestId("friend-chip")).toHaveCount(c.chips, { timeout: 20000 });
        await expect(page.getByTestId("identity-me-profile").getByTestId("metrics-total")).toContainText("%", { timeout: 20000 });
        measures.push({ case: c.name, asked: width, column, chips: c.chips, ...(await bandGeometry(page)) });
        await shootColumn(page, c.name === "two-here" ? `after-${width}.png` : `after-${width}-three-here.png`);
      }
    }
    persist("band-geometry", measures);

    for (const m of measures) {
      const where = `${m.case} at ${m.asked}px`;
      // THE COLUMN REALLY IS THAT WIDE. Without this the assertions below would
      // pass three times over the same 256px band and prove nothing.
      expect(m.column, `${where}: sidebar measured ${m.column}px`).toBe(m.asked);

      // THE BAND HOLDS NOTHING IT DOES NOT SHOW. The only box allowed to
      // scroll is the chip row, and its overflow is its own: the band's
      // budget has to balance regardless.
      expect(m.band.scrollWidth, `${where}: band overflows, ${m.band.scrollWidth} > ${m.band.clientWidth}`)
        .toBeLessThanOrEqual(m.band.clientWidth + 1);

      // THE CARD IS AS WIDE AS THE COLUMN, AND NO WIDER. A card narrower than
      // the column is a chip again; a card wider than it is cropped.
      expect(Math.abs(m.card.width - m.band.innerWidth), `${where}: card is ${m.card.width}px in a ${m.band.innerWidth}px band`)
        .toBeLessThanOrEqual(1);
      // AND ITS CONTENT FITS IN IT: the name truncates, the numbers stay.
      expect(m.card.scrollWidth, `${where}: card content ${m.card.scrollWidth} > box ${m.card.clientWidth}`)
        .toBeLessThanOrEqual(m.card.clientWidth + 1);

      // THE ROW IS THERE (somebody is here), ON ONE LINE, AND IT SCROLLS.
      expect(m.row, `${where}: no chip row with ${m.chips} friends here`).not.toBeNull();
      const row = m.row!;
      expect(row.flexWrap, `${where}: the chip row wraps`).toBe("nowrap");
      // Above the card, not beside it and not under it.
      expect(row.bottom, `${where}: row ends at ${row.bottom}, card starts at ${m.card.top}`)
        .toBeLessThanOrEqual(m.card.top);
      const chips = m.buttons.filter((b) => b.id === "friend-chip");
      expect(chips, `${where}: ${chips.length} chips on the row`).toHaveLength(m.chips);
      const tops = chips.map((c) => c.top);
      expect(Math.max(...tops) - Math.min(...tops), `${where}: chip tops disagree (${tops.join(", ")})`)
        .toBeLessThanOrEqual(1);
      // SIDE BY SIDE, not stacked: each one starts where the previous ended.
      const spread = [...chips].sort((a, b) => a.left - b.left);
      for (let i = 1; i < spread.length; i++) {
        const before = spread[i - 1]!;
        const after = spread[i]!;
        expect(
          after.left,
          `${where}: ${before.label} (${before.left}..${before.right}) overlaps ${after.label} (${after.left}..${after.right})`,
        ).toBeGreaterThanOrEqual(before.right);
      }
      // AND WHEN THEY DO NOT FIT, THE ROW SCROLLS. This is the case that
      // separates "scrolls" from "happened to fit": three chips at 180 are
      // wider than the row, and the row has to say so in its own budget.
      const chipsWidth = spread[spread.length - 1]!.right - spread[0]!.left;
      if (chipsWidth > row.clientWidth) {
        expect(row.scrollWidth, `${where}: ${chipsWidth}px of chips in a ${row.clientWidth}px row that does not scroll`)
          .toBeGreaterThan(row.clientWidth);
      }

      // AND NO BUTTON PAINTS OUTSIDE ITSELF: a chip pressed to its floor still
      // clips its name, the card still clips its name, and neither draws over
      // the neighbour.
      for (const b of m.buttons) {
        expect(b.spill, `${where}: ${b.id} "${b.label}" paints ${b.spill}px past its own right edge`)
          .toBeLessThanOrEqual(1);
      }
    }
    // THE SCROLL ACTUALLY HAPPENED SOMEWHERE. If every case fitted, the "when
    // they do not fit" branch above never ran and the claim is untested.
    const scrolled = measures.filter((m) => m.row && m.row.scrollWidth > m.row.clientWidth + 1);
    expect(scrolled.map((m) => `${m.case}@${m.asked}`), "no width ever made the chip row scroll").not.toHaveLength(0);
  });

  test("CHIPS-02: every chip and the card are at least CHIP_TARGET_PX on both sides", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    // Measured at 180: the narrowest column is where a button would be
    // squeezed under its floor.
    const cases = [
      { name: "populated", population: crowd(), expected: ["friend-chip", "friend-chip", "friend-chip", "identity-me-profile"] },
      { name: "alone", population: alone(), expected: ["identity-me-profile"] },
    ];
    const targets: Array<{ case: string; id: string; width: number; height: number }> = [];

    await stubIdentity(page, cases[0]!.population);
    await page.goto("/");
    for (const c of cases) {
      await stubIdentity(page, c.population);
      await setSidebarWidth(page, 180);
      await expect(page.getByTestId("friend-chip")).toHaveCount(c.expected.length - 1, { timeout: 20000 });
      const seen = (await bandGeometry(page)).buttons;
      // The whole set, not "some buttons": a band that lost a chip would
      // otherwise report a green measurement of what is left.
      expect(seen.map((s) => s.id).sort(), `${c.name}: buttons on screen`)
        .toEqual([...c.expected].sort());
      for (const s of seen) targets.push({ case: c.name, id: s.id, width: s.width, height: s.height });
    }
    persist("targets", { floor: CHIP_TARGET_PX, targets });

    for (const t of targets) {
      expect(t.height, `${t.case}/${t.id} is ${t.height}px tall`).toBeGreaterThanOrEqual(CHIP_TARGET_PX);
      expect(t.width, `${t.case}/${t.id} is ${t.width}px wide`).toBeGreaterThanOrEqual(CHIP_TARGET_PX);
    }
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`CHIPS-03 (${scheme}): the ink reads over the chip's real background`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
      await page.emulateMedia({ colorScheme: scheme });
      // NO SHELL MOCK HERE, on purpose. Faking the Tauri bridge on a Mac host
      // adds `native-frost` to the document, which makes the chrome
      // translucent: the real ground is then the desktop behind the window,
      // and a DOM walk composites it over white and measures a grey that
      // nobody sees. The web ground is opaque and is what this gate reads;
      // the card still shows memory and CPU there, from the server's own
      // figures, so the numbers' ink is in the measurement all the same.
      await stubIdentity(page, populated(4));
      await page.goto("/");
      await setSidebarWidth(page, 256);
      // The theme really switched: Topics follows the system by default and
      // paints through the `.dark` class, so this reads the same signal the app
      // does instead of trusting the emulation.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");
      await expect(page.getByTestId("friend-chip")).toHaveCount(2, { timeout: 20000 });
      await expect(page.getByTestId("identity-me-profile").getByTestId("metrics-total")).toContainText(/MB|GB/, { timeout: 20000 });

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
      // Then the card alone: the same ink with no chips above it, which is
      // the state most installations spend the day in.
      await stubIdentity(page, alone());
      await page.reload();
      await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId("friend-chips")).toHaveCount(0);
      await read("alone");

      const violations = await runAxe(page);
      persist(`contrast-${scheme}`, { floor: AA_TESTO, readings, axe: violations });

      // EVERY SUBJECT WAS MEASURED, named rather than counted: a band that
      // painted no chip name, or no card name, would otherwise pass on
      // whatever text was left. A reading is labelled by the NEAREST testid
      // of the text it measured, so the card's name reads as `identity-name`
      // and its numbers as `metrics-total`, not as the card itself.
      const measured = (state: string, id: string) =>
        readings.some((r) => r.state === state && r.label.startsWith(id));
      expect(measured("populated", "friend-chip"), "no chip ink was measured").toBe(true);
      expect(measured("populated", "identity-name"), "no card name was measured with chips above it").toBe(true);
      expect(measured("populated", "metrics-total"), "the machine's numbers were not measured").toBe(true);
      expect(measured("alone", "identity-name"), "no card name was measured alone").toBe(true);
      expect(measured("alone", "metrics-total"), "the machine's numbers were not measured alone").toBe(true);
      for (const r of readings) {
        expect(
          r.ratio,
          `${scheme}/${r.state} ${r.label}: ${r.ratio}:1 (${r.color} on ${r.bg})`,
        ).toBeGreaterThanOrEqual(AA_TESTO);
      }
      expect(violations.map((v) => `${v.id}: ${v.help}`), `axe on the identity band (${scheme})`).toEqual([]);
    });
  }

  test("CHIPS-04: with nobody here there is no row, and the menu still lists the friends", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    // The opposite of the rule the three old chips followed (they stayed at
    // zero so their place could be learned): this row is not the only way in,
    // so a permanent strip saying "nobody" would be reserving daily space for
    // the emptiest sentence in the app. The same people are one click away.
    await stubIdentity(page, friendsAway());
    await page.goto("/");
    await setSidebarWidth(page, 256);
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("friend-chips")).toHaveCount(0);
    await expect(page.getByTestId("friend-chip")).toHaveCount(0);
    await shootColumn(page, "nobody-here.png");

    // The card is still the door, and the friends are behind it: both of
    // them, present or not, which is what "the menu lists them" means.
    const menu = await openMenu(page);
    await menu.getByTestId("profile-menu-friends").click();
    await expect(menu.getByTestId("presence-person")).toHaveCount(2);
    await expect(menu.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(0);
    await expect(menu).toContainText("Anna Prova");
    await expect(menu).toContainText("Bruno Prova");
  });

  test("CHIPS-05: three friends here are three chips, and a chip is a door to that person", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    await stubIdentity(page, crowd());
    await page.goto("/");
    await setSidebarWidth(page, 180);
    const chips = page.getByTestId("friend-chip");
    await expect(chips).toHaveCount(3, { timeout: 20000 });
    // ONE PER PERSON, with the first name on the chip and the whole name on
    // the accessible name: short by design, and shortening must not make a
    // person unnameable. The name is the LAST span of the chip: the first is
    // the face, which spells the initials when there is no picture.
    const nameOf = (i: number) => chips.nth(i).locator("span").last();
    await expect(nameOf(0)).toHaveText("Anna");
    await expect(chips.nth(0)).toHaveAttribute("aria-label", "Anna Prova");
    await expect(nameOf(1)).toHaveText("Bruno");
    await expect(nameOf(2)).toHaveText("Carla");
    // AND THE ROW SCROLLS, at 180 with three names: this is the shape the
    // requirement names, read from the row's own budget.
    const row = (await bandGeometry(page)).row!;
    expect(row.flexWrap).toBe("nowrap");
    expect(row.scrollWidth, `three chips in a ${row.clientWidth}px row: scrollWidth ${row.scrollWidth}`)
      .toBeGreaterThan(row.clientWidth);
    await shootColumn(page, "three-here-180.png");

    // A chip leads to THAT person: a count could only lead to a list.
    await chips.nth(0).click();
    const pane = page.getByTestId("profile-pane");
    await expect(pane).toBeVisible({ timeout: 20000 });
    await expect(pane).toContainText("Anna Prova", { timeout: 20000 });
  });

  test("CHIPS-06: the card says the first name, and keeps the whole one within reach", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    // The surname is the half a 240px column truncates anyway: it stays on
    // the tooltip, on the accessible name and in the account block, so
    // nothing is lost, it is just not shouted.
    await stubIdentity(page, populated());
    await page.goto("/");
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card.getByTestId("identity-name")).toHaveText("Utente", { timeout: 20000 });
    await expect(card).toHaveAttribute("aria-label", "Utente Locale");
    await expect.poll(() => card.getAttribute("title")).toContain("Utente Locale");
  });

  test("CHIPS-07: memory and CPU are on the card, without opening anything", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    await withMachineNumbers(page);
    await stubIdentity(page, populated());
    await page.goto("/");
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 20000 });
    const numbers = card.getByTestId("metrics-total");
    // Megabytes (or gigabytes past a thousand) and a percentage, on the card,
    // with the menu closed: "is it fine" is the question that gets asked all
    // day, and it must not cost a gesture.
    await expect(numbers).toContainText(/\d+(\.\d+)?\s?(MB|GB)/, { timeout: 20000 });
    await expect(numbers).toContainText(/\d+%/);
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
    // And the dot, whose tint is the verdict, is on the same card.
    await expect(card.getByTestId("connection-status")).toBeVisible();
  });

  test("CHIPS-08: the delivery clip, the band at the three widths", async () => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
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
      // Reaching a paired app with three friends here is setup: it runs on a
      // page whose video is thrown away.
      prologo: async (p) => {
        await stubIdentity(p, crowd());
        await p.goto("/");
        await expect(p.getByTestId("friend-chip")).toHaveCount(3, { timeout: 20000 });
      },
      scena: async (p) => {
        await stubIdentity(p, crowd());
        await p.goto("/");
        await expect(p.getByTestId("identity-block")).toBeVisible({ timeout: 20000 });
        for (const width of WIDTHS) {
          await setSidebarWidth(p, width);
          await beat(p, 1300);
        }
        await p.getByTestId("identity-me-profile").click();
        await expect(p.getByTestId("profile-menu")).toBeVisible();
        await beat(p, 2200);
      },
    });
  });
});

/**
 * THE TWO DELIVERY SHOTS, at the sizes the card asks for: a desktop at
 * 1440x900 with the chips and the card (and once more with the menu open),
 * and a phone at 390x844. They are evidence, not measurements: the numbers
 * are read above, these are what a reviewer looks at.
 */
test.describe("delivery shots", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test("desktop-1440: chips and card, then the menu open", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
      // No shell mock: on a Mac host it would frost the chrome (see CHIPS-03)
      // and the shot would show a glass nobody asked for. The server's own
      // figures put memory and CPU on the card anyway.
      await stubIdentity(page, crowd());
      await page.goto("/");
      await expect(page.getByTestId("friend-chip")).toHaveCount(3, { timeout: 20000 });
      await expect(page.getByTestId("identity-me-profile").getByTestId("metrics-total")).toContainText(/MB|GB/, { timeout: 20000 });
      mkdirSync(REDESIGN_SHOTS, { recursive: true });
      await page.screenshot({ path: join(REDESIGN_SHOTS, "desktop-1440.png") });
      await openMenu(page);
      await page.screenshot({ path: join(REDESIGN_SHOTS, "desktop-1440-menu-open.png") });
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("mobile-390: the column is a drawer, the title is the door", async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "SIDEBAR-STATUS-01" });
      await stubIdentity(page, crowd());
      await page.goto("/");
      const column = page.locator('[aria-label="Topics sidebar"]');
      await column.waitFor({ state: "attached", timeout: 20_000 });
      // The drawer opens with the shortcut when it is not already open: the
      // button that opens it sits inside the closed column, off screen.
      const open = async () => Math.round((await column.boundingBox())?.x ?? -999) === 0;
      if (!(await open())) await page.keyboard.press("ControlOrMeta+b");
      await expect.poll(open, { timeout: 5_000 }).toBe(true);
      // No identity band on the phone: the door is the title.
      await expect(page.getByTestId("identity-me-profile")).toHaveCount(0);
      await expect(page.getByTestId("sidebar-topics-menu")).toBeVisible({ timeout: 10_000 });
      mkdirSync(REDESIGN_SHOTS, { recursive: true });
      await page.screenshot({ path: join(REDESIGN_SHOTS, "mobile-390.png") });
    });
  });
});
