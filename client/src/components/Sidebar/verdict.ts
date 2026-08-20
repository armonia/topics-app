/**
 * QUALE RIGA COMPARE SOTTO I NUMERI DELLE PRESTAZIONI, e perché.
 *
 * PERCHÉ È UN MODULO A SÉ. La regola viveva dentro `PerfSection.tsx`, in mezzo
 * alla JSX: leggibile solo montando un componente, quindi di fatto non provata.
 * Le soglie qui sotto sono decisioni di prodotto — dicono a una persona che cosa
 * sta guardando — e una decisione che nessun test può contraddire cambia per
 * sbaglio.
 *
 * LA RIGA CHE MANCAVA, e il fatto che l'ha resa necessaria. Il numero in
 * evidenza è `phys_footprint`, la colonna «Memoria» di Monitoraggio Attività: la
 * scelta è giusta e resta, perché è l'unico numero che l'utente può confrontare
 * con qualcosa. Ma include ciò che il sistema ha già compresso o mandato in
 * swap, e quella parte NON è RAM sottratta a nessuno.
 *
 * Misurato il 2026-08-19 sulla finestra dell'utente che aveva segnalato
 * «1,8 GB»: **1.788 MB di footprint contro 517 MB residenti** — 1.271 MB già
 * restituiti. La sola riga che parlava di swap si accendeva sopra i 2 GB,
 * quindi non compariva nulla: si leggeva «1,8 GB» senza modo di sapere che i due
 * terzi erano contabilità. Nello stesso istante, sulla stessa macchina, Dia
 * teneva **2.414 MB residenti** e Spotify 972.
 *
 * PERCHÉ UN RAPPORTO E NON UNA SOGLIA. 300 MB compressi su 400 dicono la stessa
 * cosa di 1,2 GB su 1,8; 1 GB compresso su 6 non spiega niente. Il minimo
 * assoluto tiene fuori le finestre piccole, dove la stessa proporzione vale
 * decine di MB e la riga sarebbe rumore.
 *
 * E NON DICE «CHIUDI QUALCOSA». Quel consiglio appartiene all'altro caso, dove
 * la pressione è vera; qui sarebbe sbagliato, perché la memoria se n'è già
 * andata da sola. Una riga che consiglia un'azione inutile costa più del
 * silenzio.
 */

/** La riga scelta, prima di diventare testo tradotto e colore. */
export type Verdetto =
  | { tipo: 'noAccel' }
  /** Pressione vera: tanta memoria compressa in valore assoluto. */
  | { tipo: 'compressed'; gb: string }
  /** Il numero grande esagera: il grosso è già tornato al sistema. */
  | { tipo: 'mostlySwapped'; pct: number; mb: number }
  | { tipo: 'loaded' };

export interface IngressiVerdetto {
  /** `false` = accelerazione hardware spenta. `null` = non ancora saputo. */
  accelerated: boolean | null;
  /** Footprint meno residente, o `null` se la misura è parziale. */
  compressedMB: number | null;
  totalMB: number | null;
  residentMB: number | null;
  /** Carico su scala 0-100 dell'intera macchina, o `null` se non misurato. */
  totalCpu: number | null;
}

/** Sotto questa quota assoluta la riga sullo swap sarebbe rumore. */
export const MIN_COMPRESSI_MB = 300;
/** Oltre questa quota assoluta la pressione è vera e va detta come tale. */
export const SOGLIA_PRESSIONE_MB = 2048;
/** Quota del footprint oltre la quale «il numero grande esagera» è la lettura giusta. */
export const QUOTA_SWAPPATA = 0.5;
/** Metà macchina presa da Topics è già «sotto carico». */
export const SOGLIA_CPU = 50;

/**
 * L'ordine conta: si nomina prima la causa più grave e più certa, perché è
 * quella su cui chi legge può agire.
 */
export function scegliVerdetto(x: IngressiVerdetto): Verdetto | null {
  if (x.accelerated === false) return { tipo: 'noAccel' };

  const compressi = x.compressedMB;
  if (compressi !== null && compressi > SOGLIA_PRESSIONE_MB) {
    return { tipo: 'compressed', gb: (compressi / 1024).toFixed(1) };
  }
  if (
    compressi !== null &&
    x.totalMB !== null &&
    x.residentMB !== null &&
    compressi >= MIN_COMPRESSI_MB &&
    compressi > x.totalMB * QUOTA_SWAPPATA
  ) {
    return {
      tipo: 'mostlySwapped',
      pct: Math.round((compressi / x.totalMB) * 100),
      mb: Math.round(x.residentMB),
    };
  }
  if ((x.totalCpu ?? 0) > SOGLIA_CPU) return { tipo: 'loaded' };
  // Nessuna riga nel caso buono: gli fps e la sparkline sopra lo dicono già.
  return null;
}

/**
 * LA STESSA DOMANDA, SUL NUMERO CHE SI LEGGE PER PRIMO.
 *
 * `scegliVerdetto` decide la riga del PANNELLO. Ma il numero che l'utente vede
 * senza aprire niente è quello della BARRA, e lì la spiegazione non c'era:
 * misurato il 2026-08-20 sulla sua finestra, **1.989 MB dichiarati contro 594
 * residenti**, cioè l'80% già ceduto al sistema, e per saperlo bisognava aprire
 * il pannello Performance. Chi legge «1,8 GB» e non apre resta con un numero
 * che significa una cosa diversa da quella che sembra.
 *
 * Le soglie sono le stesse dell'altra riga, di proposito: due superfici che
 * rispondono alla stessa domanda con due metri diversi si contraddicono, e
 * l'utente non ha modo di sapere quale credere.
 */
export function mostraResidenteInBarra(x: {
  /** Il totale in barra: footprint del dispositivo più il lato server. */
  totalMB: number | null;
  /** Il residente del DISPOSITIVO (la shell non misura il lato server). */
  residentMB: number | null;
  /** Il lato server, che va scorporato: il suo residente non lo conosciamo. */
  serverMB: number | null;
  /** Misura parziale: nessuna percentuale, meglio tacere. */
  partial: boolean;
}): boolean {
  if (x.partial || x.totalMB === null || x.residentMB === null) return false;
  const compressi = Math.max(0, x.totalMB - x.residentMB - (x.serverMB ?? 0));
  return compressi >= MIN_COMPRESSI_MB && compressi > x.totalMB * QUOTA_SWAPPATA;
}
