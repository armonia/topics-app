/**
 * Da un cookie a CHI SEI. Un posto solo (ORG-05).
 *
 * ── PERCHÉ, e non è una pulizia di gusto ────────────────────────────────────
 * La stessa domanda era scritta in TRE punti, e i tre non concordavano:
 *
 *   1. il cancello HTTP — legge le sole colonne del dispositivo, e la
 *      revoca controllata DOPO, nella logica pura;
 *   2. l'upgrade del WebSocket — now it keeps the resolved principal snapshot
 *      so broadcasts can refresh it when the revision changes;
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
  /** Revision that produced the principal set. */
  rev: number;
}

export interface DelegatedCredentialIdentity {
  authorizationId: string;
  capabilityId: string;
}

/**
 * A node credential is deliberately not a device session. The caller must
 * name the capability it intends to exercise and the hash must identify that
 * one live authorization. This prevents a cookie from being promoted through
 * people/devices and prevents an ambiguous "first grant for this device"
 * lookup when the same origin has more than one capability.
 */
export function resolveDelegatedCredential(
  db: Db,
  cookieHeader: string | null,
  capabilityId: string | null,
  now = Date.now(),
): DelegatedCredentialIdentity | null {
  const token = readSessionCookie(cookieHeader);
  if (!token || !capabilityId) return null;
  try {
    const row = db.query(`SELECT id, capability_id
        FROM delegated_node_authorizations
        WHERE credential_hash = ? AND capability_id = ?
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(hashToken(token), capabilityId, now) as { id: string; capability_id: string } | undefined;
    return row ? { authorizationId: row.id, capabilityId: row.capability_id } : null;
  } catch {
    // During a pre-migration boot the delegated scope is absent, never open.
    return null;
  }
}

const LOCALE: ResolvedIdentity = {
  locale: true, device: null, principals: [], confined: false, personId: null, rev: 0,
};

function rowADevice(r: Record<string, unknown>, confined: boolean): DeviceRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    tokenHash: String(r.token_hash),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    firstIp: r.first_ip === null || r.first_ip === undefined ? null : String(r.first_ip),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    role: confined ? "guest" : "owner",
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
  if (!token) return { locale: false, device: null, principals: [], confined: true, personId: null, rev: 0 };

  const riga = db.query(`SELECT id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at
      FROM devices WHERE token_hash = ?`)
    .get(hashToken(token)) as Record<string, unknown> | undefined;
  if (!riga) return { locale: false, device: null, principals: [], confined: true, personId: null, rev: 0 };

  // Un dispositivo revocato non ha principali: la riga si restituisce perché a
  // valle si possa dire «ti è stato tolto l'accesso» invece di «non ti conosco»,
  // ma non porta con sé nessun potere.
  if (riga.revoked_at !== null) {
    const device = rowADevice(riga, true);
    return { locale: false, device, principals: [], confined: true, personId: null, rev: 0 };
  }

  const p: Principals = resolvePrincipals(db, String(riga.id));
  const device = rowADevice(riga, p.confined);
  return {
    locale: false,
    device,
    principals: p.list,
    confined: p.confined,
    personId: p.personId,
    rev: p.rev,
  };
}

/** Il confinamento derivato dalla persona e dalla proprietà locale. */
export function confinamentoDerivato(db: Db, deviceId: string): boolean {
  return resolvePrincipals(db, deviceId).confined;
}
