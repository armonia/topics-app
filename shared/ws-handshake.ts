/**
 * v3 foundations WS-02 — Schema-stable WebSocket handshake. CANONICO.
 *
 * Fino al 29/07 questo file esisteva DUE volte (`server/schemas/` e
 * `client/src/schemas/`), con in cima un commento "KEEP IN SYNC" — cioè la
 * sincronia affidata alla buona volontà di chi tocca il file. Vive qui perché
 * `shared/` è l'unica cartella che entrambi i progetti TS possono importare
 * senza violare il confine composite (TS6307), quindi la sincronia non è più
 * una promessa: è la stessa costante.
 *
 * Flusso:
 *   1. Il client apre /ws.
 *   2. Il server manda subito `connected` (byte-compat coi client v2.x) e poi
 *      `welcome` (nuovo in v3).
 *   3. Il client può mandare `hello` con la propria versione e capacità. Un
 *      client che non lo manda vale v1.
 *   4. Il server logga l'hello e, se `clientProtocolVersion <
 *      SERVER_PROTOCOL_VERSION`, potrà emettere `upgrade-required` (per ora
 *      solo log: SERVER_PROTOCOL_VERSION è 1).
 *
 * Idioma `zod/mini` (API funzionale, tree-shakable): questi schemi finiscono
 * nel bundle client, e la versione method-heavy di zod nel chunk d'ingresso
 * costa. `.safeParse` è identico nelle due varianti.
 */
import { z } from 'zod/mini';

// ----- Server -> Client: welcome --------------------------------------------

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  /** Human-readable server version (from package.json). */
  serverVersion: z.string(),
  /** Integer protocol version. Compare against client's to detect drift. */
  protocolVersion: z.int(),
  /** Stable capability identifiers the server supports. */
  capabilities: z.array(z.string()),
  /** Server-side wall-clock (ms since epoch). Clients can use for clock skew. */
  serverTime: z.number(),
  /** Echo of the WS client id (matches `connected.clientId`). */
  clientId: z.string(),
});

// ----- Server -> Client: upgrade-required (future) --------------------------

// Nessun alias `UpgradeRequiredMessage`: lo schema è bloccato dai test di
// contratto (tests/unit/ws-contract.test.ts) ma il messaggio non viene ancora
// emesso, quindi il tipo non aveva un solo consumatore. Serve in v2?
// `z.infer<typeof upgradeRequiredSchema>` è una riga.

// ----- Public API -----------------------------------------------------------

/** Errore Zod appiattito in una riga leggibile (`campo: messaggio; …`). */
export function formatZodIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
}

