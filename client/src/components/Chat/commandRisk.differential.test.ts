/**
 * COMMANDRISK AGAINST THE SHELL ITSELF.
 *
 * Every generated command has a twin where the destructive verb is a probe
 * script that only leaves a mark, and the twin is really run through
 * `/bin/bash -c`, `/bin/sh -c` and `/bin/zsh -c` (the shell Run uses on
 * macOS, where it is installed) in a temporary folder. Whenever a shell
 * runs the probe, commandRisk on the original must ask, with the reason the
 * verb gives; whenever the verb only sits in the text (an argument, a quoted
 * value, a comment) and no shell runs it, commandRisk must ask nothing. The
 * original is never run.
 *
 * The commands are (assignment prefixes in every quoting style, `=` and
 * `+=`, with the shell's separators inside their values) x (wrappers, one or
 * two deep: options, `--`, heredocs, here-strings, pipes into a shell, zsh's
 * precommand modifiers, procps' watch and util-linux's su) x (destructive
 * forms), drawn with a fixed seed, plus the forms the reviews found by hand.
 * Neither watch nor util-linux's su is on macOS: two stand-ins read their
 * options with Python's GNU getopt (long-name prefixes, permutation for su,
 * none for watch) and run what the real ones run, once.
 * @covers CHAT-RUN-02
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandRisk, type RiskKind } from './commandRisk';

const SHELLS = ['/bin/bash', '/bin/sh', '/bin/zsh'].filter((shell) => existsSync(shell));
const HAS_BASH = SHELLS.includes('/bin/bash');
const PYTHON = Bun.which('python3');

const root = HAS_BASH ? mkdtempSync(join(tmpdir(), 'command-risk-')) : '';
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

/**
 * procps-ng's watch (`+bcCd::eghq:n:prs:tvwx`) and util-linux's su
 * (`c:fg:G:lmpPs:hVw:`), by absolute path so `env -i` cannot fall back on the
 * system's su. watch joins its operands for `sh -c`, or runs them with `-x`;
 * su hands the shell `-c` and its command, then the words after the user.
 */
const FAKE_WATCH = root && PYTHON ? join(root, 'watch') : '';
const FAKE_SU = root && PYTHON ? join(root, 'su') : '';
if (FAKE_WATCH && FAKE_SU) {
  writeFileSync(FAKE_WATCH, `#!${PYTHON}
import getopt, os, sys
opts, args = getopt.gnu_getopt(sys.argv[1:], '+bcCdeghq:n:prs:tvwx', ['beep', 'color', 'no-color', 'differences', 'errexit',
  'chgexit', 'equexit=', 'interval=', 'precise', 'no-rerun', 'shotsdir=', 'no-title', 'no-wrap', 'exec', 'help', 'version'])
if not args: sys.exit(1)
if any(o in ('-x', '--exec') for o, _ in opts): os.execv(args[0], args)
os.execv('/bin/sh', ['sh', '-c', ' '.join(args)])
`, { mode: 0o755 });
  writeFileSync(FAKE_SU, `#!${PYTHON}
import getopt, os, sys
opts, args = getopt.gnu_getopt(sys.argv[1:], 'c:fg:G:lmpPs:hVw:', ['command=', 'session-command=', 'fast', 'group=',
  'supp-group=', 'login', 'preserve-environment', 'pty', 'shell=', 'help', 'version', 'whitelist-environment='])
command = None
for o, v in opts:
  if o in ('-c', '--command', '--session-command'): command = v
if args and args[0] == '-': args = args[1:]
args = args[1:]
os.execv('/bin/sh', ['sh'] + (['-c', command] if command is not None else []) + args)
`, { mode: 0o755 });
}
/** The watch and su wrappers, each handing a quoted command on, when the stand-ins exist. */
const LONG_OPTION_WRAPPERS: Array<(c: string) => string> = FAKE_WATCH ? [
  (c) => `${FAKE_WATCH} -q 3 ${sq(c)}`,
  (c) => `${FAKE_WATCH} --equexit 3 ${sq(c)}`,
  (c) => `${FAKE_WATCH} --int 1 ${sq(c)}`,
  (c) => `${FAKE_WATCH} -s shots -n 1 ${sq(c)}`,
  (c) => `${FAKE_WATCH} -x -q 3 sh -c ${sq(c)}`,
  (c) => `${FAKE_SU} root -c ${sq(c)}`,
  (c) => `${FAKE_SU} root -- -c ${sq(c)}`,
  (c) => `${FAKE_SU} root extra -c ${sq(c)}`,
  (c) => `${FAKE_SU} --session-command=${sq(c)}`,
  (c) => `${FAKE_SU} --comm ${sq(c)} root`,
] : [];

/** A command written with `verb` where the destructive program goes. */
type Template = (verb: string) => string;
interface Case { template: Template; kind: RiskKind | null }

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dq = (s: string) => `"${s.replace(/[\\"$`]/g, '\\$&')}"`;

/** Values of an assignment, as written: every quoting style, and separators inside the quotes. */
const VALUES = [
  'x', '"a b"', "'a b'", "$'a b'", "$'it\\'s here'", "$'don\\'t'", "$'\\''", "$'a\\'b'", '$"a b"', 'a\\ b',
  '"a; b"', '"a && b"', '"a|b c"', '"done (ok)"', '"$(printf x) y"', '"`printf x` y"', '"{a b}"', '"x\ny"',
  `'a"b'`, `"a'b"`, '"a \\" b"', "$'a\\\\'", '""', "''", '"#x"', '"a > b"',
];
const NAMES = ['A', 'GIT_SSH_COMMAND', 'MSG'];
const OPERATORS = ['=', '=', '=', '+='];

const DESTRUCTIVE: Array<[Template, RiskKind]> = [
  [(v) => `${v} -rf 'a b'`, 'rm'],
  [(v) => `${v} -rf "it's"`, 'rm'],
  [(v) => `${v} -f x\\'`, 'rm'],
  [(v) => `${v} push --force origin 'main'`, 'git-push-force'],
  [(v) => `${v} reset --hard`, 'git-reset-hard'],
  [(v) => `${v} -9 2147483646`, 'kill'],
  [(v) => `${v} -R 777 'a b'`, 'chmod-recursive'],
  [(v) => `${v} . -delete`, 'find-delete'],
];

/** The verb only as text: no shell runs it. */
const BENIGN: Template[] = [
  (v) => `echo "${v} -rf x"`,
  (v) => `printf '%s' "a; ${v} -rf x"`,
  (v) => `grep -e "${v} -rf" /dev/null`,
  (v) => `B="${v} -rf /" true`,
  (v) => `echo $'${v} -rf x'`,
  (v) => `echo hi # ${v} -rf x`,
  (v) => `echo ${v}\\ -rf x`,
  (v) => `: '${v} push --force'`,
];

const WRAPPERS: Array<(c: string) => string> = [
  (c) => c,
  (c) => `env ${c}`,
  (c) => `env -i ${c}`,
  (c) => `nohup ${c}`,
  (c) => `nice ${c}`,
  (c) => `command ${c}`,
  (c) => `exec ${c}`,
  (c) => `echo a | xargs ${c}`,
  (c) => `bash -c ${sq(c)}`,
  (c) => `bash -c ${dq(c)}`,
  (c) => `sh -c ${dq(c)}`,
  (c) => `eval ${sq(c)}`,
  (c) => `if true; then ${c}; fi`,
  (c) => `! ${c}`,
  (c) => `{ ${c}; }`,
  (c) => `(${c})`,
  (c) => `true && ${c}`,
  (c) => `false || ${c}`,
  (c) => `echo $(${c})`,
  (c) => `X=$(${c})`,
  (c) => `${c} > /dev/null 2>&1`,
  (c) => `env -P /usr/bin ${c}`,
  (c) => `env -S ${sq(c)}`,
  (c) => `exec -a name ${c}`,
  (c) => `builtin command ${c}`,
  (c) => `builtin exec ${c}`,
  (c) => `builtin eval ${sq(c)}`,
  (c) => `sh -c -- ${sq(c)}`,
  (c) => `bash -c -e ${sq(c)}`,
  (c) => `zsh -c -- ${sq(c)}`,
  (c) => `eval -- ${sq(c)}`,
  (c) => `echo a | xargs -J % ${c} %`,
  (c) => `function f { ${c}; }; f`,
  (c) => `echo ${sq(c)} | sh`,
  (c) => `printf '%s\\n' ${sq(c)} | bash`,
  (c) => `sh <<< ${sq(c)}`,
  (c) => `bash <<'EOF'\n${c}\nEOF`,
  (c) => `echo \${X:-$(${c})}`,
  (c) => `: "\${OUT:=$(${c})}"`,
  (c) => `cat > /dev/null <<EOF\ndon't\nEOF\n${c}\ncat > /dev/null <<EOF\nit's\nEOF`,
  (c) => `noglob ${c}`,
  (c) => `nocorrect ${c}`,
  (c) => `repeat 1 ${c}`,
  (c) => `coproc ${c}; wait`,
  (c) => `(- ${c})`,
  (c) => `find . -maxdepth 0 -exec sh -c ${sq(c)} \\;`,
  (c) => `find . -maxdepth 0 -execdir bash -c ${sq(c)} \\;`,
  (c) => `find . -maxdepth 0 -exec ${c} \\;`,
  (c) => `echo a | xargs -I{} sh -c ${sq(c)}`,
  ...LONG_OPTION_WRAPPERS,
];

/** mulberry32: the same draws on every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(count: number): Case[] {
  const random = seeded(1002);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const cases: Case[] = [];
  for (let n = 0; n < count; n++) {
    const prefix = Array.from({ length: Math.floor(random() * 3) }, () => `${pick(NAMES)}${pick(OPERATORS)}${pick(VALUES)} `).join('');
    const [form, kind] = random() < 0.75 ? pick(DESTRUCTIVE) : [pick(BENIGN), null];
    const outer = pick(WRAPPERS);
    const inner = random() < 0.4 ? pick(WRAPPERS) : (c: string) => c;
    cases.push({ template: (v) => outer(inner(prefix + form(v))), kind });
  }
  return cases;
}

/** The forms the reviews found by hand, each one its own case. */
const FOUND: Case[] = [
  ...["$'\\''", "$'a\\'b'"].flatMap((value) => [(v: string) => `${v} -rf 'a b'`, (v: string) => `${v} -rf x\\'`].flatMap((tail) => [
    { template: (v: string) => `A=${value} ${tail(v)}`, kind: 'rm' as const },
    { template: (v: string) => `env A=${value} ${tail(v)}`, kind: 'rm' as const },
  ])),
  { template: (v) => `A=$'don\\'t' ${v} -rf 'my dir'`, kind: 'rm' },
  { template: (v) => `bash -c "A=\\"x y\\" ${v} -rf x"`, kind: 'rm' },
  { template: (v) => `sh -c "GIT_SSH_COMMAND=\\"ssh -i k\\" ${v} push --force"`, kind: 'git-push-force' },
  { template: (v) => `env -i "A=x y" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A=$'it\\'s here' ${v} -rf x`, kind: 'rm' },
  { template: (v) => `MSG="done (ok)" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A="a; b" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A="$(date) x" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A="\`date\` x" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A="{a b}" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A="one\ntwo" ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A=a\\ b ${v} -rf x`, kind: 'rm' },
  { template: (v) => `A+=1 ${v} -rf x`, kind: 'rm' },
  { template: (v) => `env A+=1 ${v} -rf x`, kind: 'rm' },
  { template: (v) => `GIT_SSH_COMMAND+=" -v" ${v} push --force origin main`, kind: 'git-push-force' },
  { template: (v) => `function cleanup { ${v} -rf x; }; cleanup`, kind: 'rm' },
  { template: (v) => `cat > a.md <<EOF\nDon't edit\nEOF\n${v} -rf build\ncat > b.md <<EOF\nIt's generated\nEOF`, kind: 'rm' },
  { template: (v) => `echo \${X:-$(${v} -rf x)}`, kind: 'rm' },
  { template: (v) => `: "\${OUT:=$(${v} -rf x)}"`, kind: 'rm' },
  { template: (v) => `env -S '${v} -rf x'`, kind: 'rm' },
  { template: (v) => `env -P /usr/bin ${v} -rf x`, kind: 'rm' },
  { template: (v) => `exec -a name ${v} -rf x`, kind: 'rm' },
  { template: (v) => `builtin command ${v} -rf x`, kind: 'rm' },
  { template: (v) => `builtin exec ${v} -rf x`, kind: 'rm' },
  { template: (v) => `builtin eval '${v} -rf x'`, kind: 'rm' },
  ...['sh', 'bash', 'zsh'].map((shell) => ({ template: (v: string) => `${shell} -c -- '${v} -rf x'`, kind: 'rm' as const })),
  { template: (v) => `bash -c -e '${v} -rf x'`, kind: 'rm' },
  { template: (v) => `eval -- '${v} -rf x'`, kind: 'rm' },
  { template: (v) => `echo a | xargs -J % ${v} -rf %`, kind: 'rm' },
  { template: (v) => `echo a | xargs -R 1 -I % ${v} -rf %`, kind: 'rm' },
  { template: (v) => `echo '${v} -rf x' | sh`, kind: 'rm' },
  { template: (v) => `printf '%s\\n' '${v} reset --hard' | bash`, kind: 'git-reset-hard' },
  { template: (v) => `sh <<< '${v} -rf x'`, kind: 'rm' },
  { template: (v) => `zsh -s <<< '${v} -9 2147483646'`, kind: 'kill' },
  { template: (v) => `noglob ${v} -rf x`, kind: 'rm' },
  { template: (v) => `nocorrect ${v} -rf x`, kind: 'rm' },
  { template: (v) => `repeat 1 ${v} -rf x`, kind: 'rm' },
  { template: (v) => `coproc ${v} -rf x; wait`, kind: 'rm' },
  { template: (v) => `(- ${v} -9 2147483646)`, kind: 'kill' },
  { template: (v) => `{${v},-rf,x}`, kind: 'rm' },
  { template: (v) => `find . -maxdepth 0 -exec sh -c '${v} -rf {}' \\;`, kind: 'rm' },
  { template: (v) => `find . -maxdepth 0 -execdir bash -c '${v} -rf "$1"' _ {} \\;`, kind: 'rm' },
  { template: (v) => `find . -maxdepth 0 -exec ${v} -rf {} +`, kind: 'rm' },
  { template: (v) => `find . -maxdepth 0 -exec true \\; -exec ${v} -rf {} \\;`, kind: 'rm' },
  { template: (v) => `echo a | xargs -I{} sh -c '${v} -rf {}'`, kind: 'rm' },
  { template: (v) => `find . -maxdepth 0 -exec sh -c 'echo ${v} -rf {}' \\;`, kind: null },
  { template: (v) => `find . -maxdepth 0 -exec echo ${v} -rf {} \\;`, kind: null },
  { template: () => 'FOO="a b" ls', kind: null },
  { template: (v) => `git commit -m "$(cat <<'EOF'\nDon't call ${v} -rf here\nEOF\n)"`, kind: null },
  { template: (v) => `cat > clean.sh <<'EOF'\n${v} -rf dist\nEOF`, kind: null },
  { template: (v) => `git commit -m "${v} -rf x"`, kind: null },
  { template: (v) => `echo "${v} push --force"`, kind: null },
  { template: (v) => `env A="${v} -rf /" true`, kind: null },
  { template: (v) => `grep -e "${v} -rf" /dev/null`, kind: null },
  { template: (v) => `printf '%s' "a; ${v} -rf x"`, kind: null },
  ...(FAKE_WATCH ? [
    { template: (v: string) => `${FAKE_WATCH} -q 3 ${v} -rf x`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_WATCH} --equexit 3 ${v} -rf x`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_WATCH} --int 1 ${v} -rf x`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_WATCH} -n1 -q 3 -x ${v} -rf x`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_WATCH} --ex ${v} push --force`, kind: 'git-push-force' as const },
    { template: (v: string) => `${FAKE_SU} root -- -c '${v} -rf x'`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_SU} root extra -c '${v} -rf x'`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_SU} --session-command='${v} -rf x'`, kind: 'rm' as const },
    { template: (v: string) => `${FAKE_SU} --comm='${v} reset --hard'`, kind: 'git-reset-hard' as const },
    { template: (v: string) => `${FAKE_SU} -s /bin/sh root -- -lc '${v} -9 2147483646'`, kind: 'kill' as const },
    { template: (v: string) => `${FAKE_WATCH} -q 3 echo ${v} -rf x`, kind: null },
    { template: (v: string) => `${FAKE_SU} root -- -c 'echo ${v} -rf x'`, kind: null },
  ] : []),
];

/** The verb each destructive kind is written with in the original. */
const VERB: Record<string, string> = {
  rm: 'rm', 'git-push-force': 'git', 'git-reset-hard': 'git', kill: 'kill', 'chmod-recursive': 'chmod', 'find-delete': 'find',
};

/** Runs the twin of `c` through every shell; true for each shell that ran the probe. */
async function runTwin(c: Case, n: number): Promise<boolean[]> {
  return Promise.all(SHELLS.map(async (shell, s) => {
    const dir = join(root, `${n}-${s}`);
    mkdirSync(dir);
    const probe = join(dir, 'probe');
    const mark = join(dir, 'ran');
    // Absolute paths and a builtin only: `env -i` leaves no PATH.
    writeFileSync(probe, `#!/bin/sh\necho ran >> ${mark}\n`, { mode: 0o755 });
    const child = Bun.spawn([shell, '-c', c.template(probe)], { cwd: dir, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await child.exited;
    clearTimeout(timer);
    return existsSync(mark);
  }));
}

describe.skipIf(!HAS_BASH)('commandRisk against what bash and sh really run', () => {
  test('a probe the shell runs is always asked about, a verb that is only text never', async () => {
    const cases = [...FOUND, ...generate(300)];
    const ran: boolean[][] = [];
    for (let at = 0; at < cases.length; at += 16) {
      ran.push(...await Promise.all(cases.slice(at, at + 16).map((c, k) => runTwin(c, at + k))));
    }
    const wrong: Array<{ command: string; ranIn: string[]; asked: RiskKind[] }> = [];
    let executed = 0;
    let benign = 0;
    cases.forEach((c, n) => {
      const command = c.template(c.kind ? VERB[c.kind]! : 'rm');
      // su asks `sudo` whatever its shell runs: the probe tells only about the verb.
      const asked: RiskKind[] = commandRisk(command).confirm.map((r) => r.kind).filter((k) => k !== 'placeholder' && k !== 'sudo');
      const ranIn = SHELLS.filter((_, s) => ran[n]![s]);
      if (ranIn.length) {
        executed++;
        if (!c.kind || !asked.includes(c.kind)) wrong.push({ command, ranIn, asked });
      } else if (!c.kind) {
        benign++;
        if (asked.length) wrong.push({ command, ranIn, asked });
      }
    });
    expect(wrong).toEqual([]);
    // The generator is worth something only if both directions are exercised.
    expect(executed).toBeGreaterThan(100);
    expect(benign).toBeGreaterThan(30);
  }, 60_000);
});
