/**
 * The native runtime's guard stays shut everywhere except the turn's own
 * scratch space: `/tmp`, `/private/tmp`, `$TMPDIR` and the files THIS turn
 * created in its workspace (card 7be32c03).
 *
 * Measured on the live database, 10-12 Nov: of 140 refused bash commands, 113
 * were `rm` and 7 were the `dd` pattern. Most of the `rm` refusals were already
 * temp-only commands: the parser read a trailing space as an empty target, a
 * `2>/dev/null` as a target, and a relative path after `cd /tmp` as a path
 * outside. The `dd` refusals were never about `dd`: `yyyy-mm-dd`, `<dd>` and
 * `for dd in` matched a word regex.
 *
 * Every case below is a real command from that window (or its minimal shape).
 * Nothing outside the perimeter changes: the second half proves it.
 *
 * @covers RT-07
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type PermissionScope } from "../../server/providers/native/permissions";

const HOME_WS = join(homedir(), ".claude", "jarvis", "home");

function run(command: string, scope?: PermissionScope, cwd?: string): boolean {
  return decide("bash", { command, ...(cwd ? { cwd } : {}) }, "auto-apply", scope).allow;
}

/** The scope a channel turn runs with: its workspace, and what it has created. */
function scopeWith(created: string[] = []): PermissionScope {
  return { workspace: HOME_WS, createdByTurn: (p) => created.includes(p) };
}

// Real folders: a `cd` is only believed when its target exists, so the fixtures
// must exist. They live under the OS temp dir, which is itself a temp root.
let T: string;
beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), "perm-scope-"));
  for (const d of ["sc", "hz", "mc-ag", "a/b"]) mkdirSync(join(T, d), { recursive: true });
});
afterAll(() => rmSync(T, { recursive: true, force: true }));

// A workspace OUTSIDE every temp root, with a real subfolder: the registry
// clause must be what lets the `rm` through, not the temp rule.
let W: string;
beforeAll(() => {
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  W = mkdtempSync(join(homedir(), ".cache", "perm-scope-ws-"));
  mkdirSync(join(W, "sub"));
  writeFileSync(join(W, "existing.txt"), "was here first");
});
afterAll(() => rmSync(W, { recursive: true, force: true }));

let savedTmpdir: string | undefined;
beforeEach(() => {
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = "/var/folders/ab/cdef/T/";
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});

describe("rm under /tmp, /private/tmp and $TMPDIR passes", () => {
  test("the plain absolute forms", () => {
    expect(run("rm -rf /tmp/x")).toBe(true);
    expect(run("rm -rf /private/tmp/x")).toBe(true);
    expect(run("rm -rf /tmp/a /tmp/b")).toBe(true);
    expect(run("rm -rf /var/folders/xx/T/tmp.123")).toBe(true);
  });

  // A segment that ends before `&&` / `;` keeps its trailing space, and the
  // old parser read that space as an empty target outside /tmp: 41 refusals.
  test("a trailing space before a chain is not a target", () => {
    expect(run("cd /tmp && rm -rf /tmp/aw/media && mkdir /tmp/aw/media")).toBe(true);
    expect(run("rm -rf /tmp/vf-c1.tHIN /tmp/vf-r4.S0sY && echo pulito")).toBe(true);
    expect(run("rm -r /tmp/mclv3 && echo pulito")).toBe(true);
    expect(run("rm -f /tmp/pl4.cj ; echo done")).toBe(true);
  });

  // `2>/dev/null` and `2>&1` were read as targets: 11 refusals.
  test("a redirection is not a target", () => {
    expect(run("rm -rf /tmp/lf-pc/* 2>/dev/null")).toBe(true);
    expect(run("rm -r /tmp/mc-c2-esplora /tmp/mc-c2-r 2>&1")).toBe(true);
    expect(run("rm -f /tmp/x >/dev/null 2>&1")).toBe(true);
    expect(run("rm -rf /tmp/x 2> /tmp/err.log")).toBe(true);
  });

  // `cd /tmp/hz && rm -rf z`: 63 refusals were a relative path after a cd into /tmp.
  test("a relative path after a cd into a temp dir", () => {
    expect(run("cd /tmp && rm -rf zmain")).toBe(true);
    expect(run(`cd ${T}/sc; rm -f launch.sh`)).toBe(true);
    expect(run(`cd ${T}/hz && rm -rf z`)).toBe(true);
    expect(run(`cd ${T}/mc-ag && { rm -f tests/unit/zz-ag.test.ts; }`)).toBe(true);
    expect(run("rm -rf lfp", scopeWith(), "/tmp")).toBe(true);
    expect(run(`cd ${T}/a && cd b && rm -rf c`)).toBe(true);
    expect(run(`cd ${T}/sc && cd .. && rm -rf z`)).toBe(true); // still inside the temp dir
    expect(run("cd /tmp && cd .. && rm -rf z")).toBe(false); // out of it: `/z`
  });

  test.skipIf(!existsSync("/private/tmp"))("the /private/tmp spelling of a cd", () => {
    expect(run("cd /private/tmp && rm -rf z")).toBe(true);
  });

  test("a workspace that is itself under /tmp", () => {
    expect(run("rm -rf node_modules", { workspace: T })).toBe(true);
  });

  test("$TMPDIR, plain, braced and quoted", () => {
    expect(run("rm -rf $TMPDIR/playwright-transform-cache*")).toBe(true);
    expect(run("rm -rf ${TMPDIR}/x")).toBe(true);
    expect(run('rm -rf "$TMPDIR/x"')).toBe(true);
  });

  test("a variable the command itself set to a temp path", () => {
    expect(run("W=/tmp/aw; rm -rf $W/pg")).toBe(true);
    expect(run('OUT=/tmp/out.json; rm -f "$OUT"')).toBe(true);
    expect(run("T=$TMPDIR/work && rm -rf ${T}/a")).toBe(true);
  });

  test("a path made by mktemp in the same command", () => {
    expect(run("d=$(mktemp -d); echo hi > $d/f; rm -rf $d")).toBe(true);
    expect(run('T=$(mktemp -d /tmp/scelta-XXXX) && rm -rf "$T"')).toBe(true);
    expect(run("k=$(mktemp); chmod 600 $k; rm -f $k")).toBe(true);
    expect(run("f=`mktemp`; rm -f $f")).toBe(true);
  });
});

describe("rm outside the scratch space stays refused", () => {
  test("the cases the guard exists for", () => {
    expect(run("rm -rf /")).toBe(false);
    expect(run("rm -rf ~")).toBe(false);
    expect(run("rm -rf $HOME")).toBe(false);
    expect(run("rm -rf ~/proj")).toBe(false);
    expect(run("rm -rf build")).toBe(false);
    expect(run("rm -rf $dir")).toBe(false);
    expect(run("rm -rf /tmp/../etc")).toBe(false);
    expect(run("rm -rf /tmpfoo/x")).toBe(false);
    expect(run("rm -rf /tmp/a; rm -rf /Users/x/y")).toBe(false);
    expect(run("rm -rf /tmp/a /Users/x/y")).toBe(false);
    expect(run("rm -rf /tmp")).toBe(false);
    expect(run("rm -rf /tmp/")).toBe(false);
  });

  test("a relative path whose directory is not known to be temp", () => {
    expect(run("rm -rf x")).toBe(false);
    expect(run("rm -f node_modules", scopeWith())).toBe(false);
    expect(run("cd ~/Projects && rm -rf x")).toBe(false);
    expect(run("cd $T; rm -f report.json")).toBe(false);
    expect(run("cd /tmp && cd ~ && rm -rf z")).toBe(false);
    expect(run("cd /tmp && cd /Users/x/p && rm -rf y")).toBe(false);
    expect(run("cd /tmp && cd ~ && rm -rf z")).toBe(false);
    expect(run("cd /tmp && pushd ~/Projects && rm -rf y")).toBe(false);
    expect(run("cd /tmp && (cd ~/Projects; true); rm -rf y")).toBe(false);
    expect(run("cd /tmp && for d in a b; do cd ~/Projects; done; rm -rf y")).toBe(false);
  });

  // After `cd /tmp/typo; rm -rf build` a failed cd leaves the shell in the
  // workspace, and the rm would hit the workspace's own `build`.
  test("a cd into a folder that does not exist is not believed", () => {
    expect(run("cd /tmp/does-not-exist-7be32c03; rm -rf build", scopeWith())).toBe(false);
    expect(run("cd /tmp/does-not-exist-7be32c03 && rm -rf build", scopeWith())).toBe(false);
    expect(run(`mkdir -p ${T}/new && cd ${T}/new && rm -rf x`, scopeWith())).toBe(false);
  });

  // A heredoc body is text for another program: its `cd` line never moves the
  // directory the next real command runs in.
  test("a cd written inside a heredoc does not move the shell", () => {
    expect(run(`cat > ${T}/s.sh <<'EOF'\ncd /tmp\nEOF\nrm -rf build`, scopeWith())).toBe(false);
    expect(run(`cat > ${T}/s.sh <<'EOF'\nrm -rf build\nEOF`, scopeWith())).toBe(false);
    expect(run(`cd ${T} && cat > s.sh <<'EOF'\necho hi\nEOF\nrm -f s.sh`)).toBe(true);
  });

  test("the temp dir itself and its parent are not a target", () => {
    expect(run("cd /tmp && rm -rf .")).toBe(false);
    expect(run("cd /tmp && rm -rf ..")).toBe(false);
    expect(run("cd /tmp/a && rm -rf ../b")).toBe(false);
  });

  test("a call cwd outside the temp roots does not make a relative path temp", () => {
    expect(run("rm -rf lfp", scopeWith(), homedir())).toBe(false);
  });

  // $TMPDIR is only a temp path when the server really has one: unset, the
  // shell expands `$TMPDIR/*` to `/*`.
  test("$TMPDIR with no TMPDIR, or a TMPDIR that is not a temp dir", () => {
    delete process.env.TMPDIR;
    expect(run("rm -rf $TMPDIR/x")).toBe(false);
    process.env.TMPDIR = homedir();
    expect(run("rm -rf $TMPDIR/x")).toBe(false);
  });

  test("a variable that is not provably a temp path", () => {
    expect(run("W=~/proj; rm -rf $W/x")).toBe(false);
    expect(run("W=/tmp/a; W=$HOME; rm -rf $W/x")).toBe(false);
    expect(run("W=$(pwd); rm -rf $W/x")).toBe(false);
    expect(run("TMPDIR=/; rm -rf $TMPDIR/x")).toBe(false);
    expect(run("TMPDIR=$HOME/x; rm -rf $TMPDIR/y")).toBe(false);
    expect(run("W=/tmp/a rm -rf $W/x")).toBe(false);
    expect(run("d=$(mktemp -d ~/foo.XXXX); rm -rf $d")).toBe(false);
    expect(run("d=$(mktemp -p ~ -d); rm -rf $d")).toBe(false);
    expect(run("d=$(ls -d ~/x*); rm -rf $d")).toBe(false);
  });

  test("rm with targets it cannot see", () => {
    expect(run("find . -name '*.tmp' | xargs -n1 rm -rf -v")).toBe(false);
    expect(run("docker exec c sh -c 'rm -f /var/www/html/x.php'")).toBe(false);
    expect(run('xargs -I{} /bin/rm -f "{}" < /tmp/list.txt')).toBe(false);
  });

  // A relative or variable-built target is the NEW capability, so it gets the
  // strict reading: nothing the shell would still expand into another path.
  test("a relative or variable target the shell would still rewrite", () => {
    expect(run('cd /tmp && xargs -I{} rm -f "{}" < list.txt')).toBe(false);
    expect(run("cd /tmp && rm -rf a/$f")).toBe(false);
    expect(run("cd /tmp && rm -rf {/etc/x,y}")).toBe(false);
    expect(run("cd /tmp && rm -rf $(cat list.txt)")).toBe(false);
    expect(run("cd /tmp && rm -rf `cat list.txt`")).toBe(false);
    expect(run("W=/tmp/a; rm -rf $W/$f")).toBe(false);
  });
});

describe("the turn's own files, inside its workspace", () => {
  const made = join(HOME_WS, "codice.txt");

  test("a file the turn created passes, by any spelling of its path", () => {
    const s = scopeWith([made]);
    expect(run("rm -f codice.txt", s)).toBe(true);
    expect(run("rm -f ./codice.txt", s)).toBe(true);
    expect(run(`rm -f ${made}`, s)).toBe(true);
    expect(run("rm -f ~/.claude/jarvis/home/codice.txt", s)).toBe(true);
    // A folder the turn created covers what is inside it, and a relative path
    // after a cd into the workspace's own subfolder is judged from there.
    const made2 = join(W, "sub", "x.sh");
    const w: PermissionScope = { workspace: W, createdByTurn: (p) => p === made2 };
    expect(run("cd sub && rm -f x.sh", w)).toBe(true);
    expect(run("rm -f x.sh", w, "sub")).toBe(true);
    expect(run("cd sub && rm -f other.sh", w)).toBe(false);
    expect(run("rm -f x.sh", w)).toBe(false); // not in the workspace root: that is another file
  });

  test("a file the turn did not create stays refused, same place, same spelling", () => {
    const s = scopeWith([made]);
    expect(run("rm -f other.txt", s)).toBe(false);
    expect(run("rm -f ~/.claude/jarvis/home/other.txt", s)).toBe(false);
    expect(run("rm -f ~/.claude/jarvis/home/MEMORY.md", s)).toBe(false);
    expect(run("rm -f ~/.claude/jarvis/home/codice.txt", scopeWith())).toBe(false);
    expect(run("rm -f ~/.claude/jarvis/home/codice.txt")).toBe(false);
  });

  test("one created file does not unlock the rest of the command", () => {
    const s = scopeWith([made]);
    expect(run("rm -f codice.txt other.txt", s)).toBe(false);
    expect(run("rm -f codice.txt ~/Projects/x", s)).toBe(false);
    expect(run("rm -rf codice.txt /Users/x/y", s)).toBe(false);
  });

  // `cat > s.sh <<EOF ...; node s.sh; rm -f s.sh` is ONE call: the file does not
  // exist when the guard looks, so the command's own text has to vouch for it.
  describe("what an earlier part of the same command creates", () => {
    const own = (cmd: string, cwd?: string) => run(cmd, { workspace: W }, cwd);

    test("a heredoc, touch, tee, cp, mkdir and a redirect, removed later in the same command", () => {
      expect(own("cat > s.sh <<'EOF'\necho hi\nEOF\nbash s.sh; rm -f s.sh")).toBe(true);
      expect(own("touch f && rm -f f")).toBe(true);
      expect(own("echo x | tee t.txt; rm -f t.txt")).toBe(true);
      expect(own("echo x | tee -a t2.txt; rm -f t2.txt")).toBe(true);
      expect(own("echo x >> new.log && rm -f new.log")).toBe(true);
      expect(own("echo x > o.txt && rm -f o.txt")).toBe(true);
      expect(own("cp existing.txt copy.txt && rm -f copy.txt")).toBe(true);
      expect(own("mkdir -p d/e && rm -rf d")).toBe(true);
      expect(own("mkdir d2 && echo x > d2/f && rm -rf d2")).toBe(true);
      expect(own("cd sub && touch x.sh && rm -f x.sh")).toBe(true);
    });

    test("a file that was already there is not made by touching or overwriting it", () => {
      expect(own("touch existing.txt && rm -f existing.txt")).toBe(false);
      expect(own("echo x > existing.txt; rm -f existing.txt")).toBe(false);
      expect(own("echo x >> existing.txt; rm -f existing.txt")).toBe(false);
      expect(own("cp sub copy.txt; mkdir -p sub && rm -rf sub")).toBe(false);
    });

    test("only what comes BEFORE the rm, and only the same path", () => {
      expect(own("rm -f later.txt; touch later.txt")).toBe(false);
      expect(own("touch a.txt && rm -f b.txt")).toBe(false);
      expect(own("touch a.txt && rm -f a.txt existing.txt")).toBe(false);
    });

    test("never outside the workspace, never through a glob or a variable", () => {
      expect(own(`touch ${tmpdir()}/x-never && echo ok`)).toBe(true); // temp is fine, no rm involved
      expect(own("touch ~/never-made.txt && rm -f ~/never-made.txt")).toBe(false);
      expect(own("touch *.png && rm -f *.png")).toBe(false);
      expect(own("touch $X && rm -f $X")).toBe(false);
    });
  });

  test("never the workspace, its parents, or a path with `..`", () => {
    const s: PermissionScope = { workspace: HOME_WS, createdByTurn: () => true };
    // A predicate that says yes to everything is the worst case of a registry
    // bug: the guard itself still refuses what is not strictly inside.
    expect(run("rm -rf /", s)).toBe(false);
    expect(run("rm -rf ~", s)).toBe(false);
    expect(run("rm -rf $HOME", s)).toBe(false);
    expect(run("rm -rf codice.txt/../../x", s)).toBe(false);
    expect(run("rm -rf ..", s)).toBe(false);
  });

  test("a created file outside the workspace is not the turn's to remove", () => {
    const s: PermissionScope = { workspace: HOME_WS, createdByTurn: () => true };
    expect(run("rm -f ~/Projects/other/x.mjs", s)).toBe(false);
    expect(run("rm -f /Users/someone/x", s)).toBe(false);
  });
});

describe("`dd` is a write, not a word", () => {
  test("the false positives that refused real work", () => {
    expect(run("for dd in a.it b.it; do echo $dd; done")).toBe(true);
    expect(run("python3 - <<'EOF'\ndd = []\nfor t in x: dd.append(t)\nEOF")).toBe(true);
    expect(run('sed -i "" \'378s/<dd className="mt-1">/<dd className="mt-2">/\' f.tsx')).toBe(true);
    expect(run("cat > /tmp/types.ts <<'EOF'\n  /** yyyy-mm-dd */\n  date: string;\nEOF")).toBe(true);
    expect(run("const dd = strokes(pp, 0.0); echo ok")).toBe(true);
  });

  test("a real dd writing under temp passes", () => {
    expect(run("dd if=/dev/zero of=/tmp/blob bs=1m count=1")).toBe(true);
    expect(run('dd if=a of="/private/tmp/x"')).toBe(true);
  });

  test("a real dd anywhere else stays refused", () => {
    for (const cmd of [
      "dd if=/dev/zero of=/dev/disk2",
      "sudo dd of=/dev/sda bs=1m",
      'ssh h "dd if=/dev/zero of=/dev/sda"',
      "dd if=x of=$DEV",
      "dd if=x of=/tmp/a of=/dev/disk2",
      "dd if=x of=/Users/me/file",
      "dd if=x of=~/file",
      "dd of=../etc/x if=y",
      "mkfs /dev/sda1",
    ]) {
      const d = decide("bash", { command: cmd }, "auto-apply");
      expect(d.allow, `must stay blocked: ${cmd}`).toBe(false);
      expect(d.allow === false && d.reason).toContain("non si annulla");
    }
  });
});

describe("everything else is exactly as before", () => {
  test("the other irreversible commands, even from inside a temp dir", () => {
    for (const cmd of [
      "cd /tmp/x && git reset --hard HEAD~3",
      "cd /tmp/x && git clean -fd",
      "cd /tmp/x && git push --force origin main",
      "cd /tmp/x && git push -f",
      "cd /tmp/x && git branch -D lavoro/x",
      "cd /tmp/x && chmod -R 777 .",
      "echo x > /dev/disk2",
    ]) {
      expect(run(cmd, scopeWith([join(HOME_WS, "x")])), `must stay blocked: ${cmd}`).toBe(false);
    }
  });

  test("a rm in a temp dir does not hide a second command", () => {
    expect(run("rm -rf /tmp/x && git reset --hard")).toBe(false);
    expect(run("rm -rf /tmp/x; rm -rf ~/y")).toBe(false);
  });

  // The strictest level stays strictest and the loosest stays loosest: the
  // scope only ever changes what `auto-apply` refuses.
  test("`ask` still refuses everything that writes, and `yolo` still allows", () => {
    const s = scopeWith([join(HOME_WS, "codice.txt")]);
    expect(decide("bash", { command: "rm -rf /tmp/x" }, "ask", s).allow).toBe(false);
    expect(decide("bash", { command: "rm -f codice.txt" }, "ask", s).allow).toBe(false);
    expect(decide("bash", { command: "touch /tmp/x" }, "ask", s).allow).toBe(false);
    expect(decide("write_file", { path: "/tmp/x" }, "ask", s).allow).toBe(false);
    expect(decide("bash", { command: "rm -rf ~/x" }, "yolo", s).allow).toBe(true);
  });

  test("with no scope at all the old calls behave as before", () => {
    expect(decide("bash", { command: "rm -rf /tmp/x" }, "auto-apply").allow).toBe(true);
    expect(decide("bash", { command: "rm -rf build" }, "auto-apply").allow).toBe(false);
    expect(decide("bash", { command: "rm nota.txt" }, "auto-apply").allow).toBe(true);
  });
});
