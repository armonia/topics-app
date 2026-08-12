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
