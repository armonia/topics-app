/**
 * USABILITY AUDIT: every main surface, two viewports, two themes, MEASURED.
 *
 * Asked on 04/10: review the readability and usability of everything, the X
 * of the update notice for one, which looked too small. A
 * feeling about one glyph is a sample of one; this spec turns it into the same
 * three numbers on every surface a person touches every day:
 *
 *   target   the area that RECEIVES the click (`elementFromPoint` band through
 *            the centre, so `.tap-expand` pseudo-elements count and covered
 *            targets do not) >= 24x24 CSS px at desktop 1440x900 (WCAG 2.2 AA
 *            2.5.8) and >= 44x44 at a phone 390x844 with touch;
 *   text     every visible text node >= 11px (`--text-mini`, the project floor);
 *   contrast axe-core `color-contrast` (plus `target-size`, `button-name`,
 *            `link-name`) in the light AND the dark theme; the nodes axe
 *            leaves `incomplete` are computed by the helper and judged too;
 *   steals   a projected area (`.tap-expand`) must not answer where another
 *            clickable element answers without it.
 *
 * Commands that show under the pointer only are measured with the pointer on
 * their row or tab (desktop), and at rest whenever they keep `pointer-events`.
 *
 * Surfaces: the sidebar with the two update banners (bundle rebuilt, and the
 * shell updater in `update-available` and `error`), the user menu with its
 * system and settings levels, the chat with tool runs closed and open and an
 * answered question, the composer and the model selector, the changed-files
 * strip of a card's topic opened on its diff (the link to the card, the diff's
 * file header), the board (columns,
 * cards, card menu, settings popover, task drawer), the browser pane with its
 * tab strip, the add-pane menu and the topic row's context menu.
 *
 * A surface the spec cannot reach is a finding too: it lands in `notReached`
 * with the reason, and the test is red for it. The verdict is the list of
 * findings minus `EXCEPTIONS`, one line each with its reason. Raw numbers go to
 * `test-results/usability-audit/` (or `USABILITY_AUDIT_OUT`), merged into
 * `audit.json` at the end.
 *
 * First run (04/10, before the fixes): 258 findings, 134 targets under size,
 * 63 contrast, 49 texts under 11px, 9 axe target-size, 3 covered targets. The
 * fixes went to the shared roots (the type scale, three grey tokens, the
 * `.tap-expand` utility, `Switch`, `Segmented`, `Stepper`, the composer and
 * strip constants), and this spec is the guard that keeps them: green on the
 * branch, red on the commit before it.
 *
 * Review of that branch (04/10): the guard was green while two projected
 * areas stole taps on the phone (the task drawer's project chip over the
 * title, «open a tab» over the workspace button), one chip read 4.15:1 inside
 * a node axe had left `incomplete`, and the browser tab's Reload and dots were
 * 16x16 and never measured because they only show on hover. The steal probe,
 * the incomplete verdict and the hovered passes are the three holes closed.
 *
 * Runs in the `webkit` project: WebKit is the engine Topics ships.
 *
 * @covers UI-READ-01 CONTRAST-01 A11Y-01 GATE-14
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { hermetic } from "./fixtures/hermetic";
import { ensureTopicVisible, goToApp, openTopic } from "./helpers";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { setTheme } from "./helpers/chrome-contrast";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { fakeTauriShell } from "./helpers/fake-tauri-shell";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectIdForPath } from "../../shared/board";
import { auditSurface, componentFilesFor, type SurfaceAudit } from "./helpers/usability-audit";

hermetic(test);

const OUT_DIR = process.env.USABILITY_AUDIT_OUT ?? resolve(__dirname, "../../test-results/usability-audit");

const DESKTOP = { name: "desktop-1440x900", kind: "desktop", width: 1440, height: 900, minTap: 24 } as const;
const PHONE = { name: "phone-390x844", kind: "phone", width: 390, height: 844, minTap: 44 } as const;
type Viewport = typeof DESKTOP | typeof PHONE;

/**
 * The only way out of a finding: one line, with the reason. A target-size
 * exception also carries a FLOOR, the size it was accepted at: a target that
 * shrinks under it is red again, so an exception cannot hide a regression.
 */
interface Exception {
  kind: string;
  selector: RegExp;
  viewport?: "desktop" | "phone";
  floor?: { w: number; h: number };
  why: string;
}
const EXCEPTIONS: Exception[] = [
  { kind: "text-size", selector: /identity-glyph/, why: "a monogram inside the fixed 14px avatar (IDENTITY_GLYPH_BOX): a picture of a name that is written out in the title, `text-nano` reserved by check:typography" },
  { kind: "target-size", selector: /group\/proj\.row-card\.flex > but/, floor: { w: 12, h: 34 }, why: "the accordion chevron of a project row, 12px column shared by every sidebar row (ROW_CHEVRON_SLOT); WCAG 2.5.8 «equivalent»: the project name beside it toggles the same accordion on a second click" },
  // `[^>]*`: with more than one project in the sidebar axe names the row by its classes too (`.group\/proj.mx-1\.5...`).
  { kind: "axe:target-size", selector: /group\\\/proj[^>]* > \.w-3/, why: "same chevron as above, seen by axe on its box" },
  { kind: "axe:target-size", selector: /testid=task-id-chip$/, why: "the task id chip (atoms.tsx): axe reads the 18px BOX, the area that answers is the 24x24 `.tap-expand` projection, which the hit probe above measures and holds to the threshold" },
  { kind: "target-size", selector: /topic-row-archive|span\.row-actions/, viewport: "phone", floor: { w: 36, h: 44 }, why: "the command rail at the end of a row: two 36px commands side by side, a 44px area each would overlap and the last in the DOM would take the other's taps (index.css, `.tap-expand-y`)" },
  { kind: "target-size", selector: /topic-row-archive/, viewport: "desktop", floor: { w: 22, h: 28 }, why: "the sidebar resize handle (App.tsx, `left: sidebarWidth - 8`) covers the last 6px of the row's archive: its band sits INSIDE the sidebar because a native WKWebView pane flush on the content side eats every pixel past the edge, so moving it out would leave nothing to grab next to a browser pane (pre-existing on main, seen once rows were measured hovered)" },
  { kind: "target-size", selector: /mobile-pane-find|sidebar-reopen/, viewport: "phone", floor: { w: 36, h: 36 }, why: "the pane's chrome row is 40 tall (CHROME-METRIC-01): a 44 box does not fit in it, and its overflow clips the projected area" },
  { kind: "target-size", selector: /filter-token-input/, viewport: "phone", floor: { w: 44, h: 24 }, why: "an <input> cannot carry the ::after that projects 44; it fills its 24px shell (TOOLBAR_CONTROL_H) on the board's one toolbar row" },
  { kind: "target-size", selector: /board-layout-toggle|filter-project-chip/, viewport: "phone", floor: { w: 36, h: 36 }, why: "the board toolbar is ONE row of 24px controls, 36 tall (TOOLBAR_CONTROL_H, board-topbar-height.spec.ts): the projected 44 is clipped by the row to its 36" },
];

interface Violation {
  surface: string;
  viewport: string;
  themes: string[];
  kind: string;
  selector: string;
  measured: string;
  component_file: string;
}

interface GroupReport {
  group: string;
  viewport: string;
  coarse: boolean | null;
  audits: Array<{ surface: string; theme: string; audit: SurfaceAudit }>;
  notReached: Array<{ surface: string; reason: string }>;
  violations: Violation[];
  /** The banner's close glyph, measured whatever the threshold. */
  bannerClose: Array<{ surface: string; box: { w: number; h: number }; hit: { w: number; h: number }; fontSize: number }>;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const STAMP = Date.now();
const CHAT_NAME = `usability-chat-${STAMP}`;
const PROJECT_PATH = canonicalTmpDir("e2e-usability-board");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const topicIds: string[] = [];
const taskIds: string[] = [];
let drawerTaskId = "";
// A card's topic in a git repository, whose strip draws the card's range.
const STRIP_PATH = canonicalTmpDir("e2e-usability-strip");
const STRIP_PROJECT_ID = projectIdForPath(STRIP_PATH);
const STRIP_FILE = "src/a.ts";
let stripTopicId = "";
let stripTaskId = "";

async function seedChat(request: APIRequestContext): Promise<void> {
  const topic = await createTopic(request, CHAT_NAME);
  topicIds.push(topic.id);
  const sessionKey = `topic:${topic.id.slice(0, 8)}`;
  await seedMessage(request, { sessionKey, role: "user", content: "Fix the module and tell me what changed." });
  // A tool run: one message per action, no prose (the importer's shape).
  const runs = [
    { name: "Read", args: { file_path: "/src/a.ts" } },
    { name: "Read", args: { file_path: "/src/b.ts" } },
    { name: "Edit", args: { file_path: "/src/a.ts" } },
    { name: "Bash", args: { command: "bun test" } },
  ];
  for (const [i, a] of runs.entries()) {
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "",
      toolCalls: [{ id: `ux-run-${i}`, name: a.name, args: a.args, status: "success", result: "ok" }],
    });
  }
  // A finished turn with an answered question inside (the 04/10 shape).
  const question = "Which database for the cache?";
  const questions = [{ question, header: "Database", multiSelect: false, options: [{ label: "SQLite" }, { label: "Redis" }] }];
  const now = Date.now();
  // allow-literal-tmp: a path inside a seeded tool call, never opened and never an identity.
  const read = { id: "ux-fold-read", name: "Read", args: { file_path: "/tmp/ux/config.ts" }, status: "success" as const, result: "export {}", startedAt: now - 9_000, endedAt: now - 8_500 };
  const ask = {
    id: "ux-fold-ask", name: "AskUserQuestion", args: { questions }, status: "success" as const, startedAt: now - 8_000, endedAt: now - 6_000,
    userInputSchema: { kind: "questions", questions },
    userResponse: { kind: "questions", answers: { [question]: "SQLite" }, submittedAt: new Date().toISOString() },
  };
  const bash = { id: "ux-fold-bash", name: "Bash", args: { command: "bun test cache" }, status: "success" as const, result: "ok", startedAt: now - 5_000, endedAt: now - 4_000 };
  const answer = "Done: the cache now runs on SQLite, and the tests pass. ".repeat(3);
  await seedMessage(request, { sessionKey, role: "user", content: "Set up the cache." });
  await seedMessage(request, {
    sessionKey, role: "assistant", content: answer,
    toolCalls: [read, ask, bash],
    blocks: [{ kind: "tool", toolCall: read }, { kind: "tool", toolCall: ask }, { kind: "tool", toolCall: bash }, { kind: "text", text: answer }],
  });
}

async function seedBoard(request: APIRequestContext): Promise<void> {
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-usability-board" }));
  const topic = await createTopic(request, `usability-board-${STAMP}`, { projectPath: PROJECT_PATH });
  topicIds.push(topic.id);
  // `todo` is left out on purpose: it is the column the dispatcher picks from.
  const plan: Array<{ text: string; status: string }> = [
    { text: "Write the onboarding copy for the empty board", status: "backlog" },
    { text: "Measure the tap targets of the sidebar on a phone", status: "backlog" },
    { text: "Review the contrast of the muted labels in both themes", status: "review" },
    { text: "Ship the update banner with a bigger close button", status: "done" },
  ];
  for (const p of plan) {
    const res = await request.post(`/api/boards/${PROJECT_ID}/tasks`, { data: { text: p.text, description: "Acceptance: measured, not eyeballed." } });
    expect(res.ok(), `create task: ${res.status()}`).toBe(true);
    const task = (await res.json()) as { id: string };
    taskIds.push(task.id);
    expect((await request.patch(`/api/boards/${PROJECT_ID}/tasks/${task.id}`, { data: { status: p.status } })).ok()).toBe(true);
    if (p.status === "review") {
      drawerTaskId = task.id;
      const bind = await request.post(`/api/test/tasks/${task.id}/bind-topic`, { data: { topicId: topic.id } });
      expect(bind.ok()).toBe(true);
      await request.post(`/api/test/tasks/${task.id}/anchored-comment`, { data: { content: "Contrast measured: two labels under 4.5:1.", author: "agent" } });
    }
  }
}

/**
 * The strip of a card's topic, as `chat-changed-files-task-range.spec.ts`
 * builds it: the card's work landed by merge with its id in the subject, its
 * branch pruned, a Write in the chat. The strip then carries the link to the
 * card and draws the card's range with the board's diff panel.
 */
async function seedStrip(request: APIRequestContext): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", ["-C", STRIP_PATH, "-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  mkdirSync(`${STRIP_PATH}/src`, { recursive: true });
  writeFileSync(`${STRIP_PATH}/package.json`, JSON.stringify({ name: "e2e-usability-strip" }));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const topic = await createTopic(request, `usability-strip-${STAMP}`, { projectPath: STRIP_PATH });
  stripTopicId = topic.id;
  topicIds.push(topic.id);
  const created = await request.post(`/api/boards/${STRIP_PROJECT_ID}/tasks`, { data: { text: "Measure the strip", status: "review" } });
  expect(created.ok(), `create task: ${created.status()}`).toBe(true);
  stripTaskId = ((await created.json()) as { id: string }).id;
  const branch = `topics/usability-strip-${STAMP}`;
  git("checkout", "-q", "-b", branch);
  writeFileSync(`${STRIP_PATH}/${STRIP_FILE}`, "export const a = 1;\nexport const b = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the delivery");
  git("checkout", "-q", "main");
  const delivered = git("rev-parse", branch);
  git("merge", "--no-ff", "-q", "-m", `merge task ${stripTaskId}: measure the strip`, branch);
  git("branch", "-q", "-D", branch);
  expect((await request.post(`/api/test/tasks/${stripTaskId}/bind-topic`, { data: { topicId: stripTopicId } })).ok()).toBe(true);
  expect((await request.post(`/api/test/tasks/${stripTaskId}/landing`, { data: { branch, commit: delivered } })).ok()).toBe(true);
  await seedMessage(request, {
    sessionKey: `topic:${stripTopicId.slice(0, 8)}`, role: "assistant", content: "Done.",
    toolCalls: [{ id: "ux-strip-write", name: "Write", args: { file_path: `${STRIP_PATH}/${STRIP_FILE}` }, status: "success" }],
  });
}

test.beforeAll(async ({ request }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  await seedChat(request);
  await seedBoard(request);
  await seedStrip(request);
});

test.afterAll(async ({ request }) => {
  for (const id of taskIds) await deleteTask(request, PROJECT_ID, id).catch(() => {});
  if (stripTaskId) await deleteTask(request, STRIP_PROJECT_ID, stripTaskId).catch(() => {});
  for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
  removeTmpDir(PROJECT_PATH);
  removeTmpDir(STRIP_PATH);
  // One file with every group, for whoever reads the numbers next.
  const groups = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith("group-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(resolve(OUT_DIR, f), "utf8")) as GroupReport);
  writeFileSync(resolve(OUT_DIR, "audit.json"), JSON.stringify({
    measuredAt: new Date().toISOString(),
    thresholds: { desktopMinTap: DESKTOP.minTap, phoneMinTap: PHONE.minTap, minFontPx: 11, axeRules: ["color-contrast", "target-size", "button-name", "link-name"] },
    exceptions: EXCEPTIONS.map((e) => ({ ...e, selector: String(e.selector) })),
    groups,
  }, null, 2));
});

// ── the recorder ────────────────────────────────────────────────────────────

/**
 * No colour in flight when axe samples it: transitions and entrances run to
 * their END at once. Pausing them instead (the first version) froze the menu
 * levels on their first keyframe, off screen, and measured nothing.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({ content: "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}" });
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

class Recorder {
  readonly report: GroupReport;
  constructor(private page: Page, group: string, private vp: Viewport) {
    this.report = { group, viewport: vp.name, coarse: null, audits: [], notReached: [], violations: [], bannerClose: [] };
  }

  /** Measure `scope` in both themes. `scope` must already be on screen. */
  async measure(surface: string, scope: string): Promise<void> {
    await expect(this.page.locator(scope).first(), `${surface}: scope ${scope} not visible`).toBeVisible({ timeout: 15_000 });
    for (const dark of [false, true]) {
      await this.page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      await setTheme(this.page, dark);
      await twoFrames(this.page);
      const audit = await auditSurface(this.page, scope, this.vp.minTap);
      // The picture next to the numbers: a reader checks WHAT was measured.
      const shots = resolve(OUT_DIR, "shots");
      mkdirSync(shots, { recursive: true });
      const slug = `${this.report.group}-${this.vp.name}-${surface}-${dark ? "dark" : "light"}`.replace(/[^a-z0-9-]+/gi, "_");
      await this.page.screenshot({ path: resolve(shots, `${slug}.png`) });
      this.report.coarse = audit.coarse;
      this.report.audits.push({ surface, theme: dark ? "dark" : "light", audit });
    }
  }

  /** Run a step; a failure to REACH the surface is recorded, not thrown. */
  async step(surface: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n").slice(0, 3).join(" | ").slice(0, 300);
      this.report.notReached.push({ surface, reason });
      // What the page looked like when the surface could not be reached.
      const slug = `notreached-${this.report.group}-${this.vp.name}-${surface}`.replace(/[^a-z0-9-]+/gi, "_");
      await this.page.screenshot({ path: resolve(OUT_DIR, "shots", `${slug}.png`) }).catch(() => {});
      await this.page.keyboard.press("Escape").catch(() => {});
    }
  }

  /** The banner's close glyph: its numbers, whatever the verdict. */
  async measureBannerClose(surface: string, bannerTestid: string): Promise<void> {
    const close = this.page.getByTestId(bannerTestid).getByRole("button", { name: "Ignora" });
    await expect(close).toBeVisible();
    const m = await close.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const mine = (x: number, y: number) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
      let l = cx, rt = cx, t = cy, b = cy;
      while (cx - l < 70 && mine(l - 1, cy)) l--;
      while (rt - cx < 70 && mine(rt + 1, cy)) rt++;
      while (cy - t < 70 && mine(cx, t - 1)) t--;
      while (b - cy < 70 && mine(cx, b + 1)) b++;
      return {
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        hit: mine(cx, cy) ? { w: rt - l + 1, h: b - t + 1 } : { w: 0, h: 0 },
        fontSize: parseFloat(getComputedStyle(el).fontSize),
      };
    });
    this.report.bannerClose.push({ surface, ...m });
    // The card itself, both themes: the before/after picture of the X.
    for (const dark of [false, true]) {
      await this.page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      await setTheme(this.page, dark);
      await twoFrames(this.page);
      const slug = `banner-${this.report.group}-${this.vp.name}-${surface}-${dark ? "dark" : "light"}`.replace(/[^a-z0-9-]+/gi, "_");
      await this.page.getByTestId(bannerTestid).screenshot({ path: resolve(OUT_DIR, "shots", `${slug}.png`) });
    }
  }

  /** Findings → violations, deduplicated across themes, exceptions applied. */
  finish(): Violation[] {
    const byKey = new Map<string, Violation>();
    const add = (surface: string, theme: string, kind: string, selector: string, measured: string, testid: string | null, hit?: { w: number; h: number }) => {
      const excused = EXCEPTIONS.some((e) => e.kind === kind && e.selector.test(`${selector} testid=${testid ?? ""}`)
        && (!e.viewport || e.viewport === this.vp.kind)
        && (!e.floor || (!!hit && hit.w >= e.floor.w && hit.h >= e.floor.h)));
      if (excused) return;
      const key = `${surface}|${kind}|${selector}|${measured}`;
      const prev = byKey.get(key);
      if (prev) { if (!prev.themes.includes(theme)) prev.themes.push(theme); return; }
      byKey.set(key, {
        surface, viewport: this.vp.name, themes: [theme], kind, selector, measured,
        component_file: ownerOf(selector, testid, surface) || `unmapped (testid ${testid ?? "none"})`,
      });
    };
    for (const { surface, theme, audit } of this.report.audits) {
      for (const t of audit.targets) {
        if (!t.ownsCentre) add(surface, theme, "target-covered", t.selector, `centre answered by ${t.coveredBy}; box ${t.box.w}x${t.box.h}`, t.testid);
        else {
          // The neighbour that takes the missing pixels, on the short axis.
          const e = t.edges;
          const by = !e ? "" : t.hit.w < audit.minTap && t.hit.h < audit.minTap ? `; past the band: ${e.left} | ${e.right} | ${e.top} | ${e.bottom}`
            : t.hit.w < audit.minTap ? `; past the band: ${e.left} | ${e.right}` : `; past the band: ${e.top} | ${e.bottom}`;
          add(surface, theme, "target-size", t.selector, `hit ${t.hit.w}x${t.hit.h} < ${audit.minTap} (box ${t.box.w}x${t.box.h}${t.spacingOk ? ", WCAG spacing ok" : ""}) "${t.label}"${by}`, t.testid, t.hit);
        }
      }
      for (const s of audit.steals) add(surface, theme, "target-steal", s.thief, `projected area takes ${s.px}px of ${s.victim} (testid ${s.victimTestid ?? "none"}), e.g. at ${s.sample}`, s.thiefTestid);
      for (const s of audit.smallText) add(surface, theme, "text-size", s.selector, `${s.fontSize}px < 11 "${s.sample}"`, s.testid);
      for (const v of audit.axe) for (const n of v.nodes) add(surface, theme, `axe:${v.id}`, n.target, n.summary, n.testid);
      // What axe left undecided is decided by the helper; a ground it cannot
      // composite either (an image) stays a finding until an exception rules on it.
      for (const c of audit.contrastDecided) {
        if (c.exempt) continue;
        if (c.ratio === null) add(surface, theme, "contrast-undecided", c.target, `node gone before it could be measured (axe: ${c.reason})`, c.testid);
        else if (c.undecided) add(surface, theme, "contrast-undecided", c.target, `${c.undecided}; ${c.ratio}:1 on the colours alone (axe: ${c.reason}) "${c.text}"`, c.testid);
        else if (c.ratio < c.needed!) add(surface, theme, "contrast", c.target, `${c.ratio}:1 < ${c.needed}:1 (axe incomplete: ${c.reason}) "${c.text}"`, c.testid);
      }
      const ox = (audit.uiAudit as { overflowX?: { present: boolean; docWidth: number; viewport: number } } | null)?.overflowX;
      if (ox?.present) add(surface, theme, "overflow-x", audit.scope, `document ${ox.docWidth}px wide on a ${ox.viewport}px viewport`, null);
    }
    this.report.violations = [...byKey.values()];
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, `group-${this.report.group}-${this.vp.name}.json`), JSON.stringify(this.report, null, 2));
    return this.report.violations;
  }

  /** The verdict line: every finding and every unreached surface, named. */
  assertClean(): void {
    const violations = this.finish();
    const lines = [
      ...this.report.notReached.map((n) => `NOT REACHED ${n.surface}: ${n.reason}`),
      ...violations.map((v) => `${v.surface} [${v.themes.join("+")}] ${v.kind} ${v.selector} :: ${v.measured} -> ${v.component_file}`),
    ];
    expect(lines, `${this.report.group} @ ${this.vp.name}`).toEqual([]);
  }
}

/** Tags the ancestor that holds `inner` so it can be audited as one scope. */
async function markScope(page: Page, inner: string, name: string, ancestor = '[role="menu"],[role="dialog"],[role="listbox"],[data-popover],[data-radix-popper-content-wrapper]'): Promise<string> {
  const ok = await page.locator(inner).first().evaluate((el, { name, ancestor }) => {
    const host = el.closest(ancestor) ?? el.parentElement ?? el;
    host.setAttribute("data-usability-scope", name);
    return true;
  }, { name, ancestor });
  expect(ok).toBe(true);
  return `[data-usability-scope="${name}"]`;
}

/** The menu that just opened: the last visible `[role=menu]`. */
async function lastMenuScope(page: Page, name: string): Promise<string> {
  const menu = page.locator('[role="menu"]:visible').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await menu.evaluate((el, n) => el.setAttribute("data-usability-scope", n), name);
  return `[data-usability-scope="${name}"]`;
}

const isPhone = (vp: Viewport) => vp === PHONE;

/**
 * Testids handed to a SHARED component as a prop: a finding on a child with no
 * testid of its own is drawn by the shared component, not by the caller that
 * named it. Without this the banner's close button maps to DevBundleToast.tsx,
 * which only passes the testid.
 */
const SHARED_OWNER: Record<string, string> = {
  "bundle-stale-toast": "client/src/components/Shared/SidebarUpdateBanner.tsx",
  "updater-toast": "client/src/components/Shared/SidebarUpdateBanner.tsx",
};

/** Surfaces drawn in a portal with no testid on their rows: who draws them. */
const SURFACE_OWNER: Record<string, string> = {
  "composer add menu": "client/src/components/Chat/ChatInput.tsx",
};

function ownerOf(selector: string, testid: string | null, surface = ""): string {
  if (!testid && SURFACE_OWNER[surface]) return SURFACE_OWNER[surface]!;
  const files = componentFilesFor(testid).join(", ");
  const shared = testid ? SHARED_OWNER[testid] : undefined;
  // The element that CARRIES the testid is the caller's; anything under it is the shared component's.
  if (!shared || selector === `[data-testid="${testid}"]`) return files;
  return `${shared} (testid passed by ${files})`;
}

async function openApp(page: Page, vp: Viewport): Promise<void> {
  if (isPhone(vp)) {
    await page.goto("/");
    await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  } else {
    await goToApp(page);
  }
  await freezeMotion(page);
}

async function openChat(page: Page, vp: Viewport): Promise<void> {
  if (isPhone(vp)) {
    await page.getByText(CHAT_NAME).first().tap();
  } else {
    await openTopic(page, new RegExp(CHAT_NAME));
  }
  await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tool-group-row").first()).toBeVisible({ timeout: 15_000 });
}

// ── the groups, run at both viewports ────────────────────────────────────────

function groups(vp: Viewport) {
  test("sidebar and the bundle banner", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "sidebar", vp);
    await openApp(page, vp);
    await recorder.step("sidebar", () => recorder.measure("sidebar", '[aria-label="Topics sidebar"]'));
    if (isPhone(vp)) await recorder.step("mobile chrome bar", () => recorder.measure("mobile chrome bar", '[data-testid="mobile-chrome-bar"]'));
    // A row's command rail (archive, the dots) shows under the pointer only:
    // measured once more with the pointer on a row. No hover on a phone.
    // Two rows: the Board row (its hover ground took the «+N» chip under AA)
    // and a chat row, the one that carries the archive command.
    if (!isPhone(vp)) {
      for (const [surface, name] of [["sidebar (board row hovered)", /^Board/], ["sidebar (chat row hovered)", new RegExp(CHAT_NAME)]] as const) {
        await recorder.step(surface, async () => {
          const row = page.locator('[aria-label="Topics sidebar"]').getByRole("treeitem", { name }).first();
          await expect(row).toBeVisible({ timeout: 10_000 });
          await row.hover();
          await twoFrames(page);
          await recorder.measure(surface, '[aria-label="Topics sidebar"]');
          await page.mouse.move(0, 0);
        });
      }
    }
    await recorder.step("inbox popover", async () => {
      await page.getByTestId("inbox-button").first().click();
      const row = page.getByTestId("inbox-row").or(page.getByTestId("inbox-empty")).first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await recorder.measure("inbox popover", await markScope(page, '[data-testid="inbox-row"], [data-testid="inbox-empty"]', "inbox"));
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-usability-scope="inbox"]')).toHaveCount(0);
    });
    await recorder.step("banner: bundle rebuilt", async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:bundle-stale")));
      await recorder.measure("banner: bundle rebuilt", '[data-testid="bundle-stale-toast"]');
      await recorder.measureBannerClose("banner: bundle rebuilt", "bundle-stale-toast");
    });
    recorder.assertClean();
  });

  test("updater banner: update available and error (faked shell)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "updater-banner", vp);
    // The shell's updater, faked through the one door that sends its network
    // home (helpers/fake-tauri-shell.ts). `__updaterMode` picks the answer.
    await fakeTauriShell(page, () => (cmd: string) => {
      const w = window as unknown as { __updaterMode?: string; __updaterChecks?: number };
      if (cmd === "updater_check") {
        w.__updaterChecks = (w.__updaterChecks ?? 0) + 1;
        if (w.__updaterMode === "error") return Promise.reject(new Error("network unreachable: the release server did not answer"));
        if (w.__updaterMode === "available") return { version: "99.0.0" };
        return null;
      }
      if (cmd.startsWith("browser_take_") || cmd === "browser_download_progress") return [];
      return null;
    });
    await openApp(page, vp);
    // The faked shell turns on `native-frost`, where the sidebar is a veil over
    // the desktop wallpaper: in a browser there is no wallpaper, axe composited
    // the card over a ground that never ships (1.13 and 3.62 on #727373). The
    // card is measured on the opaque chrome instead, the ground it has on the
    // web and wherever the vibrancy is off.
    await page.evaluate(() => document.documentElement.classList.remove("native-frost"));
    // The silent boot check goes first (4s after mount): an explicit check
    // fired before it would be overwritten by its silent answer.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __updaterChecks?: number }).__updaterChecks ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
    const toast = page.getByTestId("updater-toast");
    await recorder.step("banner: update available", async () => {
      await page.evaluate(() => {
        (window as unknown as { __updaterMode?: string }).__updaterMode = "available";
        window.dispatchEvent(new CustomEvent("topics:check-for-updates"));
      });
      await expect(toast).toBeVisible({ timeout: 10_000 });
      await recorder.measure("banner: update available", '[data-testid="updater-toast"]');
      await recorder.measureBannerClose("banner: update available", "updater-toast");
    });
    await recorder.step("banner: update error", async () => {
      await page.evaluate(() => {
        (window as unknown as { __updaterMode?: string }).__updaterMode = "error";
        window.dispatchEvent(new CustomEvent("topics:check-for-updates"));
      });
      // The error tone is the card's own tint (`tone="error"` in SidebarUpdateBanner).
      await expect(toast).toHaveClass(/bg-red-500/, { timeout: 10_000 });
      await recorder.measure("banner: update error", '[data-testid="updater-toast"]');
      await recorder.measureBannerClose("banner: update error", "updater-toast");
    });
    recorder.assertClean();
  });

  test("user menu, system level and settings levels", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "user-menu", vp);
    await openApp(page, vp);
    await recorder.step("user menu", async () => {
      await openProfileMenu(page);
      await recorder.measure("user menu", await markScope(page, '[data-testid="sidebar-system-menu"]', "user-menu"));
    });
    for (const [surface, row] of [
      ["system menu (status level)", "menu-system-status"],
      ["settings: appearance", "topics-menu-appearance"],
      ["settings: notifications", "topics-menu-notifications"],
      ["settings: view", "topics-menu-view"],
      ["settings: devices", "profile-menu-devices"],
    ] as const) {
      await recorder.step(surface, async () => {
        await openProfileMenu(page);
        const trigger = page.getByTestId(row);
        await expect(trigger).toBeVisible({ timeout: 10_000 });
        await trigger.click();
        // The level's body is a lazy chunk: the panel frame shows first, empty.
        const panel = page.getByTestId(`${row}-menu`);
        await expect(panel.locator("button, input, select, [role=menuitem], [role=switch], [role=radio]").first()).toBeVisible({ timeout: 15_000 });
        await recorder.measure(surface, `[data-testid="${row}-menu"]`);
        // Back to the root of the menu for the next level.
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sidebar-system-menu")).toHaveCount(0, { timeout: 5_000 }).catch(() => {});
      });
    }
    recorder.assertClean();
  });

  test("chat: tool runs closed and open, answered question, composer, model selector", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "chat", vp);
    await openApp(page, vp);
    // The sidebar lists the chats that have a tab: the groups before this one
    // reset the pane store, so the seeded chat is put back in it first (the
    // phone run failed to find it once, depending on what ran before).
    await ensureTopicVisible(page, new RegExp(CHAT_NAME));
    await freezeMotion(page);
    await recorder.step("topic context menu", async () => {
      // From the list, before any chat is open: on the phone the list IS the
      // screen, and the menu comes from a long-press.
      const row = page.getByRole("treeitem", { name: new RegExp(CHAT_NAME) }).first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      // On the phone too the menu is opened by `contextmenu`, not by a finger:
      // `helpers/long-press.ts` builds `new Touch(...)`, and WebKit answers
      // «Illegal constructor». What is measured is the menu, not the gesture.
      await row.click({ button: "right" });
      await recorder.measure("topic context menu", await lastMenuScope(page, "topic-menu"));
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-usability-scope="topic-menu"]')).toHaveCount(0);
    });
    await recorder.step("chat (tools closed)", async () => {
      await openChat(page, vp);
      await expect(page.getByTestId("turn-work-fold").first()).toHaveAttribute("data-open", "false");
      await recorder.measure("chat (tools closed)", '[data-testid="chat-panel"]');
    });
    await recorder.step("chat (tools open)", async () => {
      await page.getByTestId("tool-group-summary").first().click();
      await expect(page.locator('[data-testid="tool-call-row-ux-run-0"]')).toBeVisible();
      const fold = page.getByTestId("turn-work-fold").first();
      await fold.locator("summary, button").first().click();
      await expect(fold).toHaveAttribute("data-open", "true");
      await recorder.measure("chat (tools open)", '[data-testid="chat-panel"]');
    });
    await recorder.step("model selector", async () => {
      await page.getByTestId("provider-model-picker").first().click();
      await recorder.measure("model selector", '[data-testid="model-selector-panel"]');
      await page.keyboard.press("Escape");
    });
    await recorder.step("composer add menu", async () => {
      await page.getByTestId("composer-add-menu").first().click();
      await recorder.measure("composer add menu", await lastMenuScope(page, "composer-menu"));
      await page.keyboard.press("Escape");
    });
    recorder.assertClean();
  });

  test("chat changes strip: a card's topic with its diff open", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CHGSET-03" });
    const recorder = new Recorder(page, "changes-strip", vp);
    // By permalink: a topic bound to a project has no top-level sidebar row.
    await resetPaneStore(page.request, [stripTopicId]);
    await recorder.step("changes strip (diff open)", async () => {
      await page.goto(`/tab/chat/${stripTopicId}`);
      await freezeMotion(page);
      const chip = page.getByTestId("chat-changes-chip");
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await chip.click();
      const file = page.getByTestId("chat-changes-diff").locator(`[data-testid="diff-file"][data-path="${STRIP_FILE}"]`);
      await expect(file).toBeVisible({ timeout: 15_000 });
      await file.getByRole("button", { name: /a\.ts/ }).click();
      await expect(file).toContainText("+export const b = 2;", { timeout: 15_000 });
      await expect(page.getByTestId("chat-changes-open-card")).toBeVisible();
      await recorder.measure("changes strip (diff open)", '[data-testid="chat-changes-strip"]');
    });
    recorder.assertClean();
  });

  test("board: columns, cards, card menu, settings, task drawer", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "board", vp);
    await resetPaneStore(page.request, []);
    await recorder.step("task drawer", async () => {
      await page.goto(`/task/${drawerTaskId}`);
      await freezeMotion(page);
      await recorder.measure("task drawer", '[data-testid="task-detail-drawer"]');
    });
    await recorder.step("board columns", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator("[data-task-card]").first()).toBeVisible({ timeout: 15_000 });
      await recorder.measure("board columns", '[data-testid="kanban-board"]');
    });
    await recorder.step("card context menu", async () => {
      const card = page.locator(`[data-task-card="${taskIds[0]}"]`);
      // `contextmenu` on both viewports: see the topic context menu above.
      await card.click({ button: "right" });
      await recorder.measure("card context menu", await lastMenuScope(page, "card-menu"));
      await page.keyboard.press("Escape");
    });
    await recorder.step("board settings popover", async () => {
      await page.getByTestId("kanban-board").getByTitle("Impostazioni auto-dispatch").click();
      await recorder.measure("board settings popover", '[data-testid="board-settings-menu"]');
      await page.keyboard.press("Escape");
    });
    recorder.assertClean();
  });

  test("browser pane, its tab strip, and the add-pane menu", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "UI-READ-01" }, { type: "spec", description: "CONTRAST-01" });
    const recorder = new Recorder(page, "browser", vp);
    // No real browser behind the pane: the server would launch one (Chromium,
    // banned on this Mac). The socket stays open and silent, the REST answers
    // "nothing there yet". The chrome of the pane is what is measured.
    await page.routeWebSocket(/\/ws\/browser\//, () => {});
    await page.route(/\/api\/browsers\//, (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 404, body: "Not found" }) : route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
    await resetPaneStore(page.request, []);
    await openApp(page, vp);
    await recorder.step("add-pane menu", async () => {
      await page.keyboard.press("Escape");
      await page.getByTestId("pane-add-menu-trigger").first().click();
      await expect(page.getByTestId("pane-add-menu-browser")).toBeVisible({ timeout: 5_000 });
      await recorder.measure("add-pane menu", await markScope(page, '[data-testid="pane-add-menu-browser"]', "add-pane-menu"));
    });
    await recorder.step("browser pane", async () => {
      await page.getByTestId("pane-add-menu-browser").click();
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });
      // The page layer, not `[role=main]`: the tab strip sits above main.
      await recorder.measure("browser pane (new tab)", ".content-flip-layer");
    });
    await recorder.step("browser pane (address typed)", async () => {
      const address = page.locator("[data-browser-pane]").first().getByRole("textbox").first();
      await address.fill("example.com");
      await address.press("Enter");
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible();
      await twoFrames(page);
      await recorder.measure("browser pane (address typed)", ".content-flip-layer");
    });
    // The tab's own commands (Reload on the favicon, the dots) exist under the
    // pointer only: at rest they are opacity 0, so the strip is measured once
    // more with the pointer on the tab, where a person actually meets them.
    // A phone has no hover: there the active tab shows them at rest.
    if (!isPhone(vp)) {
      await recorder.step("browser pane (tab hovered)", async () => {
        const tab = page.locator('[role="tab"][data-tab-extras]').first();
        await tab.hover();
        await expect(tab.locator(".tab-extras")).toHaveCSS("opacity", "1", { timeout: 5_000 });
        await recorder.measure("browser pane (tab hovered)", ".content-flip-layer");
      });
    }
    recorder.assertClean();
  });
}

test.describe("usability audit — desktop 1440x900", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  groups(DESKTOP);
});

test.describe("usability audit — phone 390x844, touch", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: PHONE.width, height: PHONE.height }, hasTouch: true, isMobile: true });
  groups(PHONE);
});
