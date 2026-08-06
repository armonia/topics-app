/**
 * La tinta di identità di una tessera fissata: il colore che quella cosa HA GIÀ,
 * mai un colore assegnato.
 *
 * ── La regola, che qui è un vincolo di progetto ──────────────────────────────
 * «Niente colori inventati»: il colore di un progetto viene da un manifest reale
 * SE c'è, altrimenti si disegna in piatto. Un colore auto-assegnato dal server
 * conta come inventato. Quindi:
 *   • progetto con favicon/manifest → il colore dominante DELLA SUA ICONA;
 *   • chat / terminale / browser    → il colore di tipo che il repo già ha
 *                                     (`PANE_CONFIG`, letto dal chiamante);
 *   • progetto senza icona          → `null`, e la tessera resta neutra.
 * Una hue derivata dall'hash dell'id differenzierebbe meglio: è esattamente il
 * colore inventato che la regola vieta, e infatti non c'è.
 *
 * ── Perché il dominante non è la media ──────────────────────────────────────
 * Ridurre un'icona a 1×1 dà la MEDIA dei pixel, che su un logo colorato è
 * quasi sempre un grigiastro: il bianco dello sfondo e i bordi scuri annegano la
 * tinta del marchio. Qui si campiona una griglia, si buttano i pixel
 * trasparenti/slavati/quasi-neri, si accumulano i restanti in spicchi di tonalità
 * pesati per saturazione, e si prende lo spicchio più pesante. Quello che esce è
 * il colore con cui riconosceresti il logo, non la sua media.
 */

export interface RGB { r: number; g: number; b: number }

/** Lato della griglia di campionamento. 16×16 = 256 pixel: abbastanza per non
 *  perdere un accento piccolo, abbastanza pochi da costare nulla. */
export const ICON_SAMPLE_SIZE = 16;

const HUE_BUCKETS = 12;

/** Saturazione HSV (0..1). 0 = grigio puro. */
function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Tonalità in gradi (0..360). Indefinita sui grigi → 0. */
function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * Il colore dominante di un blocco di pixel RGBA, o `null` quando non c'è
 * niente di cromatico da cui pescare (icona monocroma, vuota, o tutta
 * trasparente). Puro: prende i byte, non tocca il DOM.
 */
export function pickDominantColor(pixels: Uint8ClampedArray): RGB | null {
  const weight = new Array<number>(HUE_BUCKETS).fill(0);
  const sumR = new Array<number>(HUE_BUCKETS).fill(0);
  const sumG = new Array<number>(HUE_BUCKETS).fill(0);
  const sumB = new Array<number>(HUE_BUCKETS).fill(0);

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 128) continue; // trasparente: non è colore dell'icona
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (min > 235) continue; // quasi bianco: è lo sfondo
    if (max < 28) continue;  // quasi nero: è il tratto
    const s = saturationOf(r, g, b);
    if (s < 0.18) continue;  // grigi: non identificano niente
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(hueOf(r, g, b) / (360 / HUE_BUCKETS)));
    // Peso = saturazione × opacità: un accento acceso conta più di una campitura slavata.
    const w = s * (a / 255);
    weight[bucket] += w;
    sumR[bucket] += r * w;
    sumG[bucket] += g * w;
    sumB[bucket] += b * w;
  }

  let best = -1;
  let bestW = 0;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (weight[i] > bestW) { bestW = weight[i]; best = i; }
  }
  if (best === -1 || bestW <= 0) return null;
  return {
    r: Math.round(sumR[best] / bestW),
    g: Math.round(sumG[best] / bestW),
    b: Math.round(sumB[best] / bestW),
  };
}

/** `{r,g,b}` → `#rrggbb`. */
export function toHex({ r, g, b }: RGB): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/** `#rgb` / `#rrggbb` → `{r,g,b}`, `null` se non è un esadecimale. */
export function fromHex(hex: string): RGB | null {
  const h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    const [r, g, b] = h.split('').map(c => parseInt(c + c, 16));
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Luminanza relativa WCAG. La curva sRGB è la spezzata dello standard, NON un
 * `pow(2.2)`: usare l'approssimazione sbaglia il contrasto proprio nella zona
 * scura, che è dove queste tessere vivono.
 */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapporto di contrasto WCAG fra due colori (1..21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Il colore che si vede DAVVERO quando `tint` è steso su `surface` a `ratio`
 * di opacità. Il contrasto va misurato su questo, non sulla tinta pura: dare per
 * buono il colore dichiarato invece del composito è l'errore che ha già fatto
 * passare un cancello di contrasto cieco all'opacity.
 */
export function compositeOver(tint: RGB, surface: RGB, ratio: number): RGB {
  const t = Math.max(0, Math.min(1, ratio));
  return {
    r: tint.r * t + surface.r * (1 - t),
    g: tint.g * t + surface.g * (1 - t),
    b: tint.b * t + surface.b * (1 - t),
  };
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const NEAR_BLACK: RGB = { r: 17, g: 20, b: 26 };

/**
 * Quale dei due inchiostri regge su questo fondo, e con che rapporto. Il
 * chiamante può alzare le mani (o togliere la tinta) se `ratio` non arriva a
 * 4,5: qui non si nasconde un contrasto insufficiente, si riporta.
 */
export function bestTextTone(bg: RGB): { tone: 'light' | 'dark'; ratio: number } {
  const light = contrastRatio(WHITE, bg);
  const dark = contrastRatio(NEAR_BLACK, bg);
  return light >= dark ? { tone: 'light', ratio: light } : { tone: 'dark', ratio: dark };
}

// ── Campionamento dell'icona (DOM) ──────────────────────────────────────────

/** Esiti già noti, per URL. Un'icona si campiona una volta per sessione. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** L'esito già in cache, o `undefined` se quell'URL non è mai stato campionato. */
export function cachedIconTint(url: string): string | null | undefined {
  return cache.get(url);
}

/**
 * Campiona la tinta di un'icona servita same-origin (`/api/projects/icon`, quindi
 * il canvas non si sporca) e la memoizza.
 *
 * L'esito "nessuna tinta" resta in memoria di sessione e NON tocca
 * `localStorage`: persistere un "niente" su disco è il bug già pagato su
 * `ProjectFavicon`, dove una entry avvelenata sopravviveva ai reload e nascondeva
 * icone che nel frattempo erano comparse.
 */
export function sampleIconTint(url: string): Promise<string | null> {
  const known = cache.get(url);
  if (known !== undefined) return Promise.resolve(known);
  const running = inflight.get(url);
  if (running) return running;

  const job = new Promise<string | null>(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const size = ICON_SAMPLE_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        const dominant = pickDominantColor(ctx.getImageData(0, 0, size, size).data);
        resolve(dominant ? toHex(dominant) : null);
      } catch {
        // Canvas sporcato o getImageData negato: nessuna tinta, nessun rumore.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }).then(result => {
    cache.set(url, result);
    inflight.delete(url);
    return result;
  });

  inflight.set(url, job);
  return job;
}
