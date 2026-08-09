/**
 * L'UNICA porta per «questo soggetto può ricevere una condivisione?».
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * La domanda si faceva in DUE posti, e i due non concordavano:
 *
 *   - `GET /api/auth/subjects` — la rubrica da cui il pannello sceglie — la
 *     rispondeva con una `SELECT` scritta lì dentro, che fra le altre cose
 *     escludeva la persona TOLTA da ogni gruppo. Il commento accanto diceva
 *     perché: «una persona aggiunta e poi tolta continuava a comparire per
 *     sempre nella rubrica, e condividere con lei sarebbe riuscito».
 *   - `POST /api/auth/shares` — il gesto vero — la rispondeva con
 *     `motivoRifiutoSoggetto`, che quella condizione non la guardava affatto.
 *
 * Cioè: la rubrica è stata riparata, il cancello no. La persona spariva dal
 * menu e la POST sullo stesso `subjectId` continuava a rispondere `200`,
 * scriveva la concessione, e la mandava a qualcuno che avevi tolto. Il verso in
 * cui questa divergenza sbaglia è il peggiore: non solleva niente, concede.
 *
 * Da qui in poi la rubrica FILTRA con la stessa funzione con cui il cancello
 * RIFIUTA, quindi le due non possono più separarsi: se una offre un soggetto,
 * l'altra lo accetta.
 *
 * ── AUTORIZZAZIONE E PRESENTAZIONE SONO DUE COSE ────────────────────────────
 * `subjectRejection` è l'AUTORIZZAZIONE, e deve essere identica sui due lati.
 * La rubrica può essere più STRETTA per ragioni di presentazione — non offre un
 * dispositivo ospite che ha già una persona (sarebbe lo stesso umano due volte)
 * né un gruppo da un membro solo (non si nomina) — ma non può mai essere più
 * LARGA. Unificare anche quelle due dentro l'autorizzazione sarebbe l'errore
 * opposto: renderebbe un rifiuto una scelta di disegno.
 *
 * ── CODICI, NON FRASI ───────────────────────────────────────────────────────
 * Torna `shared/auth-codes.ts`. La prosa che c'era qui usciva verso
 * `ShareControl`, che la stampava tale e quale in un pannello inglese.
 */
import type { Database } from "bun:sqlite";
import type { CodiceAuth } from "../../shared/auth-codes";
import type { SubjectKind } from "./grants-query";

/** Forma minima del database: così i test passano uno SQLite in memoria. */
type Db = Pick<Database, "query">;

export interface RecipientRejection {
  codice: CodiceAuth;
  status: number;
}

/**
 * Questa persona è stata TOLTA da ogni gruppo?
 *
 * «Tolta» e non «senza gruppi»: chi non è in nessun gruppo — per esempio una
 * persona nata approvando un dispositivo con «è di un'altra persona» — non è
 * mai stata tolta da niente, e resta un destinatario legittimo. La differenza
 * è che la prima HA delle righe in `org_members` e nessuna è viva; la seconda
 * non ne ha affatto.
 *
 * Le due revoche contano uguale, come ovunque: `revoked_at` l'ha decisa il
 * piano di controllo, `local_blocked_at` l'hai decisa tu, e per la domanda «è
 * ancora dei nostri» sono la stessa risposta.
 */
export function personRemovedEverywhere(db: Db, personId: string): boolean {
  const righe = db.query(`
    SELECT COUNT(*) AS tutte,
           SUM(CASE WHEN revoked_at IS NULL AND local_blocked_at IS NULL THEN 1 ELSE 0 END) AS vive
      FROM org_members WHERE person_id = ?`).get(personId) as
    { tutte: number; vive: number | null } | undefined;
  const tutte = Number(righe?.tutte ?? 0);
  const vive = Number(righe?.vive ?? 0);
  return tutte > 0 && vive === 0;
}

/**
 * In quanti gruppi è VIVA questa persona.
 *
 * Il gemello per-persona di `liveMemberCount` (che conta per-gruppo), e con la
 * stessa definizione di «vivo» — le due revoche insieme. Serve a
 * `DELETE /api/auth/people/:id`, che rifiuta di cancellare qualcuno ancora
 * dentro un gruppo; scriverne una terza copia lì dentro è esattamente il modo
 * in cui le definizioni di «membro» si sono già separate una volta.
 */
export function livePersonMemberships(db: Db, personId: string): number {
  const r = db.query(`
    SELECT COUNT(*) AS n FROM org_members
     WHERE person_id = ? AND revoked_at IS NULL AND local_blocked_at IS NULL`)
    .get(personId) as { n: number } | undefined;
  return Number(r?.n ?? 0);
}

/**
 * Perché questo soggetto NON può ricevere una condivisione, se non può.
 * `null` = può.
 *
 * Il `catch` risponde `db_unavailable` e non lascia passare: su uno schema più
 * vecchio della 084 non c'è modo di sapere se quel soggetto sia confinato, e
 * una condivisione concessa senza poterlo sapere è la condivisione sbagliata.
 * Le LETTURE degradano, le SCRITTURE rifiutano — la stessa regola che le rotte
 * dei membri applicano già.
 */
export function subjectRejection(db: Db, kind: SubjectKind, id: string): RecipientRejection | null {
  if (kind === "device") {
    const d = db.query("SELECT role FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(id) as { role?: string } | undefined;
    if (!d) return { codice: "unknown_device", status: 404 };
    // Condividere con chi vede GIÀ tutto non vuol dire niente, e lasciarlo fare
    // darebbe l'idea che quella riga stia limitando qualcosa.
    if (d.role !== "guest") return { codice: "device_not_guest", status: 400 };
    return null;
  }

  if (kind === "person") {
    try {
      const p = db.query("SELECT revoked_at FROM people WHERE id = ?")
        .get(id) as { revoked_at: number | null } | undefined;
      if (!p) return { codice: "unknown_person", status: 404 };
      if (p.revoked_at !== null) return { codice: "person_revoked", status: 400 };
      if (db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(id)) {
        return { codice: "person_is_owner", status: 400 };
      }
      if (personRemovedEverywhere(db, id)) return { codice: "person_removed", status: 400 };
      return null;
    } catch {
      return { codice: "db_unavailable", status: 400 };
    }
  }

  try {
    const o = db.query("SELECT revoked_at FROM orgs WHERE id = ?")
      .get(id) as { revoked_at: number | null } | undefined;
    if (!o) return { codice: "unknown_org", status: 404 };
    if (o.revoked_at !== null) return { codice: "org_revoked", status: 400 };
    return null;
  } catch {
    return { codice: "db_unavailable", status: 400 };
  }
}

/** Comodità per la rubrica: la stessa domanda, letta come un sì/no. */
export function canReceive(db: Db, kind: SubjectKind, id: string): boolean {
  return subjectRejection(db, kind, id) === null;
}
