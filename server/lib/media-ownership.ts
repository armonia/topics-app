/**
 * Di chi è questo file? — l'attribuzione dei media a un turno.
 *
 * `~/.topics/media/` è una cassetta CONDIVISA per contratto: il dispatcher dice
 * a ogni agente di depositare lì allegati e anteprime, e ci scrivono anche gli
 * screenshot del browser e le spec E2E. Lo sweep che alimenta la chat guardava
 * una cosa sola — `mtime >= inizio turno` — e la cartella non ha nessuna nozione
 * di CHI ha scritto: solo di QUANDO.
 *
 * Il 7 agosto un turno di analisi durato 11 minuti si è portato in fondo alla
 * risposta due screenshot (`empty-state-light/dark.png`) prodotti alle 13:12 da
 * una spec E2E che girava in un'ALTRA sessione. Il turno non li aveva mai visti.
 * E la rete si allarga con la durata: un turno lungo si prende tutto ciò che
 * chiunque ha scritto mentre lavorava — comprese cose che in quella chat non
 * dovevano comparire.
 *
 * La prova di proprietà però esiste già, e il server ce l'ha in mano: se un
 * turno ha prodotto un file, l'ha fatto con un TOOL, e il percorso di quel file
 * compare negli argomenti di quella chiamata o nel suo risultato. Chi non lo
 * nomina non l'ha fatto.
 *
 * Il patto è deliberatamente asimmetrico: meglio PERDERE un allegato che
 * RUBARNE uno. Un allegato perso l'agente lo riattacca; uno rubato compare in
 * una conversazione che non c'entra, e nessuno se ne accorge.
 */

import { basename } from "path";

/** Quel che serve sapere di una chiamata a un tool per attribuire un file. */
export interface TurnToolTrace {
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
}

export interface MediaAttribution {
  /** File che questo turno ha nominato: suoi. */
  propri: string[];
  /** Candidati scartati perché il turno non li nomina mai. */
  altrui: string[];
}

/**
 * Un nome troppo corto non è una prova.
 *
 * `x.png` dentro il testo di un turno può essere qualunque cosa; con un nome
 * generico si tornerebbe ad attribuire per coincidenza — cioè al difetto di
 * partenza, con un passaggio in più. Sotto questa soglia si accetta SOLO il
 * percorso assoluto.
 */
const MINIMUM_NAME = 8;

/**
 * Quali dei candidati appartengono davvero a questo turno.
 *
 * Un candidato è suo se il turno, in una qualunque delle sue chiamate, ha
 * nominato il PERCORSO ASSOLUTO, oppure il nome del file quando è abbastanza
 * distintivo da non poter essere un caso.
 *
 * Un turno senza chiamate non può aver prodotto niente: tutti i candidati sono
 * d'altri, e non serve nemmeno guardarli.
 */
export function attribuisciMedia(candidati: string[], tools: TurnToolTrace[]): MediaAttribution {
  if (candidati.length === 0) return { propri: [], altrui: [] };
  if (tools.length === 0) return { propri: [], altrui: [...candidati] };

  const pagliaio = tools
    .map((t) => {
      let a = "";
      try { a = t.args ? JSON.stringify(t.args) : ""; } catch { /* args non serializzabili */ }
      return `${t.name ?? ""}\n${a}\n${t.result ?? ""}`;
    })
    .join("\n");

  const propri: string[] = [];
  const altrui: string[] = [];
  for (const c of candidati) {
    const nome = basename(c);
    const nominato = pagliaio.includes(c) || (nome.length >= MINIMUM_NAME && pagliaio.includes(nome));
    (nominato ? propri : altrui).push(c);
  }
  return { propri, altrui };
}
