/**
 * Il titolo di una card, ricavato da ciò che una persona ha scritto o dettato.
 *
 * ── IL DIFETTO, visto a schermo il 20/08 ───────────────────────────────────
 * La regola era `firstLine.slice(0, 77) + '…'`: un taglio al carattere 77,
 * ovunque cadesse. Sulla card `235afe11` il titolo era
 *
 *     «Potremmo fare una roba molto figa per poter assicurarci che il nostro
 *      browser…»
 *
 * cioè settantotto caratteri di preambolo dettato che finiscono in mezzo a una
 * frase, senza dire di che cosa parla la card. Segnalato con le parole giuste:
 * «dovrebbe mettere sempre qualcosa di utile per comprendere». Un titolo che
 * non si può leggere in un colpo d'occhio non è un titolo: è l'inizio di un
 * paragrafo messo dove ci si aspetta un nome.
 *
 * ── Che cosa fa questa funzione, e cosa NON fa ─────────────────────────────
 * NON riassume: non c'è nessun modello qui, e inventare un titolo da un testo
 * è esattamente il genere di cosa che sbaglia in silenzio. Fa tre cose che si
 * possono verificare guardando l'output:
 *
 *  1. taglia su un CONFINE DI PAROLA, mai a metà — «browser…» invece di
 *     «brow…»;
 *  2. se il testo ha una FRASE che sta nel limite, preferisce quella: un punto
 *     o un due punti sono il posto in cui chi scrive ha già deciso che
 *     un'unità di senso finisce;
 *  3. lascia stare tutto ciò che è già corto: la stragrande maggioranza dei
 *     titoli non passa di qui.
 *
 * Il testo intero non si perde mai: chi chiama mette il dettato completo nella
 * descrizione, ed è la ragione per cui questo taglio può permettersi di essere
 * aggressivo.
 */

/** Quanto può essere lungo un titolo prima che valga la pena accorciarlo. */
export const TITOLO_MAX = 80;

/**
 * Sotto questa soglia un taglio non è più un titolo ma un frammento: meglio
 * l'inizio intero, per quanto lungo, di tre parole senza senso. Vale come rete
 * per il caso patologico (una riga senza spazi, un URL, un incolla di codice).
 */
const TITOLO_MIN_UTILE = 24;

/** Dove finisce una frase: il punto in cui chi scrive ha già deciso. */
const FINE_FRASE = /[.:;!?](?:\s|$)/g;

/**
 * Il titolo per un testo, e la descrizione che gli resta accanto.
 *
 * Restituisce entrambi perché sono UNA decisione: quando il titolo è un
 * estratto, il testo intero deve finire nella descrizione o quello che è stato
 * tagliato sparisce dal database. Separarli è il modo in cui una delle due metà
 * viene dimenticata.
 */
export function titoloDaTesto(raw: string): { title: string; description: string | null } {
  const testo = raw.trim();
  const righe = testo.split("\n");
  const prima = righe[0]!.trim();
  const resto = righe.slice(1).join("\n").trim();

  // Già corta: è il caso della maggioranza, e non si tocca niente.
  if (prima.length <= TITOLO_MAX) {
    return { title: prima, description: resto || null };
  }

  return { title: accorcia(prima), description: testo };
}

/**
 * La prima riga ridotta a titolo. Esportata perché il taglio è la parte che
 * vale la pena guardare da sola.
 */
export function accorcia(riga: string): string {
  const s = riga.trim();
  if (s.length <= TITOLO_MAX) return s;

  // 1. UNA FRASE INTERA, se ce n'è una che sta nel limite. È il taglio
  //    migliore perché non l'abbiamo scelto noi: l'ha scelto chi ha scritto,
  //    mettendo lì un punto.
  FINE_FRASE.lastIndex = 0;
  let fineFrase = -1;
  for (let m = FINE_FRASE.exec(s); m; m = FINE_FRASE.exec(s)) {
    const fine = m.index + 1;
    if (fine > TITOLO_MAX) break;
    fineFrase = fine;
  }
  if (fineFrase >= TITOLO_MIN_UTILE) return s.slice(0, fineFrase).trim();

  // 2. Altrimenti l'ultima PAROLA intera che ci sta, più l'ellissi. Il limite
  //    è `TITOLO_MAX - 1` perché il carattere «…» occupa il suo posto.
  const finestra = s.slice(0, TITOLO_MAX - 1);
  const ultimoSpazio = finestra.lastIndexOf(" ");
  if (ultimoSpazio >= TITOLO_MIN_UTILE) return `${finestra.slice(0, ultimoSpazio).trimEnd()}…`;

  // 3. Nessuno spazio utile: una riga senza spazi (un URL, un incolla). Qui
  //    tagliare su parola è impossibile e tagliare corto darebbe un moncone:
  //    si taglia al limite, che è quel che si può fare onestamente.
  return `${finestra.trimEnd()}…`;
}
