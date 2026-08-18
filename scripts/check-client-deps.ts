/**
 * LE DIPENDENZE DEL CLIENT CI SONO? Se no, il cancello NON HA MISURATO.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * I worktree di dispatch nascono da `git worktree add`, che copia i file
 * TRACCIATI: `client/node_modules` non e' tracciato, quindi non c'e'. Misurato
 * il 18/08: 95 worktree su 103 senza. Li' `eslint` non parte proprio, `bun run
 * lint` esce non-zero, e la card scrive `checks_state = 'fail'` — cioe' «il tuo
 * codice e' rotto, non approvare» su un ramo che spesso non ha nemmeno un
 * commit. E' il falso rosso piu' diffuso della board.
 *
 * ── Perche' un codice di uscita dedicato ────────────────────────────────────
 * `typecheck-server.ts` la distinzione la faceva gia' A PAROLE («Il typecheck
 * NON e' girato»), ma usciva 1 come un errore vero, e chi legge l'esito vede
 * solo il numero. La stessa meta'-strada che aveva il testo dei checks prima di
 * `checksVerdict`: la parola giusta e lo stato sbagliato.
 *
 * `97` e' quel numero. `runReviewChecks` lo traduce in «non misurato», e
 * `checksVerdict` lo porta a `unknown` invece che a `fail`: la card dice «check
 * non misurati» in ambra, che e' la verita', e nessuno va a cercare un guasto
 * che non c'e'.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Il codice che significa NON MISURATO. Deve restare uguale a review-checks.ts. */
export const NOT_MEASURED_EXIT = 97;

const root = new URL("..", import.meta.url).pathname;
const eslint = join(root, "client", "node_modules", ".bin", "eslint");

if (!existsSync(eslint)) {
  console.error(
    `✗ ${eslint} non c'e'.\n` +
      "  Il lint NON e' girato: senza le dipendenze del client eslint non parte.\n" +
      "  Non e' un rosso del codice — e' una misura mancante. Per averla:\n" +
      "  cd client && bun install",
  );
  process.exit(NOT_MEASURED_EXIT);
}
