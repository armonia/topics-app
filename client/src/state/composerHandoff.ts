/**
 * Il passaggio di consegne fra la bozza e la chat vera.
 *
 * Il primo messaggio di una chat nuova non è un aggiornamento di stato: è un
 * CAMBIO DI PANE. `promoteDraft` crea il topic sul server e rimappa l'id della
 * pane (`draft:<uuid>` → `<topicId>`), quindi il ChatPane della bozza si
 * smonta e ne nasce un altro. Per React sono due componenti diversi, e la
 * seconda non sa niente della prima.
 *
 * Senza questo, l'animazione più importante — il composer che dal centro
 * scivola in fondo quando la conversazione comincia — è l'unica che non si
 * vedeva mai: la bozza era centrata, la chat vera nasceva già in fondo, e in
 * mezzo c'era un taglio.
 *
 * Qui si conserva una riga sola: «questa pane viene da una bozza, un istante
 * fa». La chat nuova la ritira UNA volta al montaggio, parte centrata e poi
 * scende — e l'animazione attraversa il rimontaggio.
 *
 * `claim` e non `peek`: la riga si consuma leggendola. Un secondo montaggio
 * dello stesso topic (cambio di tab, riapertura) non deve ritrovarsi il
 * composer che riparte dal centro.
 */

/** Oltre questa finestra la consegna è scaduta: non è più lo stesso gesto. */
const HANDOFF_TTL_MS = 3000;

const promoted = new Map<string, number>();

// Capability, not existence: sotto bun:test alcuni file installano un `window`
// finto e parziale su globalThis (e non sempre lo tolgono), quindi `typeof
// window !== 'undefined'` può essere vero mentre il metodo che stiamo per
// chiamare non c'è. Questo blocco gira all'IMPORT: un throw qui affonderebbe
// il modulo per chiunque lo importi.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('topics:pane-id-remap', (e: Event) => {
    const to = (e as CustomEvent<{ from?: string; to?: string }>).detail?.to;
    if (to) promoted.set(to, Date.now());
  });
}

/**
 * Questa pane è appena nata da una bozza promossa? Vero UNA sola volta, e solo
 * se il rimontaggio è avvenuto entro {@link HANDOFF_TTL_MS}.
 */
export function claimCenteredHandoff(topicId: string): boolean {
  const at = promoted.get(topicId);
  if (at === undefined) return false;
  promoted.delete(topicId);
  return Date.now() - at < HANDOFF_TTL_MS;
}
