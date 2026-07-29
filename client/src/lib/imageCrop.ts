/**
 * Ritaglio di uno screenshot attorno a un riquadro di pagina (4.2).
 *
 * Serve alla pane NATIVA: la WKWebView sa fare uno snapshot dell'intera view
 * (`browser_screenshot`), non di un elemento. La pane web non passa di qui —
 * Playwright ritaglia già lato server con `clip`.
 *
 * Il punto delicato è la scala. La bbox arriva in CSS px della PAGINA, lo
 * snapshot è in pixel del dispositivo (su un display retina è il doppio). Il
 * fattore si ricava dallo screenshot stesso — larghezza reale diviso larghezza
 * del viewport — invece che da `devicePixelRatio`, che è quello della finestra
 * dell'app e non necessariamente quello della pane.
 */

export interface CropResult {
  dataUrl: string;
  w: number;
  h: number;
}

export async function cropToElement(
  imageDataUrl: string,
  bbox: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  pad = 8,
): Promise<CropResult | null> {
  if (bbox.w < 1 || bbox.h < 1 || viewport.w < 1) return null;

  const img = new Image();
  img.src = imageDataUrl;
  try {
    await img.decode();
  } catch {
    return null;
  }
  if (!img.naturalWidth || !img.naturalHeight) return null;

  const scale = img.naturalWidth / viewport.w;
  const sx = Math.max(0, Math.round((bbox.x - pad) * scale));
  const sy = Math.max(0, Math.round((bbox.y - pad) * scale));
  const sw = Math.min(img.naturalWidth - sx, Math.round((bbox.w + pad * 2) * scale));
  const sh = Math.min(img.naturalHeight - sy, Math.round((bbox.h + pad * 2) * scale));
  if (sw < 2 || sh < 2) return null;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  // Stesso criterio del lato server: PNG finché il ritaglio è piccolo (il testo
  // di UI col JPEG si impasta), JPEG quando pesa.
  const lossless = sw * sh <= 640 * 640;
  return {
    dataUrl: lossless ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.8),
    w: sw,
    h: sh,
  };
}
