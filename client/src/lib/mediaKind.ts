/**
 * Le regole vivono in `shared/media-kind.ts`: le usa anche il SERVER, sulla
 * porta che accetta `previewImage`. Era la quarta copia mancante — non sapendo
 * distinguere i tipi, accettava come anteprima qualunque path che passasse
 * l'allowlist, e un `.pdf` arrivava fino al ramo `<img>` della card.
 *
 * Questo file resta la porta d'ingresso del client, che le importava già da qui.
 */
export { isVideoPath, isImagePath, isPdfPath, isPreviewablePath } from '../../../shared/media-kind';
