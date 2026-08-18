/**
 * Worker lanciato da auth-lock.test.ts — NON un test autonomo.
 *
 * Chiama getAccessToken() e stampa il token su stdout. HOME e
 * OAUTH_TOKEN_URL_OVERRIDE sono impostate dal processo padre.
 *
 * Il suffisso `.fixture.ts` segue la convenzione del progetto:
 * `server/**\/*.fixture.ts!` in knip.jsonc dichiara questi file come
 * entrypoint lanciati con Bun.spawn dai test (nessun import li raggiunge).
 * Come si lancia: `bun server/providers/native/auth-lock-worker.fixture.ts`
 */
import { getAccessToken } from "./auth";

const token = await getAccessToken();
if (!token) {
  process.stderr.write("nessun token\n");
  process.exit(1);
}
process.stdout.write(token + "\n");
