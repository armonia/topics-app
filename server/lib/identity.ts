/**
 * Da un cookie a CHI SEI. Un posto solo (ORG-05).
 *
 * ── PERCHÉ, e non è una pulizia di gusto ────────────────────────────────────
 * La stessa domanda era scritta in TRE punti, e i tre non concordavano:
 *
 *   1. il cancello HTTP — `SELECT * FROM devices WHERE token_hash = ?`, e la
 *      revoca controllata DOPO, nella logica pura;
 *   2. l'upgrade del WebSocket — `SELECT id, role … AND revoked_at IS NULL`, la
 *      revoca filtrata in SQL, e nessun calcolo di persona o organizzazione;
 *   3. `/api/auth/session` — una terza query ancora, con una forma di risposta
 *      diversa dalle altre due.
 *
 * Tre traduzioni che devono dire la stessa cosa e sono scritte separatamente
 * divergono: è già successo due volte in questa sessione. La prima quando il
 * filtro dei broadcast guardava il solo dispositivo e una concessione a una
 * PERSONA valeva sull'HTTP ma non sui frame dal vivo. La seconda quando
 * `/api/auth/session` continuava a rispondere «sei la macchina» sulla porta del
 * tunnel, perché la sua copia della domanda non era stata aggiornata.
 *
 * E il verso in cui divergono è cattivo: la strada dimenticata è sempre la meno
 * percorsa — il WebSocket, il tunnel — cioè quella dove il difetto vive di più
 * prima che qualcuno se ne accorga.
 *
 * ── COSA NON FA ─────────────────────────────────────────────────────────────
 * Non decide se sei AUTORIZZATO: dice chi sei. La decisione resta in
 * `evaluateIdentity` (pura, testata) e in `evaluateAuth`. Questo modulo è
 * l'unico che tocca il database per rispondere alla domanda.
 */
import type { Database } from "bun:sqlite";
import { hashToken, readSessionCookie, type DeviceRecord } from "./device-auth";
import { resolvePrincipals, type Principals } from "./principals";
import type { Principal } from "./grants-query";

type Db = Pick<Database, "query">;

export interface ResolvedIdentity {
  /** `true` = la macchina stessa. Nessun cookie letto, nessuna query fatta. */
  locale: boolean;
  /** Il dispositivo che il cookie identifica, se ce n'è uno. Include i revocati:
   *  distinguere «revocato» da «sconosciuto» serve a dire all'utente quale dei
   *  due gli è capitato, e quella distinzione va fatta a valle. */
  device: DeviceRecord | null;
  /** I principali contro cui confrontare le concessioni. Vuoto per il loopback:
   *  chi è la macchina non ha bisogno di concessioni. */
  principals: Principal[];
  /** Vede solo ciò che gli è stato condiviso. Prudente per costruzione. */
  confined: boolean;
  personId: string | null;
}

const LOCALE: ResolvedIdentity = {
  locale: true, device: null, principals: [], confined: false, personId: null,
};

function rowADevice(r: Record<string, unknown>): DeviceRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    tokenHash: String(r.token_hash),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    firstIp: r.first_ip === null || r.first_ip === undefined ? null : String(r.first_ip),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    role: r.role === "guest" ? "guest" : "owner",
  };
}

/**
 * Chi sta facendo questa richiesta.
 *
 * `locale` lo decide il CHIAMANTE e non questo modulo, perché la risposta
 * dipende dalla porta da cui si è entrati (vedi `lib/tunnel.ts`) e quella la
 * conosce solo chi ha il server in mano.
 *
 * Sul percorso locale non si tocca il database: è il 99% del traffico, ed è
 * anche la rete anti-lockout della 080 — una tabella di identità corrotta non
 * deve poter chiudere fuori il proprietario da casa propria.
 */
export function resolveIdentity(db: Db, cookieHeader: string | null, locale: boolean): ResolvedIdentity {
  if (locale) return LOCALE;

  const token = readSessionCookie(cookieHeader);
  if (!token) return { locale: false, device: null, principals: [], confined: true, personId: null };

  const riga = db.query("SELECT * FROM devices WHERE token_hash = ?")
    .get(hashToken(token)) as Record<string, unknown> | undefined;
  if (!riga) return { locale: false, device: null, principals: [], confined: true, personId: null };

  const device = rowADevice(riga);

  // Un dispositivo revocato non ha principali: la riga si restituisce perché a
  // valle si possa dire «ti è stato tolto l'accesso» invece di «non ti conosco»,
  // ma non porta con sé nessun potere.
  if (device.revokedAt !== null) {
    return { locale: false, device, principals: [], confined: true, personId: null };
  }

  const p: Principals = resolvePrincipals(db, device.id);
  return {
    locale: false,
    device,
    principals: p.list,
    // Finché `devices.role` è la colonna che comanda, il confinamento resta il
    // suo. `p.confined` — la regola derivata da persona e proprietà — gli sta
    // accanto e viene confrontata: divergono in un log, non in un accesso.
    confined: device.role === "guest",
    personId: p.personId,
  };
}

/** Il confinamento come lo calcola il modello NUOVO. Serve al confronto: quando
 *  i due coincideranno stabilmente, `devices.role` potrà sparire (passo 5.4). */
export function confinamentoDerivato(db: Db, deviceId: string): boolean {
  return resolvePrincipals(db, deviceId).confined;
}
