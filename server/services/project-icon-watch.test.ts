/**
 * @covers PROJECT-14
 *
 * The icon watch pushes ONE `project:icon` frame when a project's icon
 * appears, changes or goes away, and nothing for the rest of the folder.
 *
 * Two kinds of test. The first one runs on the real disk with the real
 * `fs.watch`, because the promise is about the disk: a favicon written by an
 * editor, an agent or `cp` reaches the windows. The others drive the folder
 * events through the `watchDir` seam, so the rules (which folders, which
 * entries, who announces) are checked without the timing of the OS.
 * Every wait is on a condition, never on the clock.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectIconWatch, type ProjectIconFrame, type ProjectIconWatch } from "./project-icon-watch";
import { resolveProjectIcon } from "../lib/project-icon";
import { slackMs } from "../../tests/helpers/time-slack";

/** A guard against a watcher that never fires, kept under the 30 s test timeout. */
const BUDGET_MS = Math.min(slackMs(8_000), 25_000);
/** Between two writes while waiting: over the debounce, so a write never restarts it forever. */
const POKE_MS = 400;

/**
 * Wait for `cond`, repeating `poke` meanwhile. A macOS folder watch is armed
 * asynchronously: a write that lands before it is armed produces no event at
 * all, so the write is repeated instead of hoping for the first one.
 */
async function until(cond: () => boolean, poke?: () => void): Promise<boolean> {
  const deadline = Date.now() + BUDGET_MS;
  let nextPoke = Date.now() + POKE_MS;
  while (Date.now() < deadline) {
    if (cond()) return true;
    if (poke && Date.now() >= nextPoke) { poke(); nextPoke = Date.now() + POKE_MS; }
    await Bun.sleep(20);
  }
  return cond();
}

const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"/>`;

let root: string;
let frames: ProjectIconFrame[];
const watches: ProjectIconWatch[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "icon-watch-")));
  frames = [];
});

afterEach(() => {
  for (const w of watches.splice(0)) w.close();
  rmSync(root, { recursive: true, force: true });
});

function project(name: string): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  return p;
}

/** A watch whose folder events are fired by hand: `fire(dir, entryName)`. */
function seamWatch() {
  const handlers = new Map<string, (name: string | null) => void>();
  const iw = createProjectIconWatch({
    push: (f) => frames.push(f),
    debounceMs: 0,
    watchDir: (dir, onEntry) => {
      handlers.set(dir, onEntry);
      return { close: () => { handlers.delete(dir); } };
    },
  });
  watches.push(iw);
  const fire = (dir: string, name: string | null) => {
    const h = handlers.get(dir);
    if (!h) throw new Error(`not watched: ${dir}`);
    h(name);
  };
  return { iw, fire, watched: () => [...handlers.keys()] };
}

const observe = (iw: ProjectIconWatch, p: string, asked = p) => iw.observe(p, asked, resolveProjectIcon(p));

describe("project-icon-watch on the real disk", () => {
  test("a favicon that appears, changes and goes away leaves a frame each time", async () => {
    const iw = createProjectIconWatch({ push: (f) => frames.push(f), debounceMs: 30 });
    watches.push(iw);
    const p = project("app");
    const icon = join(p, "favicon.svg");
    expect(observe(iw, p)).toBeNull();

    let w = 16;
    writeFileSync(icon, svg(w));
    expect(await until(() => frames.length >= 1, () => writeFileSync(icon, svg(++w)))).toBe(true);
    const added = frames.at(-1)!;
    expect(added).toMatchObject({ type: "project:icon", path: p });
    expect(added.version).not.toBeNull();

    const before = frames.length;
    writeFileSync(icon, svg(64));
    expect(await until(() => frames.length > before)).toBe(true);
    expect(frames.at(-1)!.version).not.toBeNull();
    expect(frames.at(-1)!.version).not.toBe(added.version);

    unlinkSync(icon);
    expect(await until(() => frames.at(-1)?.version === null)).toBe(true);
    expect(frames.at(-1)).toEqual({ type: "project:icon", path: p, version: null });
  });
});

describe("project-icon-watch rules", () => {
  test("it watches the folders the resolver reads, and a public/ created later joins them", async () => {
    const { iw, fire, watched } = seamWatch();
    const p = project("vite");
    mkdirSync(join(p, "src"));
    observe(iw, p);
    expect(watched().sort()).toEqual([p, join(p, "src")].sort());

    mkdirSync(join(p, "public"));
    fire(p, "public");
    expect(await until(() => watched().includes(join(p, "public")))).toBe(true);

    writeFileSync(join(p, "public", "favicon.svg"), svg(16));
    fire(join(p, "public"), "favicon.svg");
    expect(await until(() => frames.length === 1)).toBe(true);
    expect(frames[0].version).not.toBeNull();
  });

  test("an event on a source file does not even look", async () => {
    const { iw, fire } = seamWatch();
    const p = project("busy");
    mkdirSync(join(p, "src"));
    observe(iw, p);
    // The icon DID change on disk, but the only event is about a .ts file:
    // nothing may be resolved, so nothing may leave.
    writeFileSync(join(p, "favicon.svg"), svg(16));
    fire(join(p, "src"), "file.ts");
    fire(join(p, "src"), "package-lock.yaml");
    // The relevant event that follows is the marker: one frame, from it.
    fire(p, "favicon.svg");
    expect(await until(() => frames.length >= 1)).toBe(true);
    expect(frames.length).toBe(1);
  });

  test("a request that sees a new version first announces it, and the watcher does not repeat it", async () => {
    const { iw, fire } = seamWatch();
    const p = project("raced");
    observe(iw, p);
    writeFileSync(join(p, "favicon.svg"), svg(16));
    const v = observe(iw, p);
    expect(v).not.toBeNull();
    expect(frames).toEqual([{ type: "project:icon", path: p, version: v }]);
    // The watcher's event for the same write: same version, no second frame.
    fire(p, "favicon.svg");
    // Marker: a REAL change after it must be the second frame, not the third.
    writeFileSync(join(p, "favicon.svg"), svg(160));
    fire(p, "favicon.svg");
    expect(await until(() => frames.length >= 2)).toBe(true);
    expect(frames.length).toBe(2);
  });

  test("the frame carries every path the clients asked with", async () => {
    const { iw, fire } = seamWatch();
    const p = project("real");
    const link = join(root, "link");
    symlinkSync(p, link);
    observe(iw, p, p);
    observe(iw, p, link);
    writeFileSync(join(p, "favicon.svg"), svg(16));
    fire(p, "favicon.svg");
    expect(await until(() => frames.length === 2)).toBe(true);
    expect(frames.map((f) => f.path).sort()).toEqual([link, p].sort());
  });

  test("past the cap the project asked about longest ago is dropped, with its folders", () => {
    const closed: string[] = [];
    const small = createProjectIconWatch({
      push: () => {},
      maxTracked: 2,
      watchDir: (dir) => ({ close: () => { closed.push(dir); } }),
    });
    watches.push(small);
    const [a, b, c] = ["a", "b", "c"].map(project);
    small.observe(a, a, null);
    small.observe(b, b, null);
    small.observe(a, a, null); // touch: b is now the oldest
    small.observe(c, c, null);
    expect(small.tracked()).toEqual([a, c]);
    expect(closed).toEqual([b]);
  });
});
