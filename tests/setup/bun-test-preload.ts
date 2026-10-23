/**
 * Il timeout di default dei test, alzato per chi lancia `bun test` a mano.
 *
 * IL GUASTO. `bun test` da' 5 secondi a ogni test. Sono pochi per i 29 file che
 * costruiscono un repo git di prova e ci lanciano dentro dei processi: a
 * macchina scarica `migration-timestamp-naming` chiude in ~2s, ma sotto carico
 * il solo `git add -A` supera i 5s e il test muore con «Command failed: git add
 * -A». Misurato l'11/08 sui 30 file che spawnano: a load 91 ne cadono due
 * (`check-emdash` a 5,0s e `worktree-gc-free-checkout` a 6,7s), e il rosso non
 * arriva a chi ha rotto qualcosa. Arriva addosso alla card che stava girando.
 *
 * PERCHE' NON UN NUMERO NEI 29 FILE. Il criterio «questo file lancia un
 * subprocess?» vale gia' per 29 file su ~180, e il trentesimo che nasce domani
 * se lo dimenticherebbe. Il numero deve stare in un posto solo.
 *
 * QUANTO COPRE QUESTO FILE, misurato su bun 1.3.8 e non intuitivo:
 * il preload gira UNA VOLTA per corsa, non una per file, e `setDefaultTimeout`
 * vale solo per il file che bun sta caricando in quel momento. Con tre file da
 * 7s e il preload a 30s ne passa UNO e gli altri due muoiono «after 5000ms».
 * Quindi:
 *   · `bun test tests/unit/qualcosa.test.ts` (UN file, il modo in cui l'header
 *     di decine di test dice di lanciarli, ed e' come si fa il triage di un
 *     rosso) → coperto da qui;
 *   · la suite intera (`bun run test:unit`, e quindi anche la CI e i check
 *     pre-review) → NON coperta da qui. La copre `--timeout` sulla riga di
 *     comando dello script in package.json, che e' l'unica leva che vale per
 *     tutti i file.
 * Non e' ridondanza: sono le due meta' della stessa copertura. Chi toglie una
 * delle due riapre meta' del guasto, e in silenzio.
 *
 * QUELLO CHE NON PROVA A FARE. `[test] timeout = N` in bunfig.toml non esiste:
 * bun lo accetta senza protestare e lo ignora, il test cade lo stesso «after
 * 5000ms». Non esiste nemmeno una variabile d'ambiente sua. Provati e scartati
 * anche `beforeAll` e `beforeEach` registrati da qui (il timeout e' gia' fisso
 * quando girano) e un `Bun.plugin` con `onLoad` sui `*.test.ts` (errore a ogni
 * file). Restano queste due leve, e sono queste.
 *
 * TIMEOUT SCRITTI SUL SINGOLO TEST: vincono sempre, sia in su (i 45s di
 * `browser-dom-cobrowse`) sia in giu' (i 5s voluti di `browser-state-store`).
 * Misurato. Questo numero e' un default, non un tetto.
 *
 * LA MANOPOLA e' `TOPICS_TEST_TIMEOUT_MS`, e muove entrambe le leve: la legge
 * questo file e la legge lo script in package.json. Serve perche' `bun test
 * --timeout N` qui non basta piu': bun applica il flag PRIMA dei preload,
 * quindi sul primo file questa riga glielo sovrascrive comunque.
 *
 * UN LIMITE, misurato: bunfig.toml bun lo legge dalla CWD e basta, non risale
 * l'albero. `bun test` lanciato da dentro `client/` torna a 5 secondi.
 *
 * La guardia che tiene insieme tutto questo, numeri compresi, e'
 * `tests/unit/test-default-timeout.test.ts`.
 */
import { afterAll, beforeEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireSlot, claimOutfile, slotCount, alreadyHeld, GATE_HELD_ENV } from "../../scripts/gate-slot.ts";
import { stopOwnAiBridges } from "../../scripts/stray-ai-bridges.ts";
import { removeFinishedTestTmpDirs, PRIVATE_SCRATCH_ENV } from "./test-tmp-dirs.ts";
import { GIT_ISOLATION_MARKER, gitIsolationEnv } from "./git-isolation";

/**
 * THE TEMP FOLDER OF A TEST PROCESS IS ITS OWN, AND GOES WITH IT.
 *
 * Tests make scratch folders with `mkdtemp(join(tmpdir(), ...))` and a lot of
 * them never remove what they made: on 23/10/2026 the owner's `$TMPDIR` held
 * ~11,000 `topics-cred*`, 4,800 `topics*` and 3,500 `tracker-home*` / `import*`
 * from test runs, and 54 files were still doing it when counted. Asking every
 * test to clean up is one defence per file, downstream of the leak and never
 * finished. Here the process gets a private `TMPDIR` for its whole life and
 * the preload removes it at the end, so whatever a test leaves "in the temp
 * folder" is inside a folder that goes away: nothing new stays in `$TMPDIR`
 * after a `bun test` run, whoever started it.
 *
 * NOT WHEN THE RUNNER ALREADY GAVE THIS FILE ONE (`PRIVATE_SCRATCH_ENV`): it
 * removes it itself, and a second level would only lengthen the paths - a unix
 * socket made under `tmpdir()` has 104 characters on macOS, and the Mac's
 * `$TMPDIR` already uses half of them.
 *
 * WHAT IT DOES NOT COVER: a hard-coded path (`testTmpDir` has its own sweep
 * below, the CI run checks the rest), and a process killed before the end,
 * which leaves ONE folder named after its pid instead of thousands.
 */
let ownTmpDir: string | null = null;
if (!process.env[PRIVATE_SCRATCH_ENV]) {
  ownTmpDir = mkdtempSync(join(tmpdir(), "topics-tt-"));
  process.env.TMPDIR = ownTmpDir;
}

/**
 * THE USER'S OWN SECRETS STAY OUT OF THE SUITE. Unset, any test that builds an
 * app context or checks agent auth reads the real `~/.openclaw/openclaw.json`
 * (whose gateway token is a Keychain reference: the real resolver would run)
 * and the real `~/.topics/daemon-state.json`. A path that does not exist is
 * enough: nothing is read, nothing resolved. Only when the runner chose none;
 * a test that needs a home of its own still sets one.
 */
process.env.OPENCLAW_CONFIG_PATH ||= join(tmpdir(), `topics-test-no-openclaw-${process.pid}`, "openclaw.json");
process.env.TOPICS_HOME ||= join(tmpdir(), `topics-test-no-home-${process.pid}`);

/**
 * 30s: sei volte il default di bun. Il numero e' una misura, non un gusto. Col
 * reporter junit sui 30 file che spawnano, a load 164 su 12 core, il test piu'
 * lento fra quelli che dipendono dal default sta a 3,32s; i due sopra i 10s
 * (`ai-bridge`) hanno gia' un timeout loro di 20s. Trenta e' nove volte il caso
 * peggiore misurato, ed e' largo apposta: la macchina di un altro sara' piu'
 * lenta di questa. Sbagliare in eccesso costa 30s per dire che un test e'
 * appeso invece di 5. Sbagliare in difetto costa un rosso finto sulla card di
 * qualcun altro, che e' il guasto da cui nasce questo file.
 *
 * Se cambia, cambia anche negli script `test:*` di package.json: la guardia
 * pretende che i due numeri siano lo stesso numero.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/** La manopola, uguale in package.json. */
export const TIMEOUT_ENV_VAR = "TOPICS_TEST_TIMEOUT_MS";

/**
 * Dove il preload lascia il numero che ha davvero applicato.
 *
 * Non e' un vezzo: e' l'unico modo che ha un test di sapere se questo modulo e'
 * stato preloadato davvero in QUESTO processo. Se la guardia lo importasse per
 * leggerlo, l'import stesso lo scriverebbe e il test sarebbe verde anche col
 * preload staccato da bunfig. Per questo la guardia legge la chiave a mano.
 */
export const TIMEOUT_MARKER = "__topicsDefaultTestTimeoutMs";

const fromEnvironment = Number(process.env[TIMEOUT_ENV_VAR]);
const applicato = Number.isFinite(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : DEFAULT_TEST_TIMEOUT_MS;

setDefaultTimeout(applicato);
(globalThis as Record<string, unknown>)[TIMEOUT_MARKER] = applicato;

/**
 * THE MACHINE'S GIT HOOKS STAY OUT OF THE TESTS.
 *
 * Seventeen test files build a real git repo and make 46 commits inside them
 * in total. None of them passed an environment: they inherited the global
 * config of whoever was running, hooks included.
 *
 * This is not theory. On this machine `core.hooksPath` points at a
 * third-party `prepare-commit-msg` that on every commit fires two
 * `curl --max-time 2` at `localhost:3333` — the port of the Topics server.
 * Measured on 24/08: 380ms per commit against 160ms, i.e. 220ms thrown away
 * every time, about ten seconds per run. And when that port answers slowly
 * instead of refusing straight away, curl's 2s timeouts add up until the test
 * overruns and dies.
 *
 * The symptom was the worst one available: a red that showed up ONLY in the
 * whole suite and never on the files run alone, with the error «this test
 * timed out after 5000ms» on a different test every time. It looked as though
 * the tests were colliding with each other; it was the machine getting in.
 * A test that runs on real git has to bring its own git, not the one belonging
 * to whoever runs it.
 *
 * A LIMIT OF BUN, measured and not workable around from here: `Bun.spawnSync`
 * does NOT inherit the variables added to `process.env` at runtime. Verified:
 * a variable written here reaches `process.env` but the child sees it empty,
 * while passing `env: process.env` to the spawn does get it through. So this
 * preload is NOT enough on its own: it prepares the right environment, and
 * whoever launches git has to pass it. So as not to repeat the same line in
 * seventeen files, `gitEnv()` below is used.
 *
 * `commit.gpgsign=false` for the same reason: whoever signs their commits must
 * not be asked for the passphrase by a test suite, which then hangs until the
 * timeout.
 *
 * It does NOT touch the user's config: these are environment variables of this
 * process and they die with it.
 *
 * IT COVERS THE WHOLE RUN, unlike the timeout above. The preload runs only
 * once per run: `setDefaultTimeout` applies only to the file bun is loading at
 * that moment (see the timeout's comment, measured), but environment variables
 * are written on the PROCESS and they stay. Verified on two files in the same
 * run: both see `core.hooksPath` isolated.
 *
 * THE IDENTITY (`user.name` / `user.email`) DOES NOT GO IN HERE, and the first
 * version had put it there, breaking two tests.
 * `server/lib/git-identity.test.ts` simulates a machine WITHOUT an identity to
 * prove the fallback that unblocks the land: it does so with a fake
 * `GIT_CONFIG_GLOBAL` and `user.useConfigOnly`. The keys passed through
 * `GIT_CONFIG_*` beat that file, so an identity put here made the condition
 * impossible to simulate and the green test turned red — masking, on top of
 * that, a real fault: the commit that on a runner with no identity exits 128.
 *
 * The rule that follows: in here we take out of the way what the machine ADDS
 * to the tests (hooks, signature), we do not add what a test might need.
 * Whoever needs an identity passes it themselves, which is also the only way
 * to be able to prove its absence.
 */
function isolateGitFromEnvironment(): void {
  // The pairs and the appending live in `git-isolation.ts`, because
  // `scripts/slot.ts` applies the same ones BEFORE `bun test` starts: there
  // they are inherited by every git child for free, here they are the fallback
  // for whoever runs `bun test <file>` by hand, and two copies of the rule
  // would drift.
  Object.assign(process.env, gitIsolationEnv(process.env));
}

/**
 * Was the isolation ALREADY in the environment this process was born with?
 *
 * Read BEFORE applying it, because applying it sets the same marker and after
 * that the two cases are indistinguishable. It is the difference between the
 * two launch paths, and a test that wants to say something true about a git
 * call WITHOUT `env` has to know which one it is in:
 *
 *   true  -> `bun run test:unit` (and CI): the runner put the isolation in the
 *            birth environment, so every git child inherits it for free.
 *   false -> `bun test <file>` by hand: only this preload ran, it writes at
 *            runtime, and Bun does not pass that to a child. There `env:
 *            gitEnv()` is the only thing that carries the isolation.
 */
export const GIT_ISOLATION_INHERITED = process.env[GIT_ISOLATION_MARKER] === "1";

isolateGitFromEnvironment();

/**
 * The environment to pass to a `Bun.spawnSync(["git", ...])` inside a test.
 *
 * It exists because of the limit above: the variables set by the preload do
 * not reach child processes on their own. Whoever launches git in the tests
 * writes `{ env: gitEnv() }` and carries the isolation along without having to
 * know about it.
 *
 * It accepts additions for the cases that need a variable of their own, so
 * nobody is forced to rebuild `process.env` by hand and lose git's keys along
 * the way.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...extra };
}

/**
 * THE GATE SEMAPHORE, TAKEN FROM INSIDE THE RUN AND NOT ONLY BY THE SCRIPT.
 *
 * THE HOLE. `scripts/slot.ts` wraps `test:unit`, `typecheck`, `lint` and
 * `check:deadcode`, so `bun run test:unit` counts against a machine-wide slot.
 * But the brake was in the SCRIPT: whoever typed the underlying command walked
 * straight past it. Measured on 2026-08-27 at 02:40, with the board declaring a
 * cap of one agent: loadavg 52.9 on 12 cores, 90 node/bun processes, and TWO
 * full `bun test` runs alive together from the SAME worktree - 12 min 54 s and
 * about 4 min old - each launched by hand as `bun test --timeout 30000 ...`.
 * Neither had ever seen a slot.
 *
 * bun loads this file for EVERY `bun test` started in this repository, which is
 * the one place below the scripts that every entrance goes through. So the slot
 * is taken here too, and `bun run test:unit` no longer has a privileged door:
 * it has the same door, taken one step earlier by the wrapper.
 *
 * WHY IT DOES NOT DEADLOCK AGAINST ITSELF. The wrapper marks the environment of
 * what it launches (`TOPICS_GATE_HELD`), so the suite it started does not queue
 * for a SECOND slot behind its own parent - which with a single free slot would
 * be a wait that never ends. A test that spawns a child `bun test` passes
 * `process.env` along and the child inherits the same cover.
 *
 * IT FAILS OPEN like the rest of the semaphore, and the wait is bounded: past
 * the deadline it runs unthrottled rather than holding a suite for ever.
 */
function holdGateSlot(): void {
  if (alreadyHeld()) return;
  const slots = slotCount();
  if (slots <= 0) return;
  const release = acquireSlot(slots, "bun test");
  // The cover is written even when the wait gave up: what it says is "this
  // process tree has already been through the semaphore", not "it won".
  process.env[GATE_HELD_ENV] = "bun test";
  if (!release) return;
  process.on("exit", () => release());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { release(); process.exit(1); });
  }
}

/**
 * A RUN NOBODY IS WAITING FOR STILL HAS AN END.
 *
 * Third half of the same measurement: both runs had been started with `nohup
 * ... &`, so they were orphans of the turn that launched them. When the turn
 * ends or is checkpointed, that suite keeps eating the machine and no longer
 * has anybody reading its result. `slot.ts` already caps what IT launches; a
 * run that never went through the wrapper had no cap at all, and this gives it
 * one from the inside. Same knob, same exit code as `timeout(1)`.
 *
 * `unref` so the cap never keeps a healthy run alive one millisecond longer
 * than its own work: it fires only if the process is still there.
 */
function boundOwnRuntime(): void {
  const raw = process.env.TOPICS_GATE_MAX_RUN_MS;
  const parsed = raw == null || raw === "" ? 60 * 60_000 : Number(raw);
  const capMs = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 60 * 60_000;
  if (capMs <= 0) return;
  setTimeout(() => {
    console.error(`[slot] bun test: ${Math.round(capMs / 60_000)} min of wall clock without finishing - giving up (exit 124).`);
    process.exit(124);
  }, capMs).unref();
}

/**
 * TWO RUNS SHALL NOT REPORT INTO THE SAME FILE.
 *
 * The other half of what was measured: both of those runs carried
 * `--reporter=junit --reporter-outfile=/tmp/unit.xml`, a path that appears
 * nowhere in this repository - whoever wrote the command invented it. The
 * second run overwrites the first, and whoever reads that file reads a verdict
 * that may belong to another run: a gate that promotes or fails a delivery on
 * somebody else's result is worse than one that is merely slow.
 *
 * The sanctioned way to get junit out of the unit suite is `bun run
 * test:unit:junit`, which derives a path per run and cannot collide. This is
 * the guard for everything else: the claim on the absolute path is exclusive
 * for as long as the run is ALIVE, and a second live run on the same path is
 * refused loudly instead of quietly overwriting. It is the ONE place in the
 * semaphore that does not fail open - here "open" means exactly the corruption
 * being measured.
 *
 * WHY IT READS THE PROCESS COMMAND LINE. `process.argv` inside a preload holds
 * the test FILES and not the flags (verified on bun 1.3.8: it is
 * `[bun, <file>]`), so the flag is unreadable from the runtime. The kernel has
 * it: `/proc/self/cmdline` on Linux, `ps` everywhere else. If neither answers,
 * no claim is made and the run goes ahead.
 */
const OUTFILE_CONFLICT_EXIT_CODE = 125;

function ownCommandLine(): string {
  try {
    if (process.platform === "linux") {
      return readFileSync("/proc/self/cmdline", "utf8").split("\0").join(" ");
    }
    if (process.platform === "win32") return "";
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(process.pid)]);
    return new TextDecoder().decode(r.stdout);
  } catch { return ""; }
}

/** The flag as bun accepts it, in both shapes: `--flag=path` and `--flag path`. */
export function reporterOutfileOf(commandLine: string): string | null {
  const m = /--reporter-outfile[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(commandLine);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, "");
  return raw === "" ? null : raw;
}

function claimOwnOutfile(): void {
  const path = reporterOutfileOf(ownCommandLine());
  if (!path) return;
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const release = claimOutfile(absolute);
  if (!release) {
    console.error(
      `[slot] bun test: another live run is already writing ${absolute}.\n` +
      "       Two runs on one output file mean one verdict overwrites the other, and\n" +
      "       whoever reads that file can be reading somebody else's run.\n" +
      "       Use `bun run test:unit:junit`, which derives one path per run.",
    );
    process.exit(OUTFILE_CONFLICT_EXIT_CODE);
  }
  process.on("exit", () => release());
}

/**
 * THE AI-BRIDGE DAEMONS THIS PROCESS STARTED GO WITH IT.
 *
 * A test that drives the real claude-code provider makes the client spawn a
 * detached daemon, and a detached daemon outlives its parent by design.
 * Measured on 25/09: seven left behind per round of one card's tests, some
 * still alive twelve hours later. Each file that starts one stops it in its
 * `afterAll` (stopOwnAiBridges in scripts/stray-ai-bridges.ts). This is the net
 * under them.
 *
 * At the end of the run it stops every daemon whose `--parent-pid` is this
 * process. An `afterAll`, not `process.on("exit")`: measured on bun 1.3.8, an
 * exit handler never runs when `bun test` finishes on its own.
 *
 * For a run killed outright, where no handler runs, a daemon spawned from here
 * gives up 15s after its parent dies instead of 90s. The 90s exist so a
 * restarting SERVER finds its CLIs alive. The parent here is `bun test`
 * itself, and nothing reconnects to a dead test run's socket. A test that
 * exercises the grace sets its own value, which wins.
 */
export const TEST_ORPHAN_GRACE_MS = "15000";

function retireOwnAiBridges(): void {
  process.env.TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS ??= TEST_ORPHAN_GRACE_MS;
  afterAll(stopOwnAiBridges);
}

/**
 * A `testTmpDir` ROOT GOES WITH THE FILE THAT MADE IT.
 *
 * The helper used to remove its roots on `process.on("exit")`, which `bun test`
 * never calls: on 28/09 `/tmp/topics-test` held 76,579 directories and 36 GB
 * and the disk was full. The preload is the only code that sees every file
 * boundary, so the sweep lives here: before each test it removes the roots of
 * files that are over (all their hooks have run), and after the last file it
 * removes the rest. Registered last, so the daemons above are stopped before
 * their sockets' folders go. Why not an `afterAll` in the helper, and the one
 * root that waits: `tests/setup/test-tmp-dirs.ts`.
 */
function sweepTestTmpDirs(): void {
  beforeEach(() => removeFinishedTestTmpDirs(Bun.main));
  afterAll(() => {
    removeFinishedTestTmpDirs(null);
    if (ownTmpDir) rmSync(ownTmpDir, { recursive: true, force: true });
  });
}

claimOwnOutfile();
holdGateSlot();
boundOwnRuntime();
retireOwnAiBridges();
sweepTestTmpDirs();
