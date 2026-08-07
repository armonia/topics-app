/**
 * Da un DISPOSITIVO all'insieme dei suoi PRINCIPALI.
 *
 * Due salti, e non uno in più: dispositivo → persona → organizzazioni di quella
 * persona. La profondità fissa non è un default prudente, è la CONDIZIONE DI
 * VALIDITÀ di tutto il disegno — un cammino di lunghezza nota è una JOIN, uno
 * qualunque è un grafo da girare, e sul grafo la domanda «chi vede questa cosa?»
 * smette di avere una risposta esatta. Per questo `orgs` non ha `parent_id` e un
 * test fallisce se compare.
 *
 * IL CONFINAMENTO NON DISCENDE DALL'ORGANIZZAZIONE. Un dispositivo è confinato a
 * meno che la sua persona non stia in `installation_owners` — una tabella che la
 * sincronizzazione non tocca mai. `org_members` sarà una replica ad autorità
 * remota (è la licenza, è la fattura): se il ruolo ne dipendesse, una carta
 * rifiutata o una riga tolta da un pannello ti renderebbero ospite sulla tua
 * macchina, e il guasto arriverebbe da un canale che non controlli.
 *
 * Ogni ramo cade verso MENO poteri: nessuna persona, persona revocata, persona
 * non proprietaria → confinato. Il verso opposto — assumere proprietario quando
 * non si sa — consegnerebbe tutto, e lo farebbe in silenzio.
 */
import type { Database } from "bun:sqlite";
import type { Principal } from "./grants-query";

type Db = Pick<Database, "query">;

export interface Principals {
  /** I soggetti contro cui confrontare le concessioni. */
  list: Principal[];
  /** La persona del dispositivo, se ne ha una. */
  personId: string | null;
  /** Vede solo ciò che gli è stato concesso. */
  confined: boolean;
}

/** Un dispositivo che non conosciamo: sé stesso, e niente poteri. */
function soloIlFerro(deviceId: string): Principals {
  return { list: [{ kind: "device", id: deviceId }], personId: null, confined: true };
}

/**
 * Il numero di revisione dei principali.
 *
 * Serve a una socket già aperta per accorgersi che il proprio insieme non vale
 * più: l'identità è timbrata all'upgrade e non si rilegge, quindi senza un
 * contatore un cambio di appartenenza resterebbe invisibile fino alla prossima
 * connessione. Lo muovono dei trigger SQL — cioè il database stesso — perché un
 * incremento affidato ai chiamanti è un incremento che il terzo chiamante
 * dimentica.
 */
export function principalsRev(db: Db): number {
  try {
    const r = db.query("SELECT rev FROM principals_rev WHERE singleton = 1").get() as { rev?: number } | undefined;
    return Number(r?.rev ?? 0);
  } catch {
    // Prima della 084 la tabella non esiste: zero è una revisione onesta.
    return 0;
  }
}

/**
 * I principali di questo dispositivo.
 *
 * `null` come `deviceId` è il LOOPBACK — la macchina stessa — e non passa di
 * qui: quel caso corto-circuita prima, in `evaluateIdentity`, ed è deliberato.
 * È la rete anti-lockout della 080: una tabella `people` corrotta non deve poter
 * chiudere fuori il proprietario dalla propria macchina.
 */
export function resolvePrincipals(db: Db, deviceId: string): Principals {
  let riga: { person_id: string | null; person_revoked: number | null; is_owner: number } | undefined;
  try {
    riga = db.query(`
      SELECT d.person_id            AS person_id,
             p.revoked_at           AS person_revoked,
             (io.person_id IS NOT NULL) AS is_owner
        FROM devices d
        LEFT JOIN people p               ON p.id = d.person_id
        LEFT JOIN installation_owners io ON io.person_id = d.person_id
       WHERE d.id = ?`).get(deviceId) as typeof riga;
  } catch {
    // Schema più vecchio della 084: si degrada al comportamento di prima —
    // il dispositivo è il soggetto — invece di far cadere la richiesta.
    return soloIlFerro(deviceId);
  }

  if (!riga || !riga.person_id || riga.person_revoked !== null) return soloIlFerro(deviceId);

  const personId = riga.person_id;
  const list: Principal[] = [{ kind: "device", id: deviceId }, { kind: "person", id: personId }];

  // Le organizzazioni vive di quella persona. Tutte e quattro le revoche si
  // leggono qui: una colonna di revoca che esiste e non viene letta è peggio di
  // nessuna, perché fa sembrare eseguita una revoca che non lo è.
  const orgs = db.query(`
    SELECT om.org_id AS id
      FROM org_members om
      JOIN orgs o ON o.id = om.org_id
     WHERE om.person_id = ?
       AND om.revoked_at IS NULL
       AND om.local_blocked_at IS NULL
       AND o.revoked_at IS NULL`).all(personId) as Array<{ id: string }>;
  for (const o of orgs) list.push({ kind: "org", id: o.id });

  return { list, personId, confined: !riga.is_owner };
}
