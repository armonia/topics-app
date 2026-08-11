/**
 * CHI VEDE QUALE PROGETTO.
 *
 * Una funzione pura e un solo posto in cui la regola è scritta. Il motivo per
 * cui non sta dentro la rotta è lo stesso per cui il confinamento dell'ospite
 * sta in `server.ts` e non nei router: una regola d'accesso ricopiata è una
 * regola che diverge, e la copia dimenticata è sempre quella che consegna
 * troppo.
 *
 * IL VERSO. Ogni ramo dubbio cade verso MENO visibilità: nessuna org in comune,
 * `org_id` sconosciuto, persona ignota → non lo vedi. L'unica eccezione è
 * dichiarata e sta in cima: la MACCHINA STESSA vede tutto.
 *
 * PERCHÉ IL LOOPBACK VEDE ANCHE GLI INCOGNITO. È la stessa rete anti-lockout
 * della 080: davanti a questo Mac non c'è nessun cookie che dica chi ha le mani
 * sulla tastiera, quindi filtrare per persona significherebbe far sparire i
 * propri progetti dalla propria macchina. «Incognito» qui vuol dire nascosto ai
 * COMPAGNI D'ORGANIZZAZIONE, non cifrato: chi siede davanti al database lo
 * legge comunque, e prometterlo diversamente sarebbe una promessa che lo schema
 * non può mantenere.
 *
 * DOVE QUESTA REGOLA NON ARRIVA, detto qui perché il posto in cui si scopre da
 * soli è sempre quello sbagliato: i frame `project:*` di `broadcastToAll`. Il
 * filtro dei broadcast è per OSPITI (`isGuestSocketData` + l'allowlist per tipo),
 * e `project:new`/`project:updated` non sono nell'allowlist — quindi a un ospite
 * non arrivano affatto. Arrivano invece a ogni socket NON confinata, cioè agli
 * altri PROPRIETARI DELL'INSTALLAZIONE, incognito compreso.
 *
 * Non è la stessa cosa che manca un cancello, ed è la ragione per cui questa
 * consegna non ci mette un filtro per socket: un secondo proprietario è, per la
 * 084, la stessa macchina — il mio filesystem, i miei terminali, la mia shell.
 * Un progetto che lui non vede in elenco lo legge comunque con `ls`. Il confine
 * che `incognito` fa valere è quello verso i COMPAGNI D'ORG, che oggi sono
 * ospiti e da questi frame sono già fuori. Il giorno in cui un compagno d'org
 * smetterà di essere un ospite, questo commento è il posto da cui ripartire: il
 * filtro va nella fan-out, accanto a quello degli ospiti, non ricopiato qui.
 */
import { resolvePrincipals } from "./principals";

/** Le tre colonne che la 092 ha aggiunto a `projects`, e nient'altro. */
export interface ProgettoVisibilita {
  orgId: string | null;
  ownerPersonId: string | null;
  incognito: boolean;
}

/**
 * Chi guarda. `macchina: true` è il loopback — la macchina stessa — e non ha
 * (né può avere) una persona: vedi sopra.
 */
export interface Osservatore {
  macchina: boolean;
  personId: string | null;
  /** Le organizzazioni VIVE della persona, da `resolvePrincipals`. */
  orgIds: readonly string[];
  /** Sta in `installation_owners`: possiede questa installazione. */
  proprietarioInstallazione: boolean;
}

/**
 * L'osservatore di QUESTA richiesta.
 *
 * `deviceId` nullo è la macchina: loopback o daemon locale, i due casi in cui
 * `evaluateIdentity` non consegna un dispositivo perché non c'è un cookie da
 * cui prenderlo. I principali li risolve `resolvePrincipals`, che è l'unico
 * posto dove si fa il salto dispositivo → persona → organizzazioni: rifarlo qui
 * con una query a mano sarebbe la seconda copia di una regola d'accesso.
 */
export function osservatoreDaDispositivo(
  db: Parameters<typeof resolvePrincipals>[0],
  deviceId: string | null | undefined,
): Osservatore {
  if (!deviceId) {
    return { macchina: true, personId: null, orgIds: [], proprietarioInstallazione: false };
  }
  const p = resolvePrincipals(db, deviceId);
  return {
    macchina: false,
    personId: p.personId,
    orgIds: p.list.filter((s) => s.kind === "org").map((s) => s.id),
    // `confined` è già «la sua persona NON sta in installation_owners», letto
    // dal posto giusto: qui basta girarlo.
    proprietarioInstallazione: !p.confined,
  };
}

export function vedeProgetto(chi: Osservatore, p: ProgettoVisibilita): boolean {
  if (chi.macchina) return true;

  // «Mio» richiede una persona da entrambe le parti: due NULL non sono la stessa
  // persona, sono due assenze, e trattarle come uguali farebbe di ogni progetto
  // senza proprietario il progetto di ogni dispositivo senza persona.
  const mio = p.ownerPersonId !== null && p.ownerPersonId === chi.personId;

  if (p.incognito) {
    // Un incognito SENZA proprietario non è di nessuno: sarebbe invisibile per
    // sempre, anche a chi l'ha marcato. Ricade su chi possiede l'installazione,
    // che è l'unico soggetto che c'è di sicuro.
    return mio || (p.ownerPersonId === null && chi.proprietarioInstallazione);
  }

  // La riga per cui esiste tutta questa storia: stessa organizzazione, stessi
  // progetti.
  if (p.orgId !== null && chi.orgIds.includes(p.orgId)) return true;

  // `org_id` NULL è un progetto che nessuna migration ha saputo assegnare
  // (installazione senza organizzazione): resta al proprietario della macchina,
  // cioè com'era prima della 092.
  return mio || chi.proprietarioInstallazione;
}
