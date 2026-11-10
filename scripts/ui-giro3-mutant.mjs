#!/usr/bin/env node
/**
 * scripts/ui-giro3-mutant.mjs - the planted-defect build of round 3: one
 * break per point of the brief (nine), built apart, and the walk of the nine
 * checks run against it. Every check must turn red.
 *
 * WHY. A check that never goes red proves nothing (Attilio, 08/11: a bar
 * with numbers, not a list of claims). The nine controls of
 * `ui-giro3-walk.mjs` are only worth something if breaking the thing they
 * look at makes THEM fail. Each mutation below breaks one point and nothing
 * else, so the exit code of the walk tells which control is blind.
 *
 * WHAT. 1) Checks that every text to replace is in its file exactly once
 * (otherwise exit 2 and nothing is touched). 2) Writes the nine mutations.
 * 3) Builds `client/dist-ui-mutant` (vite, same config, other outDir). 4) Puts
 * every source back as it was, always (try/finally, and on exit or a signal).
 * 5) Runs `ui-giro3-walk.mjs --entry sarim --dist dist-ui-mutant --expect-red`.
 *
 *   node scripts/ui-giro3-mutant.mjs [--only p5,p7] [--keep]
 *
 * With no `--only` all nine are planted and all nine must be red. With
 * `--only p5,p7` just those are planted and exactly those must be red, the
 * others green (one defect at a time: it shows that a mutation breaks its own
 * control and no other). `--keep` leaves `dist-ui-mutant` for inspection.
 * Exit 0: the walk saw the reds it was told to expect. Exit 1: a control stayed
 * green (or one turned red that should not). Exit 2: a text to replace is not
 * there exactly once, the build failed, or the build does not boot.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, flag } from "./ui-app/serve.mjs";

const CLIENT = join(ROOT, "client");
const OUT = "dist-ui-mutant";

/** One break per point: the file under `client/src/`, the text there exactly once, and what it becomes. */
const MUTATIONS = [
  {
    id: "p1",
    what: "every later step of the flow reads as the current one",
    file: "ui/flows/FlowCanvas.tsx",
    from: "data-flow-step-current={step.state === 'current' || step.state === 'error' || step.state === 'waiting' ? '' : undefined}",
    to: "data-flow-step-current={step.state !== 'done' ? '' : undefined}",
  },
  {
    id: "p2",
    what: "kanban columns drop to 220 px instead of a quarter of the board",
    file: "ui/kanban/KanbanBoard.tsx",
    from: "const COLUMN_WIDTH = 'clamp(16.5rem, calc((100cqw - 2rem - 2.25rem) / 4), 26rem)';",
    to: "const COLUMN_WIDTH = '13.75rem';",
  },
  {
    id: "p3",
    what: "the flow's name is drawn a second time inside the original section of the card",
    file: "ui/kanban/CardDetail.tsx",
    from: "{shown.marks.length === 0 && <p className=\"mt-2 text-compact text-app-text-tertiary\">{d.noValues}</p>}",
    to: "<FlowLabel flow={head.flow} />{shown.marks.length === 0 && <p className=\"mt-2 text-compact text-app-text-tertiary\">{d.noValues}</p>}",
  },
  {
    id: "p4",
    what: "the sidebar of the edition shows a second organization",
    file: "ui-gallery/sarim/sidebar.ts",
    from: "orgs: [{",
    to: "orgs: [{ id: 'altra-org', name: 'Consorzio di Nocera', monogram: 'CN', color: '#0a7', nav: [], expanded: true }, {",
  },
  {
    id: "p5",
    what: "the AI's answer loses its data-chat-reply mark (and so the chat reads as empty)",
    file: "ui/chat/ChatPanel.tsx",
    from: "<div data-chat-reply=\"\"",
    to: "<div data-chat-answer=\"\"",
  },
  {
    id: "p6",
    what: "a pinned tile comes back in the sidebar model",
    file: "ui-gallery/sarim/sidebar.ts",
    from: "activeId: chatRowOf(activeId, state, recent.map((c) => c.id)),",
    to: "pinned: [{ id: 'pin:fissato', label: 'Fissato', monogram: 'F', color: '#0066ff' }],\n    activeId: chatRowOf(activeId, state, recent.map((c) => c.id)),",
  },
  {
    id: "p7",
    what: "the found text is no longer set in <mark>",
    file: "ui/shell/Marked.tsx",
    from: "<mark className=\"rounded-[3px] bg-primary/20 px-px font-medium text-inherit\">{p.text}</mark>",
    to: "<span className=\"rounded-[3px] bg-primary/20 px-px font-medium text-inherit\">{p.text}</span>",
  },
  {
    id: "p8",
    what: "the page of a new tab offers a «Nuovo SAP» that opens a program",
    file: "ui/shell/NewTabScreen.tsx",
    from: "<h2 className=\"text-headline font-semibold text-app-text\">{title}</h2>",
    to: "<h2 className=\"text-headline font-semibold text-app-text\">{title}</h2><button type=\"button\" onClick={() => onOpen('/programmi')}>Nuovo SAP</button>",
  },
  {
    id: "p9",
    what: "no preview tab: every navigation opens a new tab",
    file: "ui-gallery/app/Container.tsx",
    from: "const preview = launcher ? -1 : tabs.list.findIndex((t) => !t.pinned);",
    to: "const preview = -1;",
  },
];

const only = arg("only")?.split(",");
const planted = MUTATIONS.filter((m) => !only || only.includes(m.id));
if (!planted.length) {
  console.error("ui-giro3-mutant: --only names no known point");
  process.exit(2);
}

/* 1. every text is there exactly once, and none of the mutants is already in (a sign that a run before was cut short) */
const originals = new Map();
for (const m of planted) {
  const path = join(CLIENT, "src", m.file);
  if (!originals.has(path)) originals.set(path, readFileSync(path, "utf8"));
}
const count = (text, part) => (part ? text.split(part).length - 1 : 0);
for (const m of planted) {
  const text = originals.get(join(CLIENT, "src", m.file));
  const n = count(text, m.from);
  if (n !== 1) {
    console.error(`ui-giro3-mutant: ${m.id}: in ${m.file} il testo da cambiare compare ${n} volte, atteso 1: ${m.from.slice(0, 80)}`);
    process.exit(2);
  }
  if (count(text, m.to) > 0 && !m.to.includes(m.from)) {
    console.error(`ui-giro3-mutant: ${m.id}: ${m.file} contiene già la rottura (un giro precedente interrotto?), non la riapplico`);
    process.exit(2);
  }
}

/* 2. plant, 3. build, 4. put everything back, whatever happens */
const restore = () => { for (const [path, text] of originals) writeFileSync(path, text); };
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

let built;
try {
  const next = new Map(originals);
  for (const m of planted) {
    const path = join(CLIENT, "src", m.file);
    next.set(path, next.get(path).replace(m.from, () => m.to));
  }
  for (const [path, text] of next) writeFileSync(path, text);
  console.log(`ui-giro3-mutant: piantate ${planted.length} rotture (${planted.map((m) => m.id).join(", ")}), costruisco ${OUT}`);
  built = spawnSync(process.execPath, [join(CLIENT, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.ui.config.ts", "--outDir", OUT], { cwd: CLIENT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
} finally {
  restore();
}
if (built.status !== 0) {
  console.error(`ui-giro3-mutant: la build del mutante è fallita (exit ${built.status})\n${(built.stdout ?? "").slice(-1500)}${(built.stderr ?? "").slice(-1500)}`);
  process.exit(2);
}
console.log("ui-giro3-mutant: sorgenti rimessi come erano, build del mutante pronta");

/* 5. the walk against the mutant */
const expect = only ? planted.map((m) => m.id).join(",") : "all";
const run = spawnSync(process.execPath, [join(ROOT, "scripts/ui-giro3-walk.mjs"), "--entry", "sarim", "--dist", OUT, "--expect-red", expect], { cwd: ROOT, stdio: "inherit" });
if (!flag("keep")) rmSync(join(CLIENT, OUT), { recursive: true, force: true });
process.exit(run.status ?? 1);
