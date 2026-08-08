/**
 * L'UNICA porta per le tre domande che si fanno su un'organizzazione.
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Le tre domande sono: «qual è l'organizzazione di QUESTA installazione»,
 * «quanti membri VIVI ha», «che cosa può farci QUESTA persona». Prima erano
 * scritte a mano dove servivano, e le copie non concordavano già:
 *
 *   - `/api/auth/me` prendeva la riga PIÙ VECCHIA di `orgs` — `ORDER BY
 *     created_at LIMIT 1`, senza guardare chi fosse a chiedere e senza guardare
 *     `installation`, che è la tabella che quella domanda la risponde
 *     (`084-people-orgs.sql` §5). Con una seconda organizzazione
 *     l'installazione cambiava identità in silenzio: nessun errore, nessun log,
 *     solo un altro nome nell'intestazione e un altro insieme di membri.
 *   - il conteggio dei membri era scritto due volte con due definizioni di
 *     «membro» — una guardava solo `revoked_at`, l'altra anche
 *     `local_blocked_at`. Le due si sono già separate una volta, e la
 *     riparazione è durata finché non è comparso il terzo chiamante.
 *
 * Il verso in cui una copia dimenticata sbaglia è cattivo: non solleva niente,
 * risponde un'altra cosa. Quindi la domanda si fa QUI, e chi ne aggiunge una
 * quarta la aggiunge in questo file.
 *
 * ── COSA NON FA ─────────────────────────────────────────────────────────────
 * Non decide chi possiede la MACCHINA: quello è `installation_owners` e solo
 * quello (ORG-02). `org_members.role` governa una cosa sola — chi può scrivere
 * in `org_members` — ed è esattamente ciò che la 084 dichiara alle righe 96-102.
 * Se un giorno nessuno chiamasse più `canAdministerOrg`, la colonna andrebbe
 * tolta invece che lasciata a suggerire un potere che non ha.
 */
import type { Database } from "bun:sqlite";

/** Forma minima del database: così i test passano uno SQLite in memoria. */
type Db = Pick<Database, "query">;

/** I ruoli DENTRO un'organizzazione. Union allineata al CHECK della 084 — se le
 *  due divergono, `tests/integration/auth-routes.test.ts` lo vede. */
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(v: unknown): v is OrgRole {
  return typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);
}

/**
 * L'organizzazione di QUESTA installazione.
 *
 * Primo: la tabella `installation`, che è il puntatore che la 084 ha creato
 * apposta. Secondo — e solo se quel puntatore è morto, cioè se una
 * sincronizzazione ha revocato l'organizzazione sotto i piedi — l'organizzazione
 * viva più vecchia di cui il proprietario PREDEFINITO è membro. Mai «la riga più
 * vecchia della tabella»: quella non dipende da chi sei, e con due
 * organizzazioni risponde a caso.
 */
export function installationOrgId(db: Db): string | null {
  try {
    const puntata = db.query(`
      SELECT i.org_id AS id
        FROM installation i JOIN orgs o ON o.id = i.org_id
       WHERE i.singleton = 1 AND o.revoked_at IS NULL`).get() as { id: string } | undefined;
    if (puntata) return puntata.id;

    const ripiego = db.query(`
      SELECT o.id AS id
        FROM installation_owners io
        JOIN org_members m ON m.person_id = io.person_id
        JOIN orgs o       ON o.id = m.org_id
       WHERE m.revoked_at IS NULL AND m.local_blocked_at IS NULL AND o.revoked_at IS NULL
       ORDER BY io.is_default DESC, o.created_at
       LIMIT 1`).get() as { id: string } | undefined;
    return ripiego?.id ?? null;
  } catch {
    // Schema più vecchio della 084: non c'è ancora nessuna organizzazione.
    return null;
  }
}

/**
 * Quanti membri VIVI. «Vivo» vuol dire senza NESSUNA delle due revoche: quella
 * del piano di controllo (`revoked_at`) e quella decisa qui
 * (`local_blocked_at`). Sono due colonne diverse perché una sopravvive alla
 * sincronizzazione e l'altra no — ma per la domanda «quanti siete» contano
 * uguale, e averlo scritto in due modi ha già prodotto due numeri diversi sulla
 * stessa organizzazione.
 */
export function liveMemberCount(db: Db, orgId: string): number {
  try {
    const r = db.query(`
      SELECT COUNT(*) AS n FROM org_members
       WHERE org_id = ? AND revoked_at IS NULL AND local_blocked_at IS NULL`).get(orgId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Il ruolo di una persona in un'organizzazione, o `null` se non ne è un membro
 * vivo. Un'appartenenza revocata o bloccata NON è un ruolo più debole: è
 * assenza — chi è stato tolto non amministra, e non è un `member`.
 */
export function orgRole(db: Db, orgId: string, personId: string | null): OrgRole | null {
  if (!personId) return null;
  try {
    const r = db.query(`
      SELECT role FROM org_members
       WHERE org_id = ? AND person_id = ? AND revoked_at IS NULL AND local_blocked_at IS NULL`)
      .get(orgId, personId) as { role?: string } | undefined;
    return isOrgRole(r?.role) ? r.role : null;
  } catch {
    return null;
  }
}

/**
 * Può INVITARE, TOGLIERE e cambiare i ruoli dentro questa organizzazione?
 *
 * È l'unico uso di `org_members.role`, ed è quello che la 084 le assegna. Non
 * dice niente sull'accesso a questa macchina: un ospite non arriva nemmeno qui —
 * lo ferma il cancello, che non mette `/api/auth/orgs/` in allowlist — e un
 * proprietario dell'installazione che sia solo `member` di un'organizzazione
 * altrui non ne amministra i membri, che è il punto.
 */
export function canAdministerOrg(db: Db, orgId: string, personId: string | null): boolean {
  const r = orgRole(db, orgId, personId);
  return r === "owner" || r === "admin";
}

/** Quanti `owner` VIVI ha un'organizzazione. Serve a non lasciarne zero: senza
 *  nessun proprietario l'appartenenza diventa immodificabile per chiunque. */
export function liveOwnerCount(db: Db, orgId: string): number {
  try {
    const r = db.query(`
      SELECT COUNT(*) AS n FROM org_members
       WHERE org_id = ? AND role = 'owner' AND revoked_at IS NULL AND local_blocked_at IS NULL`)
      .get(orgId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * CHI sta facendo questa richiesta, come persona.
 *
 * Il dispositivo è il credenziale, la persona è il soggetto: si parte da
 * `devices.person_id`. Il ripiego sul proprietario PREDEFINITO copre i due casi
 * in cui non c'è un dispositivo da cui partire — il loopback (la macchina
 * stessa, dove nessun cookie dice chi ha le mani sulla tastiera) e un
 * dispositivo appaiato prima della 084, che una persona non ce l'ha. Ricade
 * verso il proprietario e non verso `null` perché `null` non amministra niente,
 * e la macchina davanti a cui sei seduto deve poter amministrare il proprio
 * gruppo.
 */
export function actingPersonId(db: Db, deviceId: string | null | undefined): string | null {
  try {
    if (deviceId) {
      const d = db.query("SELECT person_id FROM devices WHERE id = ? AND revoked_at IS NULL")
        .get(deviceId) as { person_id: string | null } | undefined;
      if (d?.person_id) return d.person_id;
    }
    const io = db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1")
      .get() as { person_id: string } | undefined;
    return io?.person_id ?? null;
  } catch {
    return null;
  }
}
