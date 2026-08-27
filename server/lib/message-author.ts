/**
 * L'AUTORE di un messaggio, ricavato da chi ha fatto la richiesta.
 *
 * Due valori e non uno: la PERSONA è il soggetto (è lei che compare su un
 * profilo e sopravvive a un telefono cambiato), il DISPOSITIVO è il credenziale
 * da cui il messaggio è entrato. Vedi la migration 095.
 *
 * IL LOOPBACK È IL CASO SCOMODO, e vale la pena dirlo qui: davanti a questa
 * macchina non c'è nessun cookie che dica chi ha le mani sulla tastiera. Si
 * ricade sul proprietario PREDEFINITO — la stessa regola che `actingPersonId`
 * applica già a ogni altro gesto locale — perché l'alternativa è che ogni
 * prompt scritto dal Mac di casa resti senza autore, cioè che la funzione
 * chiesta non funzioni proprio nel posto in cui si lavora di più.
 *
 * Ciò che NON si fa mai è inventare una persona quando non ce n'è nessuna:
 * `null` è una risposta, e i conteggi la saltano invece di attribuirla a
 * qualcuno.
 */
import { actingPersonId } from "./orgs";

type Db = Parameters<typeof actingPersonId>[0];

export interface AuthorMessage {
  authorPersonId: string | null;
  authorDeviceId: string | null;
}

export function autoreDaIdentita(
  db: Db,
  identita: { deviceId: string | null } | null | undefined,
): AuthorMessage {
  const deviceId = identita?.deviceId ?? null;
  return { authorPersonId: actingPersonId(db, deviceId), authorDeviceId: deviceId };
}

/**
 * Lo stesso autore, ma in una parola che qualcuno RILEGGERÀ.
 *
 * Gli id sono la verità e restano quelli; questa è la forma per le tracce che
 * finiscono sotto gli occhi di una persona — «chi ha portato questa chat in
 * modalità libera» sei mesi dopo. Il ripiego non inventa nessuno: se non c'è un
 * nome si dice da DOVE è arrivato il gesto, e davanti a questa macchina la
 * risposta onesta è «questo computer», non un nome preso a caso.
 */
export function etichettaAutore(
  db: Db,
  identita: { deviceId: string | null } | null | undefined,
): string {
  const { authorPersonId, authorDeviceId } = autoreDaIdentita(db, identita);
  if (authorPersonId) {
    try {
      const row = db
        .query("SELECT display_name FROM people WHERE id = ? AND revoked_at IS NULL")
        .get(authorPersonId) as { display_name?: string } | undefined;
      if (row?.display_name) return row.display_name;
    } catch { /* nessun nome leggibile: si ripiega sul dispositivo */ }
  }
  if (authorDeviceId) return `dispositivo ${authorDeviceId.slice(0, 8)}`;
  return "questo computer";
}
