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
 * DOVE ARRIVA, oltre alla rotta: i frame `project:*` del WebSocket. Fino a
 * questa consegna uscivano da `broadcastToAll`, cioè a OGNI socket connessa, con
 * nome e path dentro — e l'unico filtro su quel canale era quello degli OSPITI
 * (`isGuestSocketData` + l'allowlist per tipo), che i `project:*` non nomina
 * nemmeno. Un elenco filtrato che il broadcast successivo rimette in chiaro non
 * è un elenco filtrato: è una finestra che si richiude da sola.
 *
 * Ora quel canale ha la sua fan-out — `broadcastProject` in `server/utils.ts` —
 * che chiama `vedeProgetto` SOCKET PER SOCKET usando `envelopeProgettoPer` qui
 * sotto. La regola resta scritta una volta sola: la fan-out la chiama, non la
 * ricopia.
 */
import { resolvePrincipals } from "./principals";
import type { OutboundMessage } from "../../shared/ws-outbound";

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

/**
 * Le tre colonne lette da una riga che le porta OPZIONALI (`Project`), nella
 * forma stretta che `vedeProgetto` pretende.
 *
 * Sta qui e non in due call site perché `undefined` e `null` devono cadere sullo
 * stesso ramo, e `incognito` deve valere solo su `true` — un `1` o un `"true"`
 * non sono un sì. Scritto due volte, il secondo posto è quello che un giorno
 * ammette il `1`.
 */
export function visibilitaDi(p: {
  orgId?: string | null;
  ownerPersonId?: string | null;
  incognito?: boolean;
}): ProgettoVisibilita {
  return {
    orgId: p.orgId ?? null,
    ownerPersonId: p.ownerPersonId ?? null,
    incognito: p.incognito === true,
  };
}

/**
 * I tre frame che portano la riga INTERA — nome, path, colore: cioè tutto ciò
 * che «incognito» promette di non far vedere. `project:deleted` non è fra questi
 * perché porta il solo id, ed è per lo stesso motivo che qui sotto fa da
 * ritratta.
 */
export type TipoFrameProgetto = "project:new" | "project:updated" | "project:archived";

/** Ciò che serve per decidere, più l'id che va nella ritratta. Volutamente più
 *  largo di `ProgettoVisibilita`: chi chiama ha in mano una riga `Project`. */
export interface ProgettoTrasmesso {
  id: string;
  orgId?: string | null;
  ownerPersonId?: string | null;
  incognito?: boolean;
}

/**
 * COSA vede passare QUESTA socket: non un booleano, un envelope.
 *
 * Perché non un booleano: la risposta giusta per chi non vede il progetto non è
 * «niente». Un progetto che diventa incognito — o che cambia organizzazione —
 * sparisce dall'elenco di chi ce l'aveva, e la sparizione va DETTA: senza,
 * quella riga resta sullo schermo, con nome e path, fino al prossimo
 * `GET /api/projects`, cioè fino al prossimo reload. Quindi a chi non vede parte
 * la RITRATTA: `project:deleted` col solo id, che è il frame che il client già
 * sa applicare e che non porta niente di nessuno.
 *
 * La ritratta parte anche a chi quel progetto non l'ha mai avuto — un
 * `project:new` incognito, per esempio. È un no-op sul client (un id che non
 * conosce), ed è una regola sola invece di due: il ramo in più starebbe proprio
 * nel punto dove sbagliarsi significa consegnare un nome.
 */
export function envelopeProgettoPer(
  chi: Osservatore,
  tipo: TipoFrameProgetto,
  progetto: ProgettoTrasmesso,
): OutboundMessage {
  if (vedeProgetto(chi, visibilitaDi(progetto))) {
    return { type: tipo, project: progetto, payload_version: 1 };
  }
  return { type: "project:deleted", project: { id: progetto.id }, payload_version: 1 };
}
