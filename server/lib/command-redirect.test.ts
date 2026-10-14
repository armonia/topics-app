/**
 * The file a `run_command` sends its own stdout to, read off the command line
 * without running it (chat-live-work). On 07/10 Muse ran for 58 minutes with
 * `freeagent … > /tmp/fa-wallrunv2.log 2>&1` and its log stayed empty: the
 * output was all in that file.
 *
 * The first block is the real command lines of that chat (`/api/scripts`,
 * 07/10). The last block runs the same lines in zsh, in a scratch folder, and
 * checks that the file the parser names is the file the shell wrote: a parser
 * that only agrees with its own idea of the shell proves nothing.
 *
 * @covers CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stdoutTargetOf } from "./command-redirect";

const HOME = "/Users/someone";
const CWD = "/work/project";
const of = (command: string, cwd = CWD) => stdoutTargetOf(command, { cwd, home: HOME });

describe("the command lines of 07/10", () => {
  test("Muse: the redirect after the command substitution, not the cat inside it", () => {
    expect(of('cd /Users/someone/pop-demo && freeagent -C /Users/someone/pop-demo "$(cat /tmp/fa-wallrunv2.txt)" > /tmp/fa-wallrunv2.log 2>&1; echo "exit $?"; tail -10 /tmp/fa-wallrunv2.log'))
      .toEqual({ kind: "file", path: "/tmp/fa-wallrunv2.log", append: false });
  });

  test("a wait loop that discards pgrep's output, then the real redirect", () => {
    expect(of('cd /x && while pgrep -f "fa-clipstd.txt" >/dev/null; do sleep 30; done; echo "clip standard finito"; freeagent -C /x "$(cat /tmp/w.txt)" > /tmp/w.log 2>&1; echo "exit $?"'))
      .toEqual({ kind: "file", path: "/tmp/w.log", append: false });
  });

  test("a server, a build piped to tail, a tee whose output still reaches the log: nothing to follow", () => {
    expect(of("python3 -m http.server 8777 --bind 127.0.0.1")).toBeNull();
    expect(of("npm run build 2>&1 | tail -3")).toBeNull();
    expect(of(`tools/pc build 2>&1 | tr -d '\\r' | grep -iE "error|Result" | head -6 | tee /tmp/b.txt; grep -q "Result: Succeeded" /tmp/b.txt || { echo BUILD FALLITA; exit 1; }`)).toBeNull();
  });
});

describe("what counts as the command's stdout", () => {
  test("every spelling of a stdout redirect", () => {
    expect(of("make > out.log")).toEqual({ kind: "file", path: `${CWD}/out.log`, append: false });
    expect(of("make >out.log")).toEqual({ kind: "file", path: `${CWD}/out.log`, append: false });
    expect(of("make >> out.log")).toEqual({ kind: "file", path: `${CWD}/out.log`, append: true });
    expect(of("make 1>> /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: true });
    expect(of("make >| /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: false });
    expect(of("make &> /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: false });
    expect(of("make &>> /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: true });
    expect(of("make >& /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: false });
    expect(of("make 2>&1 > /tmp/a.log")).toEqual({ kind: "file", path: "/tmp/a.log", append: false });
    expect(of("exec > /tmp/all.log; make")).toEqual({ kind: "file", path: "/tmp/all.log", append: false });
  });

  test("stderr alone, a descriptor, /dev: the stdout still reaches the log", () => {
    expect(of("make 2> /tmp/err.log")).toBeNull();
    expect(of("make 2>>/tmp/err.log")).toBeNull();
    expect(of("make >&2")).toBeNull();
    expect(of("make 1>&2")).toBeNull();
    expect(of("make > /dev/null 2>&1")).toBeNull();
    expect(of("make &>/dev/null")).toBeNull();
    expect(of("make < input.txt")).toBeNull();
  });

  test("tee's file is followed only when tee's own output goes elsewhere", () => {
    expect(of("make | tee /tmp/t.log")).toBeNull();
    expect(of("make | tee /tmp/t.log > /dev/null")).toEqual({ kind: "file", path: "/tmp/t.log", append: false });
    expect(of("make | tee -a /tmp/t.log >/dev/null")).toEqual({ kind: "file", path: "/tmp/t.log", append: true });
  });

  test("the first file the command names wins", () => {
    expect(of("a > /tmp/one.log; b > /tmp/two.log")).toEqual({ kind: "file", path: "/tmp/one.log", append: false });
    expect(of('a > "$LOG"; b > /tmp/two.log')).toEqual({ kind: "file", path: "/tmp/two.log", append: false });
  });
});

describe("what is not a redirect", () => {
  test("quoted, escaped, commented", () => {
    expect(of('echo "a > b"')).toBeNull();
    expect(of("echo 'a > /tmp/x'")).toBeNull();
    expect(of("echo a \\> b")).toBeNull();
    expect(of("make # > /tmp/no.log")).toBeNull();
  });

  test("inside a command substitution, a backtick, a test, an arithmetic", () => {
    expect(of("x=$(make > /tmp/inner.log); echo $x")).toBeNull();
    expect(of("echo `make > /tmp/inner.log`")).toBeNull();
    expect(of('[[ "$a" > "$b" ]] && make > /tmp/m.log')).toEqual({ kind: "file", path: "/tmp/m.log", append: false });
    expect(of("(( n > 3 )) && make > /tmp/m.log")).toEqual({ kind: "file", path: "/tmp/m.log", append: false });
  });

  test("the body of a heredoc", () => {
    expect(of("cat <<'EOF'\nfoo > /tmp/bad.log\nEOF\nmake > /tmp/good.log")).toEqual({ kind: "file", path: "/tmp/good.log", append: false });
    expect(of("cat <<-EOF\n\tfoo > /tmp/bad.log\n\tEOF\nmake")).toBeNull();
  });
});

describe("where a path resolves, and when it cannot", () => {
  test("relative to the command's folder, or to a literal cd before it", () => {
    expect(of("cd sub && make > out.log")).toEqual({ kind: "file", path: `${CWD}/sub/out.log`, append: false });
    expect(of("cd /abs && make > out.log")).toEqual({ kind: "file", path: "/abs/out.log", append: false });
    expect(of("cd ~/proj; make > out.log")).toEqual({ kind: "file", path: `${HOME}/proj/out.log`, append: false });
    expect(of("make > ~/out.log")).toEqual({ kind: "file", path: `${HOME}/out.log`, append: false });
    expect(of("(cd /a && make > r.log); make > r2.log")).toEqual({ kind: "file", path: "/a/r.log", append: false });
    expect(of("(cd /a); make > r2.log")).toEqual({ kind: "file", path: `${CWD}/r2.log`, append: false });
  });

  test("a variable, a glob, a cd nobody can read: named, not followed", () => {
    expect(of('make > "$LOG"')).toEqual({ kind: "unresolved", target: "$LOG", reason: "variable" });
    expect(of("make > ${OUT}/a.log")).toEqual({ kind: "unresolved", target: "/a.log", reason: "variable" });
    expect(of("make > logs/*.log")).toEqual({ kind: "unresolved", target: "logs/*.log", reason: "pattern" });
    expect(of('cd "$DIR" && make > rel.log')).toEqual({ kind: "unresolved", target: "rel.log", reason: "cwd" });
    expect(of("cd - && make > rel.log")).toEqual({ kind: "unresolved", target: "rel.log", reason: "cwd" });
    expect(of("make > ~other/x.log")).toEqual({ kind: "unresolved", target: "~other/x.log", reason: "variable" });
  });
});

describe("the parser and zsh agree on the file", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "topics-redirect-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;

  /** Runs `command` in a fresh folder; the file the parser names must hold the marker. */
  function agrees(command: (marker: string) => string): void {
    const cwd = join(dir, `case-${++n}`);
    mkdirSync(join(cwd, "sub"), { recursive: true });
    const marker = `MARK-${n}-${Date.now()}`;
    const line = command(marker);
    const target = stdoutTargetOf(line, { cwd, home: dir });
    expect(target?.kind).toBe("file");
    const res = Bun.spawnSync(["/bin/zsh", "-c", line], { cwd, stdout: "pipe", stderr: "pipe" });
    const path = (target as { path: string }).path;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(marker);
    // And not in the log: the shell sent it to the file instead.
    expect(res.stdout.toString()).not.toContain(marker);
  }

  test.skipIf(!existsSync("/bin/zsh"))("redirects, cd, groups, tee", () => {
    agrees((m) => `echo ${m} > out.log`);
    agrees((m) => `echo ${m} >> out.log 2>&1`);
    agrees((m) => `echo ${m} &> out.log`);
    agrees((m) => `cd sub && echo ${m} > out.log`);
    agrees((m) => `(cd sub && echo ${m} > r.log); echo other`);
    agrees((m) => `{ echo ${m}; echo two; } > group.log`);
    agrees((m) => `echo ${m} | tee t.log > /dev/null`);
    agrees((m) => `x="$(echo inner)"; echo ${m} "$x" > after.log`);
  });
});
