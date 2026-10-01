import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage, type SeedMessageOpts } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { canonicalTmpRoot } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A FOLD OPENED BY HAND DOES NOT MOVE THE TRANSCRIPT.
 *
 * The owner's report (01/10): "when I open the accordions in a topic they make
 * an ugly layout shift". Every expand/collapse surface a person can click in a
 * topic's view is opened and closed here, in the two places a reader is when
 * they do it: at the very bottom of the chat (the follow-output case, where the
 * list used to re-pin to the new bottom and take the clicked row with it) and
 * in the middle of a long history (scrolled there with the wheel, as a person
 * does). For ~900 ms after each click, a sampler records in the last callback
 * before every paint:
 *   - the clicked header's top and left on screen;
 *   - the top of the message row right above it (for a strip docked over the
 *     composer: the last message row on screen);
 *   - the height of the fold (header plus body).
 *
 * THE INVARIANT, per frame: the header stays at the same Y (±1 px) and the
 * same X, nothing above it moves, and the fold changes height in ONE run (an
 * animation or an instant reveal), never a placeholder that pops to its real
 * size later. Each test writes its measurements next to its result, and logs
 * one line per case (`ACCORDION kind case phase ...`) so a run on the old code
 * reads as the diagnosis table.
 *
 * @covers CHAT-FOLD-01
 */
test.use({ contextOptions: { reducedMotion: "no-preference" } });

type Frame = {
  t: number;
  st: number;
  sh: number;
  ch: number;
  hy: number | null;
  hx: number | null;
  ay: number | null;
  fh: number | null;
};
type Probe = { frames: Frame[]; running: boolean; spec: { header: string; fold: string; docked: boolean } | null };

/**
 * A target is `css` (inside the visible chat pane) or `msg:<text>|<css>` (inside
 * the message row whose text contains <text>).
 */
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const p: Probe = { frames: [], running: false, spec: null };
    (window as unknown as { __acc: Probe }).__acc = p;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const visiblePane = (): Element | null => {
      for (const area of document.querySelectorAll('[data-testid="chat-input-area"]')) {
        const r = area.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && area.parentElement) return area.parentElement;
      }
      return null;
    };
    const find = (root: Element | null, target: string): Element | null => {
      if (!root) return null;
      if (!target.startsWith("msg:")) return root.querySelector(target);
      const [text, css] = target.slice(4).split("|");
      const row = [...root.querySelectorAll('[data-testid="chat-message"]')].find((m) => (m.textContent ?? "").includes(text!));
      return row ? (css ? row.querySelector(css) : row) : null;
    };
    const sample = () => {
      const spec = p.spec;
      const root = visiblePane();
      const sc = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? null;
      const header = spec ? find(root, spec.header) : null;
      const fold = spec ? find(root, spec.fold) : null;
      const rows = root ? [...root.querySelectorAll('[data-testid="chat-message"]')] : [];
      let above: Element | null = null;
      if (header && sc) {
        const scTop = sc.getBoundingClientRect().top;
        const scBottom = sc.getBoundingClientRect().bottom;
        if (spec!.docked) {
          // The last row of the transcript still on screen above the strip.
          const limit = header.getBoundingClientRect().top;
          above = rows.filter((m) => {
            const r = m.getBoundingClientRect();
            return r.height > 0 && r.top >= scTop && r.top < Math.min(limit, scBottom);
          }).pop() ?? null;
        } else {
          const own = header.closest('[data-testid="chat-message"]');
          const idx = own ? rows.indexOf(own) : -1;
          above = idx > 0 ? rows[idx - 1]! : null;
          if (above && above.getBoundingClientRect().bottom < scTop) above = null;
        }
      }
      const hr = header?.getBoundingClientRect();
      p.frames.push({
        t: performance.now(),
        st: sc ? r1(sc.scrollTop) : -1,
        sh: sc ? sc.scrollHeight : -1,
        ch: sc ? sc.clientHeight : -1,
        hy: hr && hr.height > 0 ? r1(hr.top) : null,
        hx: hr && hr.height > 0 ? r1(hr.left) : null,
        ay: above ? r1(above.getBoundingClientRect().top) : null,
        fh: fold ? r1(fold.getBoundingClientRect().height) : null,
      });
    };
    // Sampled in a ResizeObserver callback on a marker resized every frame:
    // after layout, before paint, after the app's own observers (created
    // earlier). What it reads is what is painted (see chat-transcript-motion).
    let marker: HTMLElement | null = null;
    const tick = () => {
      if (p.running && marker) marker.style.width = marker.style.width === "2px" ? "1px" : "2px";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let observer: ResizeObserver | null = null;
    const arm = () => {
      observer?.disconnect();
      marker?.remove();
      marker = document.createElement("div");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(marker);
      observer = new ResizeObserver(() => { if (p.running) sample(); });
      observer.observe(marker);
    };
    (window as unknown as { __accArm: () => void }).__accArm = arm;
    // Observers run in the order they were created. The app may create one
    // of its own in the click handler (the fold's hold), so the sampler is
    // created again right after every click, in the bubble phase on window,
    // which runs after React's handler: it stays the last code before paint.
    window.addEventListener("click", () => { if (p.running) arm(); });
  });
}

async function startProbe(page: Page, spec: Probe["spec"]) {
  await page.evaluate((s) => {
    if (s && s.header.includes(";;")) {
      // `A;;B`: the fold's own header when it is in sight, else the control
      // under the body (a long code block folded from its end).
      const [a, b] = s.header.split(";;");
      const pane = [...document.querySelectorAll('[data-testid="chat-input-area"]')].find((x) => x.getBoundingClientRect().height > 0)?.parentElement;
      const sc = pane?.querySelector("[data-virtuoso-scroller]");
      const find = (t: string) => {
        if (!t.startsWith("msg:")) return pane?.querySelector(t) ?? null;
        const [text, css] = t.slice(4).split("|");
        const row = [...(pane?.querySelectorAll('[data-testid="chat-message"]') ?? [])].find((m) => (m.textContent ?? "").includes(text!));
        return row && css ? row.querySelector(css) : row ?? null;
      };
      const el = find(a!);
      s.header = el && sc && el.getBoundingClientRect().top >= sc.getBoundingClientRect().top ? a! : b!;
    }
    const p = (window as unknown as { __acc: Probe }).__acc;
    p.frames = []; p.spec = s; p.running = true;
    (window as unknown as { __accArm: () => void }).__accArm();
  }, spec);
}

async function stopProbe(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const p = (window as unknown as { __acc: Probe }).__acc;
    p.running = false;
    return JSON.parse(JSON.stringify(p.frames)) as Frame[];
  });
}

const frameCount = (page: Page) => page.evaluate(() => (window as unknown as { __acc: Probe }).__acc.frames.length);

/** Waits until the last `n` sampled frames show the view and the header still. */
async function waitStill(page: Page, n = 12) {
  await page.waitForFunction((k) => {
    const f = (window as unknown as { __acc: Probe }).__acc.frames.slice(-k);
    return f.length === k && f.every((x) => x.st === f[0]!.st && x.sh === f[0]!.sh && x.hy === f[0]!.hy && x.fh === f[0]!.fh);
  }, n, { timeout: 20_000 });
}

/** Lets the sampler run until `ms` have passed since frame `from`. */
async function sampleFor(page: Page, from: number, ms: number) {
  await page.waitForFunction(({ i, d }) => {
    const f = (window as unknown as { __acc: Probe }).__acc.frames;
    return f.length > i + 2 && f[f.length - 1]!.t - f[i]!.t >= d;
  }, { i: from, d: ms }, { timeout: 30_000 });
}

/**
 * Distinct runs of change of the fold's height in one direction. An animation
 * or an instant reveal is ONE run; a body that shows a placeholder and then
 * its real content is two. A run may pause for a couple of frames (a busy
 * frame, the slow tail of an easing curve) and stays one; runs under 4 px
 * are rounding, not content.
 */
function heightRuns(hs: number[], sign: 1 | -1): number {
  const PAUSE_FRAMES = 2;
  let runs = 0;
  let total = 0;
  let pause = 0;
  let inRun = false;
  const close = () => { if (inRun && total > 4) runs++; inRun = false; total = 0; pause = 0; };
  for (let i = 1; i < hs.length; i++) {
    const d = (hs[i]! - hs[i - 1]!) * sign;
    if (d > 0.5) { inRun = true; total += d; pause = 0; continue; }
    if (d < -0.5) { close(); continue; }
    if (inRun && ++pause > PAUSE_FRAMES) close();
  }
  close();
  return runs;
}

type Measure = {
  kind: string;
  where: "bottom" | "middle";
  phase: "open" | "close";
  frames: number;
  headerJump: number;
  aboveJump: number;
  sideJump: number;
  foldRuns: number;
  foldDelta: number;
  headerLost: boolean;
};

function measure(kind: string, where: Measure["where"], phase: Measure["phase"], frames: Frame[], clickAt: number): Measure {
  const base = frames[clickAt - 1]!;
  const after = frames.slice(clickAt);
  const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);
  const hs = [base, ...after].map((f) => f.fh ?? 0);
  return {
    kind,
    where,
    phase,
    frames: after.length,
    headerLost: after.some((f) => f.hy === null),
    headerJump: base.hy === null ? Infinity : max(after.filter((f) => f.hy !== null).map((f) => Math.abs(f.hy! - base.hy!))),
    aboveJump: base.ay === null ? 0 : max(after.filter((f) => f.ay !== null).map((f) => Math.abs(f.ay! - base.ay!))),
    sideJump: base.hx === null ? 0 : max(after.filter((f) => f.hx !== null).map((f) => Math.abs(f.hx! - base.hx!))),
    foldRuns: heightRuns(hs, phase === "open" ? 1 : -1),
    foldDelta: Math.round(((after[after.length - 1]?.fh ?? 0) - (base.fh ?? 0)) * 10) / 10,
  };
}

function faults(m: Measure, docked: boolean): string[] {
  const out: string[] = [];
  const at = `${m.kind} ${m.where} ${m.phase}`;
  if (m.headerLost) out.push(`${at}: the header left the DOM`);
  if (m.headerJump > 1) out.push(`${at}: the clicked header moved ${m.headerJump}px`);
  if (m.aboveJump > 1) out.push(`${at}: the row above moved ${m.aboveJump}px`);
  if (m.sideJump > 1) out.push(`${at}: the header moved ${m.sideJump}px sideways`);
  if (!docked && m.foldRuns > 1) out.push(`${at}: the fold changed height in ${m.foldRuns} separate runs (a reveal that pops)`);
  return out;
}

// ---------------------------------------------------------------------------
// The folds.
// ---------------------------------------------------------------------------

type Seed = Omit<SeedMessageOpts, "sessionKey">;
type Kind = {
  name: string;
  /** The rows of ONE instance of the fold, tagged so the two instances differ. */
  seed: (tag: string) => Seed[];
  /** What the person clicks. */
  click: (tag: string) => string;
  /** What must not move (defaults to `click`): the fold's own header. */
  header?: (tag: string) => string;
  /** The fold: header plus body. */
  fold: (tag: string) => string;
  /** Opens by default: the first click closes it. */
  startsOpen?: boolean;
  /** Docked over the composer: one instance, outside the transcript. */
  docked?: boolean;
  /** Seen once open, to know the click did open it. */
  opened: (page: Page, tag: string) => Locator;
};

const LINES = (n: number, what: string) => Array.from({ length: n }, (_, i) => `${what} line ${i + 1}`).join("\n");
const now = Date.now();
const WORK_DIR = join(canonicalTmpRoot(), "e2e-accordion-no-shift");

const KINDS: Kind[] = [
  {
    name: "tool-group",
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: [1, 2, 3, 4].map((i) => ({
        id: `${tag}-g${i}`, name: "Read", args: { file_path: `/tmp/${tag}/file-${i}.ts` }, status: "success" as const,
        result: LINES(6, `read ${i}`), startedAt: now - 3000, endedAt: now - 2000,
      })),
    }],
    click: (tag) => `[data-group-id="${tag}-g1"] [data-testid="tool-group-summary"]`,
    fold: (tag) => `[data-group-id="${tag}-g1"]`,
    opened: (page, tag) => page.locator(`[data-testid="tool-call-row-${tag}-g4"]`),
  },
  {
    name: "tool-row",
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: `${tag}-t1`, name: "Bash", args: { command: `ls -la /tmp/${tag}` }, status: "success", result: LINES(14, "output"), startedAt: now - 2000, endedAt: now - 1000 }],
    }],
    click: (tag) => `[data-testid="tool-call-row-${tag}-t1"] > button`,
    fold: (tag) => `[data-testid="tool-call-row-${tag}-t1"]`,
    opened: (page, tag) => page.locator(`[data-testid="tool-call-row-${tag}-t1"]`).getByText("output line 14"),
  },
  {
    // The history ships this row's output blank (`detailBytes`): the body is
    // fetched on first open, which is where a reveal could pop.
    name: "tool-row-lazy",
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `${tag}-l1`, name: "Bash", args: { command: `cat /tmp/${tag}/log` }, status: "success",
        detail: { type: "shell", command: `cat /tmp/${tag}/log`, output: LINES(16, "lazy") },
        startedAt: now - 2000, endedAt: now - 1000,
      }],
    }],
    click: (tag) => `[data-testid="tool-call-row-${tag}-l1"] > button`,
    fold: (tag) => `[data-testid="tool-call-row-${tag}-l1"]`,
    opened: (page, tag) => page.locator(`[data-testid="tool-call-row-${tag}-l1"]`).getByText("lazy line 16"),
  },
  {
    name: "turn-work",
    seed: (tag) => [{
      role: "assistant",
      content: `Answer ${tag}`,
      blocks: [
        ...[1, 2, 3].map((i) => ({ kind: "tool", toolCall: { id: `${tag}-w${i}`, name: "Read", args: { file_path: `/tmp/${tag}/w${i}.ts` }, status: "success", result: LINES(4, `w${i}`), startedAt: now - 3000, endedAt: now - 2500 } })),
        { kind: "text", text: `Answer ${tag}: the work is folded above.` },
      ],
    }],
    click: (tag) => `msg:Answer ${tag}|[data-testid="turn-work-fold"] [data-testid="task-work-summary"]`,
    fold: (tag) => `msg:Answer ${tag}|[data-testid="turn-work-fold"]`,
    // Three calls make a group inside the fold (CHAT-TOOL-02).
    opened: (page, tag) => page.locator(`[data-group-id="${tag}-w1"]`),
  },
  {
    name: "reasoning",
    seed: (tag) => [{
      role: "assistant",
      content: `Thought ${tag}`,
      blocks: [
        { kind: "thinking", text: LINES(12, `thinking ${tag}`) },
        { kind: "text", text: `Thought ${tag}: done thinking.` },
      ],
    }],
    click: (tag) => `msg:Thought ${tag}|[data-testid="reasoning-row"] > button`,
    fold: (tag) => `msg:Thought ${tag}|[data-testid="reasoning-row"]`,
    opened: (page, tag) => page.getByText(`thinking ${tag} line 12`),
  },
  {
    // Open by default: its action log is the point. Closed first, then opened.
    name: "subagent",
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `${tag}-s1`, name: "Task", args: { description: `Survey ${tag}`, prompt: "look around", subagent_type: "general-purpose" }, status: "success",
        detail: { type: "sub_agent", subAgentType: "general-purpose", description: `Survey ${tag}`, actions: Array.from({ length: 8 }, (_, i) => ({ index: i, toolName: "Read", summary: `file ${i}.ts`, status: "success" })) },
        startedAt: now - 5000, endedAt: now - 1000,
      }],
    }],
    click: (tag) => `[data-testid="tool-call-row-${tag}-s1"] > button`,
    fold: (tag) => `[data-testid="tool-call-row-${tag}-s1"]`,
    startsOpen: true,
    opened: (page, tag) => page.locator(`[data-testid="tool-call-row-${tag}-s1"]`).getByText("file 7.ts"),
  },
  {
    name: "turn-error",
    seed: (tag) => [{
      role: "assistant",
      content: `Failed ${tag}`,
      blocks: [
        { kind: "error", text: `API Error: 500 ${JSON.stringify({ type: "error", error: { type: "api_error", message: `Internal ${tag}`, trace: LINES(10, "frame") }, request_id: `req_${tag}` })}` },
        { kind: "text", text: `Failed ${tag}: the turn stopped here.` },
      ],
    }],
    click: (tag) => `msg:Failed ${tag}|[data-testid="turn-error-details"] > summary`,
    fold: (tag) => `msg:Failed ${tag}|[data-testid="turn-error"]`,
    opened: (page, tag) => page.locator('[data-testid="chat-message"]', { hasText: `Failed ${tag}` }).locator('[data-testid="turn-error-details"] pre'),
  },
  {
    // The control is under the code, the block's own header is what stays.
    name: "code-block",
    seed: (tag) => [{
      role: "assistant",
      content: `Code ${tag}\n\n\`\`\`ts\n${Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}; // ${tag}`).join("\n")}\n\`\`\``,
    }],
    click: (tag) => `msg:Code ${tag}|.code-block-wrapper > button`,
    // Folded from its end with its header out of sight, the control under
    // the body is what stays (the reader is not dropped past the block).
    header: (tag) => `msg:Code ${tag}|.code-block-wrapper > div;;msg:Code ${tag}|.code-block-wrapper > button`,
    fold: (tag) => `msg:Code ${tag}|.code-block-wrapper`,
    opened: (page, tag) => page.getByText(`const v39 = 39; // ${tag}`),
  },
  {
    name: "compaction-recap",
    seed: (tag) => [{
      role: "assistant",
      content: `Recap ${tag}\n\nThis session is being continued from a previous conversation that ran out of context. The summary below covers it.\n\n${LINES(10, `recap ${tag}`).split("\n").map((l) => `- ${l}`).join("\n")}`,
    }],
    click: (tag) => `msg:Recap ${tag}|[data-testid="compaction-summary-fold"] > button`,
    fold: (tag) => `msg:Recap ${tag}|[data-testid="compaction-summary-fold"]`,
    opened: (page, tag) => page.getByText(`recap ${tag} line 10`),
  },
  {
    name: "dispatch-envelope",
    seed: (tag) => [{
      id: `${tag}-env`,
      role: "user",
      content: `Kickoff ${tag}\n${LINES(10, `envelope ${tag}`)}`,
      blocks: [{ kind: "dispatched-envelope" }],
    }],
    click: (tag) => `[data-message-id="${tag}-env"] [data-testid="dispatch-envelope-toggle"]`,
    fold: (tag) => `[data-message-id="${tag}-env"]`,
    opened: (page, tag) => page.getByText(`envelope ${tag} line 10`),
  },
  {
    name: "process-exit",
    seed: (tag) => [{
      id: `${tag}-exit`,
      role: "user",
      content: `Process finished: exit 0\n${LINES(10, `tail ${tag}`)}`,
      blocks: [{ kind: "process-exit", processId: `${tag}-proc`, exitCode: 0, label: `build ${tag}` }],
    }],
    click: (tag) => `[data-message-id="${tag}-exit"] [data-testid="process-exit-toggle"]`,
    fold: (tag) => `[data-message-id="${tag}-exit"]`,
    opened: (page, tag) => page.getByText(`tail ${tag} line 10`),
  },
  {
    name: "todo-strip",
    docked: true,
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `${tag}-todo`, name: "TodoWrite", status: "success",
        args: { todos: Array.from({ length: 6 }, (_, i) => ({ content: `Step ${i + 1} ${tag}`, activeForm: `Doing step ${i + 1}`, status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending" })) },
        detail: { type: "todo", items: Array.from({ length: 6 }, (_, i) => ({ content: `Step ${i + 1} ${tag}`, activeForm: `Doing step ${i + 1}`, status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending" })) },
      }],
    }],
    click: () => '[data-testid="todo-strip"] > button',
    fold: () => '[data-testid="todo-strip"]',
    opened: (page, tag) => page.getByText(`Step 6 ${tag}`),
  },
  {
    name: "changed-files",
    docked: true,
    seed: (tag) => [{
      role: "assistant",
      content: "",
      toolCalls: Array.from({ length: 5 }, (_, i) => ({ id: `${tag}-wr${i}`, name: "Write", args: { file_path: `${WORK_DIR}/${tag}-${i}.ts` }, status: "success" as const })),
    }],
    click: () => '[data-testid="chat-changes-chip"]',
    fold: () => '[data-testid="chat-changes-strip"]',
    opened: (page) => page.getByTestId("chat-changes-list"),
  },
];

// ---------------------------------------------------------------------------

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((x) => x.id === topicId)!.sessionKey;
}

const filler = (i: number) => i % 2 === 0
  ? `Question ${i}: ${"what about the next part of the plan? ".repeat(1 + (i % 3))}`
  : `Reply ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(1 + (i % 4))}`;

/**
 * One chat per fold: 18 filler rows, the MIDDLE instance, 18 more, and the
 * LAST instance at the bottom. 40 rows in all, so the tail the history opens
 * with holds both, and the middle one sits two screens above the bottom.
 */
async function seedChat(request: APIRequestContext, kind: Kind) {
  const stamp = `${kind.name.replace(/-/g, "")}${Date.now().toString(36)}`;
  const t = await createTopic(request, `Fold ${kind.name} ${stamp}`);
  const sessionKey = await sessionKeyOf(request, t.id);
  const mid = `mid${stamp}`;
  const last = `end${stamp}`;
  const put = (m: Seed) => seedMessage(request, { sessionKey, ...m });
  let n = 0;
  const fill = async (count: number) => {
    for (let i = 0; i < count; i++) await put({ role: n % 2 === 0 ? "user" : "assistant", content: filler(n++) });
  };
  await fill(18);
  if (!kind.docked) {
    if (kind.seed(mid)[0]!.role === "assistant") await put({ role: "user", content: `Show me ${mid}` });
    for (const m of kind.seed(mid)) await put(m);
    n = 0;
  }
  await fill(18);
  if (kind.seed(last)[0]!.role === "assistant") await put({ role: "user", content: `Show me ${last}` });
  for (const m of kind.seed(last)) await put(m);
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, mid: kind.docked ? last : mid, last };
}

async function openChat(page: Page, request: APIRequestContext, topicId: string) {
  await resetPaneStore(request, [topicId]);
  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), topicId);
  await goToApp(page);
  await page.keyboard.press("Escape");
}

const scrollerOf = (page: Page) => page.locator('[data-testid="chat-input-area"]:visible').locator("xpath=..").locator("[data-virtuoso-scroller]").first();

function locate(page: Page, target: string): Locator {
  if (!target.startsWith("msg:")) return page.locator(target).first();
  const [text, css] = target.slice(4).split("|");
  const row = page.locator('[data-testid="chat-message"]', { hasText: text! }).first();
  return css ? row.locator(css).first() : row;
}

/** Wheels up, as a reader does, until `target` sits in the middle band of the view. */
async function wheelToMiddle(page: Page, target: string) {
  const sc = scrollerOf(page);
  const box = (await sc.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    const t = locate(page, target);
    const tb = (await t.count()) ? await t.boundingBox() : null;
    if (tb && tb.y > box.y + box.height * 0.3 && tb.y < box.y + box.height * 0.6) return;
    const delta = tb && tb.y > box.y + box.height * 0.6 ? 160 : -240;
    await page.mouse.wheel(0, delta);
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
  }
  throw new Error(`could not bring ${target} to the middle of the view`);
}

/**
 * Wheels, as a reader does, until `target` is in sight above the composer: a
 * control under a long body (the end of a code block) is reached by scrolling
 * to it, and a click that had to scroll first would move the page itself.
 */
async function bringIntoView(page: Page, target: string) {
  const sc = scrollerOf(page);
  const box = (await sc.boundingBox())!;
  const dock = (await page.locator('[data-testid="chat-input-area"]:visible').first().boundingBox())!;
  const top = box.y + 40;
  const bottom = dock.y - 16;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  for (let i = 0; i < 30; i++) {
    const tb = await locate(page, target).boundingBox();
    if (!tb) return;
    if (tb.y >= top && tb.y + tb.height <= bottom) return;
    const delta = tb.y + tb.height > bottom ? tb.y + tb.height - bottom + 60 : tb.y - top - 60;
    await page.mouse.wheel(0, Math.max(-400, Math.min(400, delta)));
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
  }
}

async function togglePhase(page: Page, kind: Kind, tag: string, where: Measure["where"], phase: Measure["phase"]): Promise<{ m: Measure; frames: Frame[] }> {
  await bringIntoView(page, kind.click(tag));
  const header = (kind.header ?? kind.click)(tag);
  await startProbe(page, { header, fold: kind.fold(tag), docked: !!kind.docked });
  await waitStill(page);
  const clickAt = await frameCount(page);
  await locate(page, kind.click(tag)).click();
  await sampleFor(page, clickAt, 900);
  const frames = await stopProbe(page);
  // The click is sampled from the first frame after it was sent.
  return { m: measure(kind.name, where, phase, frames, clickAt), frames };
}

test.describe("a fold opened by hand does not move the transcript", () => {
  test.describe.configure({ timeout: 180_000 });
  const created: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
  });

  for (const kind of KINDS) {
    test(`${kind.name}: open and close, at the bottom and in the middle`, async ({ page, request }, testInfo: TestInfo) => {
      test.info().annotations.push({ type: "spec", description: "CHAT-FOLD-01" });
      const chat = await seedChat(request, kind);
      created.push(chat.topicId);
      await installProbe(page);
      await openChat(page, request, chat.topicId);
      const sc = scrollerOf(page);
      const lastClick = locate(page, kind.click(chat.last));
      await expect(lastClick).toBeVisible({ timeout: 30_000 });

      const results: Measure[] = [];
      const all: Record<string, Frame[]> = {};
      const phases: Measure["phase"][] = kind.startsOpen ? ["close", "open"] : ["open", "close"];

      // AT THE BOTTOM: the reader follows the output, nothing touched.
      await startProbe(page, { header: kind.click(chat.last), fold: kind.fold(chat.last), docked: !!kind.docked });
      await page.waitForFunction(() => {
        const f = (window as unknown as { __acc: Probe }).__acc.frames.slice(-15);
        return f.length === 15 && f.every((x) => x.st === f[0]!.st && x.sh === f[0]!.sh && x.sh - x.st - x.ch <= 1);
      }, null, { timeout: 30_000 });
      await stopProbe(page);
      for (const phase of phases) {
        const { m, frames } = await togglePhase(page, kind, chat.last, "bottom", phase);
        results.push(m);
        all[`bottom-${phase}`] = frames;
        if (phase === "open") await expect.soft(kind.opened(page, chat.last), `${kind.name} bottom: the click opened it`).toBeVisible();
      }

      // IN THE MIDDLE: wheeled up to an older instance (for a docked strip:
      // the same strip, the transcript read two screens up).
      await wheelToMiddle(page, kind.docked ? `msg:Reply 9` : (kind.header ?? kind.click)(chat.mid).split(";;")[0]!);
      const residual = await sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      expect(residual, "the middle case is away from the bottom").toBeGreaterThan(300);
      for (const phase of phases) {
        const { m, frames } = await togglePhase(page, kind, chat.mid, "middle", phase);
        results.push(m);
        all[`middle-${phase}`] = frames;
        if (phase === "open") await expect.soft(kind.opened(page, chat.mid), `${kind.name} middle: the click opened it`).toBeVisible();
      }

      const engine = testInfo.project.use.browserName ?? testInfo.project.name;
      for (const m of results) {
        const px = (n: number) => `${Math.round(n * 10) / 10}px`;
        console.log(`ACCORDION ${engine} ${m.kind} ${m.where} ${m.phase} header=${px(m.headerJump)} above=${px(m.aboveJump)} side=${px(m.sideJump)} runs=${m.foldRuns} fold=${px(m.foldDelta)} frames=${m.frames}${m.headerLost ? " LOST" : ""}`);
      }
      const path = testInfo.outputPath(`${kind.name}.json`);
      writeFileSync(path, JSON.stringify({ results, frames: all }));
      await testInfo.attach(`${kind.name}.json`, { path });

      for (const m of results) {
        if (kind.docked) continue;
        expect(Math.abs(m.foldDelta), `${m.kind} ${m.where} ${m.phase}: the fold did change height`).toBeGreaterThan(10);
      }
      expect(results.flatMap((m) => faults(m, !!kind.docked)), "the clicked header and everything above it stay put").toEqual([]);
    });
  }
});
