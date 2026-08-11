/**
 * Il nome del punto d'incontro, e la prova di averlo creato.
 *
 * ── IL DIFETTO CHE QUESTO MODULO CHIUDE ─────────────────────────────────────
 * Prima, il nome con cui la macchina si agganciava al relay era lo stesso che
 * finiva nei link condivisi. `relay-config.ts` lo diceva a chiare lettere —
 * «l'identificativo non è un segreto» — e per gli OSPITI il ragionamento
 * reggeva: senza un `ref` e senza la chiave nel frammento, chi conosce il nome
 * non apre niente.
 *
 * Quel ragionamento dimenticava una porta: `/agent/:id`. Lì lo stesso nome non
 * apriva una risorsa, era la credenziale INTERA per dichiararsi la macchina. E
 * il Durable Object, per non tenere due host insieme, SFRATTA quello vecchio
 * quando ne arriva uno nuovo. Sommate le due cose: chiunque avesse ricevuto un
 * link poteva cacciare la macchina dal proprio relay e mettersi al suo posto —
 * tutto il traffico degli ospiti verso di sé, e la macchina vera in un ciclo di
 * riconnessioni che la rimetteva in gara ogni volta.
 *
 * ── LA FORMA DELLA CORREZIONE ───────────────────────────────────────────────
 * Il nome pubblico diventa il DIGEST di un segreto che non esce mai dalla
 * macchina:
 *
 *     relayId = base64url(SHA-256("topics-relay-id-v1\n" + segreto))[0..24]
 *
 * Gli ospiti continuano a usare il solo nome, esattamente come prima. La
 * macchina, sull'unica porta che conta, presenta il segreto: il relay lo passa
 * di qui e confronta il risultato col nome nel percorso. Chi ha il link ha il
 * digest, e da un digest non si torna indietro.
 *
 * Niente registro, niente primo-che-arriva-vince, niente stato da tenere
 * d'accordo fra due parti: è una funzione pura, e il relay resta ciò che
 * dichiara di essere (RELAY-04) — non impara CHI sei, verifica che il nome che
 * usi sia un nome che potevi costruire solo tu.
 *
 * ── PERCHÉ STA IN `shared/` ─────────────────────────────────────────────────
 * La derivazione la calcolano in due: la macchina, per sapere come chiamarsi, e
 * il Worker, per verificare. Due copie della stessa formula sono due cose che
 * un giorno dicono nomi diversi — ed è il giorno in cui la macchina non si
 * aggancia più a niente. Stessa ragione per cui `PERCORSO_PONTE` vive in un
 * posto solo.
 *
 * ── PERCHÉ NON SERVE UN CONFRONTO A TEMPO COSTANTE ──────────────────────────
 * Si confronta il digest DERIVATO col nome che sta nel percorso, e quel nome è
 * pubblico per costruzione: sta nei link. Un confronto che perde tempo non
 * rivela niente che chi bussa non abbia già scritto lui stesso nella richiesta.
 * Il segreto non viene mai confrontato, solo trasformato.
 */

/** Separa questo uso da qualunque altro digest dello stesso segreto. */
const DOMINIO = "topics-relay-id-v1\n";

/**
 * Quanti caratteri del digest diventano il nome.
 *
 * 24 caratteri base64url sono 144 bit: molto oltre ciò che serve perché due
 * installazioni non si incontrino per sbaglio, e molto oltre ciò che serve
 * perché nessuno costruisca un secondo segreto con lo stesso digest. È anche la
 * stessa lunghezza dell'identificativo di prima, così tutto ciò che validava
 * quella forma continua a valere.
 */
export const LUNGHEZZA_RELAY_ID = 24;

/** La forma di un nome: la stessa che il percorso del relay già impone. */
export const FORMA_RELAY_ID = /^[A-Za-z0-9_-]{8,64}$/;

function base64url(b: ArrayBuffer): string {
  const bytes = new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Il nome pubblico che corrisponde a questo segreto.
 *
 * `crypto.subtle` e non `node:crypto`: è l'unica interfaccia che esiste da
 * entrambe le parti — dentro un Worker non c'è nulla di Node — ed è ciò che
 * permette a questa funzione di essere una sola.
 */
export async function derivaRelayId(segreto: string): Promise<string> {
  const dati = new TextEncoder().encode(DOMINIO + segreto);
  const digest = await crypto.subtle.digest("SHA-256", dati);
  return base64url(digest).slice(0, LUNGHEZZA_RELAY_ID);
}

/**
 * Questo segreto è quello del punto d'incontro che dice di essere?
 *
 * Rifiuta prima di calcolare quando il segreto è assente o assurdo: un digest
 * di stringa vuota è comunque un digest, e senza questo controllo una macchina
 * che non manda niente verrebbe confrontata invece che respinta subito.
 */
export async function segretoCorrisponde(segreto: string | null | undefined, relayId: string): Promise<boolean> {
  if (typeof segreto !== "string" || segreto.length < 16 || segreto.length > 512) return false;
  if (!FORMA_RELAY_ID.test(relayId)) return false;
  return (await derivaRelayId(segreto)) === relayId;
}

/**
 * L'intestazione con cui la macchina presenta il segreto.
 *
 * In un'INTESTAZIONE e non nel percorso o in un parametro: quelli finiscono nei
 * registri di chi sta in mezzo, e un segreto che compare in un log è un segreto
 * che vive più a lungo della connessione che lo usava.
 */
export const INTESTAZIONE_SEGRETO = "x-topics-agent-key";
