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
 * GLI HOOK GIT DELLA MACCHINA RESTANO FUORI DAI TEST.
 *
 * Diciassette file di test costruiscono un repo git vero e ci fanno dentro 46
 * commit in tutto. Nessuno di loro passava un ambiente: ereditavano la config
 * globale di chi eseguiva, hook compresi.
 *
 * Non e' teoria. Su questa macchina `core.hooksPath` punta a un
 * `prepare-commit-msg` di terze parti che a ogni commit fa due
 * `curl --max-time 2` verso `localhost:3333` — la porta del server di Topics.
 * Misurato il 24/08: 380ms per commit contro 160ms, cioe' 220ms buttati ogni
 * volta, una decina di secondi a corsa. E quando quella porta risponde lenta
 * invece di rifiutare subito, i 2s di timeout per curl si sommano finche' il
 * test sfora e muore.
 *
 * Il sintomo era il peggiore possibile: un rosso che compariva SOLO nella
 * suite intera e mai sui file da soli, con l'errore «this test timed out after
 * 5000ms» su un test diverso ogni volta. Sembrava che i test collidessero fra
 * loro; era invece la macchina che entrava dentro. Un test che gira su git
 * vero deve portarsi il proprio git, non quello di chi lo esegue.
 *
 * UN LIMITE DI BUN, misurato e non aggirabile da qui: `Bun.spawnSync` NON
 * eredita le variabili aggiunte a `process.env` a runtime. Verificato: una
 * variabile scritta qui arriva a `process.env` ma il figlio la vede vuota,
 * mentre passando `env: process.env` alla spawn arriva. Quindi questo preload
 * NON basta da solo: prepara l'ambiente giusto, e chi lancia git deve
 * passarlo. Per non ripetere la stessa riga in diciassette file, si usa
 * `gitEnv()` qui sotto.
 *
 * `commit.gpgsign=false` per lo stesso motivo: chi firma i commit non deve
 * vedersi chiedere la passphrase da una suite di test, che poi resta appesa
 * fino al timeout.
 *
 * NON tocca la config dell'utente: sono variabili d'ambiente di questo
 * processo e muoiono con lui.
 */
function isolaGitDaAmbiente(): void {
  // `GIT_CONFIG_COUNT` + le coppie chiave/valore: la via ufficiale per
  // imporre config a git senza scrivere su nessun file.
  const coppie: Array<[string, string]> = [
    // NON la stringa vuota: git la risolve come percorso RELATIVO al repo e
    // finisce per usare `<repo>/.git/hooks`, cioe' esattamente gli hook che
    // volevamo evitare. Verificato con `git config --get core.hooksPath` in un
    // processo figlio: tornava `/Users/.../topics-app/.git/hooks`. Serve un
    // percorso assoluto che non esiste: git non trova nulla e non esegue nulla.
    ["core.hooksPath", "/nonexistent/topics-test-hooks"],
    ["commit.gpgsign", "false"],
    // Un repo di prova non ha bisogno di sapere chi lo committa, ma git si
    // rifiuta di committare se non glielo si dice.
    ["user.name", "Topics Test"],
    ["user.email", "test@topics.invalid"],
  ];
  // Non si sovrascrive un conteggio gia' impostato da chi ci ha lanciati:
  // si accoda, altrimenti gli si buttano via le sue chiavi.
  const gia = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  const base = Number.isFinite(gia) && gia > 0 ? gia : 0;
  coppie.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${base + i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${base + i}`] = v;
  });
  process.env.GIT_CONFIG_COUNT = String(base + coppie.length);
}

isolaGitDaAmbiente();

/**
 * L'ambiente da passare a un `Bun.spawnSync(["git", ...])` dentro un test.
 *
 * Esiste per il limite qui sopra: le variabili impostate dal preload non
 * arrivano da sole ai processi figli. Chi lancia git nei test scrive
 * `{ env: gitEnv() }` e si porta dietro l'isolamento senza doverlo conoscere.
 *
 * Accetta aggiunte per i casi che hanno bisogno di una variabile propria,
 * cosi' nessuno e' costretto a ricostruire `process.env` a mano e a perdere
 * per strada le chiavi di git.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...extra };
}
