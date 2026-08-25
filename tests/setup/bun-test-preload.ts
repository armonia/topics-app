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
import { setDefaultTimeout } from "bun:test";

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

const daAmbiente = Number(process.env[TIMEOUT_ENV_VAR]);
const applicato = Number.isFinite(daAmbiente) && daAmbiente > 0 ? daAmbiente : DEFAULT_TEST_TIMEOUT_MS;

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
  // `GIT_CONFIG_COUNT` + the key/value pairs: the official way to impose
  // config on git without writing to any file.
  const pairs: Array<[string, string]> = [
    // NOT the empty string: git resolves it as a path RELATIVE to the repo and
    // ends up using `<repo>/.git/hooks`, i.e. exactly the hooks we wanted to
    // avoid. Verified with `git config --get core.hooksPath` in a child
    // process: it answered `/Users/.../topics-app/.git/hooks`. What is needed
    // is an absolute path that does not exist: git finds nothing and runs
    // nothing.
    ["core.hooksPath", "/nonexistent/topics-test-hooks"],
    ["commit.gpgsign", "false"],
  ];
  // A count already set by whoever launched us is not overwritten: we append,
  // otherwise their keys get thrown away.
  const already = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  const base = Number.isFinite(already) && already > 0 ? already : 0;
  pairs.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${base + i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${base + i}`] = v;
  });
  process.env.GIT_CONFIG_COUNT = String(base + pairs.length);
}

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
