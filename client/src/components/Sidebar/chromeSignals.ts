/**
 * I TRE SEGNALI DELLA BARRA, MISURATI SUL CHROME E NON SU UNA PANE.
 *
 * Questa riga vive sul chrome della sidebar (`--chrome-bg`: #eaecf0 in chiaro,
 * #080a0e in scuro), che in chiaro è più SCURO di una superficie di contenuto.
 * Le tinte qui erano scritte nude sulla scala 500 — `text-amber-500`,
 * `text-emerald-500`, `text-red-500` — cioè tarate per il fondo scuro e basta.
 * Misurato sulla palette vera (oklch → sRGB) sul chrome dei due temi:
 *
 *              chiaro   scuro
 *   amber-500    1,82    9,22   ← «2,1GB» in rosso-allarme che non si legge
 *   emerald-500  2,09    8,03
 *   red-500      3,24    5,18
 *
 * Le coppie qui sotto sono la soluzione, non una scelta di gusto: sul chrome
 * chiaro la scala 700 non basta per ambra e verde (4,28 e 4,19), quindi il
 * TESTO scende alla 800 e in scuro risale alla 400.
 *
 *   emerald-800 / emerald-400   6,42 / 10,24
 *   amber-800   / amber-400     6,04 / 11,52
 *   red-700     / red-400       5,44 /  6,84
 *
 * I PALLINI sono grafica, non testo: la soglia è 3:1 e non 4,5:1, e a sei pixel
 * una tinta troppo scura smette di leggersi come «verde» o «ambra» e diventa un
 * puntino sporco. Restano quindi due gradini più su, dove passano lo stesso.
 *
 *   emerald-600 / emerald-400   3,10 / 10,24
 *   amber-700   / amber-400     4,28 / 11,52
 *   red-500     / red-400       3,24 /  6,84
 *
 * (Il pannello dei file, che sta su `--bg-elevated` — più chiaro — ha la SUA
 * taratura in `lib/gitStatusColors.ts`, dove la scala 700 basta. Due superfici,
 * due misure: è la stessa ragione per cui il chrome si ritara terziario e bordi
 * in index.css.) */
export const SEGNALE_OK = 'text-emerald-800 dark:text-emerald-400';
export const SEGNALE_ATTESA = 'text-amber-800 dark:text-amber-400';
export const SEGNALE_GUASTO = 'text-red-700 dark:text-red-400';
export const PALLINO_OK = 'bg-emerald-600 dark:bg-emerald-400';
export const PALLINO_ATTESA = 'bg-amber-700 dark:bg-amber-400';
export const PALLINO_GUASTO = 'bg-red-500 dark:bg-red-400';
