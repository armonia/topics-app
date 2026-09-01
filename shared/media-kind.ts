/**
 * Che COSA è un file allegato, deciso dall'estensione — l'unica fonte per tutte
 * le superfici che mostrano media di un task (card, drawer, tab) **e per la
 * porta da cui i media entrano** (`previewImage` in `routes/tasks.ts`).
 *
 * Sta in `shared/` e non nel client per il motivo scritto nella sua stessa
 * storia: la regola era ripetuta tre volte e le tre copie non coincidevano — la
 * card sapeva dei video, il drawer no (un `<img>` su un `.webm`, icona rotta),
 * il visore delle tab conosceva solo immagine e PDF. La stessa evidenza si
 * vedeva o no a seconda di dove la guardavi. Il server era la quarta copia
 * MANCANTE: non sapendo distinguere, accettava come anteprima qualunque path
 * che passasse l'allowlist di sicurezza, e un `.pdf` finiva nel ramo `<img>`.
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

/**
 * Può fare da ANTEPRIMA di una consegna, cioè esiste un elemento che la
 * mostra: `<img>` per immagine e diagramma, `<video>` per la clip. Il
 * protocollo (`PREVIEW_RULE`) ne ammette tre — screenshot .png, video, diagramma
 * .svg — e questa è la stessa frontiera vista dal lato del rendering.
 *
 * Un PDF sta fuori di proposito: è un allegato legittimo di un commento, ma non
 * un'anteprima. Messo in `preview_image` diventava un `<img src=…pdf>`, cioè
 * un'icona rotta sulla card — mai un errore, solo una consegna che sembrava
 * fatta e non mostrava niente.
 */
export function isPreviewablePath(path: string | null | undefined): boolean {
  return isImagePath(path) || isVideoPath(path);
}

/**
 * La cartella che rende riconoscibile a vista una SCHEDA DI CONSEGNA: il
 * diagramma che il server disegna da solo quando una card arriva in review
 * senza nessuna evidenza (vedi `server/services/delivery-sheet.ts`).
 */
export const DELIVERY_SHEET_DIR = "task-sheets";

const DELIVERY_SHEET_RE = new RegExp(`/${DELIVERY_SHEET_DIR}/[^/]+\\.svg(\\?|#|$)`, "i");

/**
 * Un'anteprima DISEGNATA DA NOI, non l'evidenza di qualcuno.
 *
 * Sta qui, accanto alle altre domande sull'estensione, perche' la risposta
 * serve su tre superfici diverse e per lo stesso motivo: la promozione
 * automatica deve poterla sostituire (per lei una scheda vale come riquadro
 * vuoto), il ritiro non deve poterla togliere (non c'e' niente di falso da
 * ritirare) e una nota «non c'e' anteprima» NON e' superata da una scheda:
 * l'anteprima vera continua a mancare.
 */
export function isDeliverySheetPath(path: string | null | undefined): boolean {
  return !!path && DELIVERY_SHEET_RE.test(path.trim());
}

/**
 * The directory of the photos the server takes BY ITSELF: it boots the app from
 * the card's branch, waits for it to answer and photographs the page it finds
 * (`server/services/preview-manager.ts`).
 */
export const AUTO_PREVIEW_DIR = "task-previews";

const AUTO_PREVIEW_RE = new RegExp(`/${AUTO_PREVIEW_DIR}/[^/]+\\.(png|jpe?g|webp)(\\?|#|$)`, "i");

/**
 * A photo WE took, not the evidence somebody chose to show.
 *
 * The difference is not a detail of provenance: it is what the photo PROVES.
 * The agent's evidence is a screen picked to show the change; this is the app
 * booted from the right branch and photographed wherever it was, which is
 * usually its own landing page. Measured 2026-09-01 on two cards in review: the
 * «account panel» one portrayed the «Welcome to Topics» screen, the «remove
 * profile tab» one portrayed the kanban.
 *
 * The two gates the preview manager grew over time check WHO answers on the
 * port (so it is not another project's dev server) and that the page is not an
 * error or a placeholder. Neither of them can say "this photo shows the work",
 * and inventing that judgement would be worse than the defect: the honest cure
 * is to DECLARE what the photo is, so nobody reads it as a proof it is not.
 * Same discipline as the delivery sheet, which says out loud that the server
 * drew it.
 */
export function isAutoCapturedPreview(path: string | null | undefined): boolean {
  return !!path && AUTO_PREVIEW_RE.test(path.trim());
}
