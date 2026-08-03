/**
 * Che COSA è un file allegato, deciso dall'estensione — l'unica fonte per
 * tutte le superfici che mostrano media di un task (card, drawer, tab).
 *
 * Stava scritto tre volte, e le tre copie non coincidevano: la card sapeva dei
 * video (`PreviewMedia`), il drawer no (renderizzava un `<img>` su un `.webm`,
 * icona rotta) e il visore delle tab (`MediaViewer`) conosceva solo immagine e
 * PDF, quindi una clip finiva nel ramo «Nessuna anteprima per questo tipo di
 * file». La stessa evidenza si vedeva o no a seconda di dove la guardavi.
 *
 * Il suffisso tollera query/hash: il path memorizzato è nudo, ma il controllo
 * gira anche su url già costruite.
 */

const VIDEO_RE = /\.(webm|mp4|mov|m4v)(\?|#|$)/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i;
const PDF_RE = /\.pdf(\?|#|$)/i;

/** Clip (registrazione di review): va in un <video>, non in un <img>. */
export function isVideoPath(path: string | null | undefined): boolean {
  return !!path && VIDEO_RE.test(path);
}

export function isImagePath(path: string | null | undefined): boolean {
  return !!path && IMAGE_RE.test(path);
}

export function isPdfPath(path: string | null | undefined): boolean {
  return !!path && PDF_RE.test(path);
}
