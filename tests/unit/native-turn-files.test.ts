/**
 * The registry of files THIS turn created in its workspace (card 7be32c03).
 *
 * `rm` of such a file passes the native guard; `rm` of anything the turn only
 * found there does not. The registry must therefore be precise before it is
 * complete: a path is registered only when it did NOT exist before the tool
 * ran and DOES exist after, inside the workspace. A file the turn overwrote,
 * edited or merely listed is never the turn's.
 *
 * Recall is deliberately modest (write_file, `>`, `tee`, `touch`, `mkdir`,
 * `cp`): a file made by a script the turn ran is NOT registered, and the last
 * test says so out loud instead of hiding it.
 *
 * @covers RT-07
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTurnFiles, type TurnFiles } from "../../server/providers/native/turn-files";
import { decide } from "../../server/providers/native/permissions";
import { executeTool } from "../../server/providers/native/tools";

// The workspace must sit OUTSIDE every temp root, or the temp rule would make
// these tests pass for the wrong reason.
const BASE = join(homedir(), ".cache");
let root: string;
let ws: string;
let outside: string;
let tf: TurnFiles;

beforeAll(() => {
  mkdirSync(BASE, { recursive: true });
  root = mkdtempSync(join(BASE, "topics-turn-files-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  ws = mkdtempSync(join(root, "ws-"));
  outside = mkdtempSync(join(root, "outside-"));
  tf = createTurnFiles(ws);
});

/** Run a bash command the way the loop does: watch, execute, close the watch. */
async function bash(command: string, cwd?: string): Promise<void> {
  const input = { command, ...(cwd ? { cwd } : {}) };
  const done = tf.watch("bash", input);
  await executeTool("bash", input, { workspace: ws });
  done();
}

async function write(path: string, content = "x"): Promise<void> {
  const input = { path, content };
  const done = tf.watch("write_file", input);
  await executeTool("write_file", input, { workspace: ws });
  done();
}

describe("write_file", () => {
  test("a new file is the turn's; an overwritten one is not", async () => {
    writeFileSync(join(ws, "old.txt"), "before");
    await write("new.txt");
    await write("old.txt", "after");
    expect(tf.has(join(ws, "new.txt"))).toBe(true);
    expect(tf.has(join(ws, "old.txt"))).toBe(false);
  });

  test("a new file in a subfolder it made", async () => {
    await write("a/b/c.txt");
    expect(tf.has(join(ws, "a", "b", "c.txt"))).toBe(true);
  });
});

describe("bash creation forms", () => {
  test("a heredoc redirect, relative and after a cd", async () => {
    await bash("cat > launch.sh <<'EOF'\necho hi\nEOF");
    mkdirSync(join(ws, "sub"));
    await bash("cd sub && echo y > f.txt");
    expect(tf.has(join(ws, "launch.sh"))).toBe(true);
    expect(tf.has(join(ws, "sub", "f.txt"))).toBe(true);
    expect(tf.has(join(ws, "sub"))).toBe(false);
  });

  test("touch, tee, append-to-a-new-file and cp", async () => {
    writeFileSync(join(ws, "src.txt"), "s");
    await bash("touch t1 t2; echo z | tee t3 > /dev/null; cp src.txt copy.txt; echo l >> fresh.log");
    for (const f of ["t1", "t2", "t3", "copy.txt", "fresh.log"]) expect(tf.has(join(ws, f)), f).toBe(true);
    expect(tf.has(join(ws, "src.txt"))).toBe(false);
  });

  test("cp into an existing directory registers the files it made there", async () => {
    mkdirSync(join(ws, "dest"));
    writeFileSync(join(ws, "a.png"), "a");
    await bash("cp a.png dest/");
    expect(tf.has(join(ws, "dest", "a.png"))).toBe(true);
    expect(tf.has(join(ws, "dest"))).toBe(false);
  });

  test("mkdir -p registers the topmost directory it made", async () => {
    await bash("mkdir -p deep/er/still");
    expect(tf.has(join(ws, "deep"))).toBe(true);
    expect(tf.has(join(ws, "deep", "er", "still", "file.txt"))).toBe(true);
    mkdirSync(join(ws, "kept"));
    await bash("mkdir -p kept/new");
    expect(tf.has(join(ws, "kept", "new"))).toBe(true);
    expect(tf.has(join(ws, "kept"))).toBe(false);
  });

  test("a file the command only overwrote, appended to or read is not the turn's", async () => {
    writeFileSync(join(ws, "MEMORY.md"), "memory");
    writeFileSync(join(ws, "log.txt"), "log");
    writeFileSync(join(ws, "keep.txt"), "keep");
    await bash("echo more > MEMORY.md; echo l >> log.txt; touch keep.txt; cat keep.txt > /dev/null");
    expect(tf.has(join(ws, "MEMORY.md"))).toBe(false);
    expect(tf.has(join(ws, "log.txt"))).toBe(false);
    expect(tf.has(join(ws, "keep.txt"))).toBe(false);
  });

  test("a command that failed before creating the file registers nothing", async () => {
    await bash("false && cat > never.txt <<'EOF'\nx\nEOF");
    expect(existsSync(join(ws, "never.txt"))).toBe(false);
    expect(tf.has(join(ws, "never.txt"))).toBe(false);
  });
});

describe("only inside the workspace", () => {
  test("a file made elsewhere is not registered", async () => {
    await bash(`echo x > ${outside}/o.txt; touch ~/.topics-turn-files-never-created 2>/dev/null; rm -f ~/.topics-turn-files-never-created`);
    expect(tf.has(join(outside, "o.txt"))).toBe(false);
  });

  test("the workspace itself and its parents are never registered", async () => {
    await bash("mkdir -p x");
    expect(tf.has(ws)).toBe(false);
    expect(tf.has(root)).toBe(false);
    expect(tf.has(join(ws, ".."))).toBe(false);
  });

  test("a symlink out of the workspace does not carry the claim with it", async () => {
    symlinkSync(outside, join(ws, "link"));
    await bash("echo x > link/leaked.txt");
    expect(existsSync(join(outside, "leaked.txt"))).toBe(true);
    expect(tf.has(join(ws, "link", "leaked.txt"))).toBe(false);
    expect(tf.has(join(outside, "leaked.txt"))).toBe(false);
  });
});

describe("what `has` answers", () => {
  test("a registered directory covers what is inside it, not its siblings", async () => {
    await bash("mkdir proj");
    mkdirSync(join(ws, "proj-other"));
    expect(tf.has(join(ws, "proj"))).toBe(true);
    expect(tf.has(join(ws, "proj", "any", "file"))).toBe(true);
    expect(tf.has(join(ws, "proj-other"))).toBe(false);
    expect(tf.has(join(ws, "pro"))).toBe(false);
  });

  test("two turns do not share a registry", async () => {
    await write("mine.txt");
    const next = createTurnFiles(ws);
    expect(tf.has(join(ws, "mine.txt"))).toBe(true);
    expect(next.has(join(ws, "mine.txt"))).toBe(false);
  });
});

describe("the limit, written down", () => {
  test("a file made by a script the turn ran is NOT registered", async () => {
    await bash(`python3 -c "open('from-script.txt','w').write('x')"`);
    expect(existsSync(join(ws, "from-script.txt"))).toBe(true);
    expect(tf.has(join(ws, "from-script.txt"))).toBe(false);
  });
});

describe("with the guard", () => {
  const rm = (cmd: string) => decide("bash", { command: cmd }, "auto-apply", { workspace: ws, createdByTurn: tf.has }).allow;

  test("the turn removes what it made and nothing it found", async () => {
    writeFileSync(join(ws, "found.txt"), "found");
    await bash("cat > made.sh <<'EOF'\necho hi\nEOF");
    await bash("mkdir scratch && echo x > scratch/a.txt");
    expect(rm("rm -f made.sh")).toBe(true);
    expect(rm(`rm -f ${join(ws, "made.sh")}`)).toBe(true);
    expect(rm("rm -rf scratch")).toBe(true);
    expect(rm("rm -f found.txt")).toBe(false);
    expect(rm("rm -f made.sh found.txt")).toBe(false);
    expect(rm(`rm -f ${outside}/o.txt`)).toBe(false);
    expect(rm("rm -rf .")).toBe(false);
  });
});
