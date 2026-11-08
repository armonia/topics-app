/**
 * THE FROST ON A FROZEN SESSION: a canvas over the host, and nothing else.
 *
 * It paints `lib/swapIceTexture.ts` into an `ImageData` for the 900 ms of the
 * creep and the 700 ms of the melt, and then STOPS: at rest there is no rAF, no
 * repaint and no filter, because the frost shows up exactly while the Mac is
 * thrashing and a texture that kept animating would take back the cycles the
 * freeze just bought. `prefers-reduced-motion` skips both and paints the final
 * frame at once.
 *
 * WHAT IT NEVER DOES: cover the words. The keep-out mask is rebuilt from the
 * host's own text rectangles whenever they move, so crystals grow around the
 * printed text instead of over it (see the texture module for the contrast
 * arithmetic that leaves no other honest option).
 *
 * The canvas must not match `OVERLAY_SELECTOR` (`lib/shell/browserOcclusion.ts`)
 * or the native browser panes underneath would be frozen by the shell as if a
 * dialog were open (memory note `native-webview-occlusion`): no `role`, no
 * `.glass-surface`, no `.native-occlude`.
 */
import { useEffect, useRef } from 'react';
import type { SwapFreezeView } from '../../state/swapFreeze';
import { glintPoints, iceFields, keepOutMask, paintIce, type IceFields, type IceTheme, type Rect } from '../../lib/swapIceTexture';

const CREEP_MS = 900;
const MELT_MS = 700;
/** The machine is already in swap: a first frame this slow means the loop is not worth running. */
const SLOW_FRAME_MS = 50;

export interface SwapIceProps {
  /** The freeze in force; `null` melts what was there and then unmounts itself. */
  freeze: SwapFreezeView | null;
  /** `card`: reach up to 90 px and three levels of branching. `mini`: rime along a row or a tab. */
  size: 'card' | 'mini';
}

function readTheme(): IceTheme {
  const css = getComputedStyle(document.documentElement);
  const triplet = (name: string, fallback: [number, number, number]): [number, number, number] => {
    const raw = css.getPropertyValue(name).trim();
    const parts = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : fallback;
  };
  return {
    crystal: triplet('--swap-ice-crystal', [110, 150, 192]),
    wash: triplet('--swap-ice-wash', [186, 214, 240]),
    edge: triplet('--swap-ice-edge', [96, 150, 205]),
  };
}

/** The text of the host, as boxes the frost must leave alone. */
function textRects(host: HTMLElement): Rect[] {
  const base = host.getBoundingClientRect();
  const out: Rect[] = [];
  const push = (r: DOMRect): void => {
    if (r.width <= 0 || r.height <= 0) return;
    out.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  };
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent || !node.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) push(r);
  }
  for (const el of Array.from(host.querySelectorAll('svg, img, input, textarea, [role="img"]'))) {
    push(el.getBoundingClientRect());
  }
  return out;
}

const rectKeyOf = (rects: readonly Rect[]): string =>
  rects.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`).join('|');

export function SwapIce({ freeze, size }: SwapIceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glintRef = useRef<HTMLDivElement | null>(null);
  /**
   * THE CANVAS IS ALWAYS IN THE DOM, at 0x0 until something freezes.
   *
   * A thaw has to paint 700 ms of melting on a canvas the freeze has already
   * left, so the element cannot be mounted by the freeze and unmounted by the
   * thaw; and deciding that during render would mean reading, while rendering,
   * a ref written by an effect. An idle canvas with no backing store costs
   * nothing, the host gets no class, and this component paints only when asked.
   */
  const wasFrozen = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement as HTMLElement | null;
    if (!canvas || !host) return;
    const melting = !freeze && wasFrozen.current;
    // Idle: never frozen, nothing to melt.
    if (!freeze && !melting) return;
    wasFrozen.current = !!freeze;

    const seed = freeze?.id ?? 'melt';
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let fields: IceFields | null = null;
    let keepOut: Float32Array | undefined;
    let image: ImageData | null = null;
    let rectKey = '';
    let frame = 0;
    let stopped = false;
    let observers: Array<{ disconnect: () => void }> = [];

    host.classList.add('swap-ice-host');
    host.dataset.swapIce = melting ? 'melting' : 'frozen';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /** The end of a melt: the marker goes, and so does the canvas. */
    const done = (): void => {
      host.removeAttribute('data-swap-ice');
      host.classList.remove('swap-ice-host');
      // Back to nothing: no backing store, no pixels, no host class.
      canvas.width = 0;
      canvas.height = 0;
      glintRef.current?.replaceChildren();
    };

    const build = (): boolean => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const scale = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
      const reach = size === 'card'
        ? Math.min(90, Math.max(40, Math.round(0.42 * Math.min(w, h))))
        : 8;
      fields = iceFields({ w, h, scale, seed, reach, depth: size === 'card' ? 3 : 1 });
      const rects = textRects(host);
      rectKey = rectKeyOf(rects);
      keepOut = keepOutMask({ w, h, scale, rects });
      canvas.width = fields.width;
      canvas.height = fields.height;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      image = ctx.createImageData(fields.width, fields.height);
      return true;
    };

    const draw = (progress: number, melt: boolean): void => {
      if (!fields || !image) return;
      paintIce(image, fields, { progress, melting: melt, theme: readTheme(), keepOut });
      ctx.putImageData(image, 0, 0);
    };

    const placeGlints = (): void => {
      const holder = glintRef.current;
      if (!holder || !fields) return;
      holder.replaceChildren();
      if (reduced || melting) return;
      for (const p of glintPoints(fields, keepOut)) {
        const dot = document.createElement('span');
        dot.className = 'swap-ice-glint';
        dot.style.left = `${p.x}px`;
        dot.style.top = `${p.y}px`;
        holder.appendChild(dot);
      }
    };

    build();

    if (reduced) {
      draw(melting ? 0 : 1, melting);
      if (melting) { done(); }
      placeGlints();
    } else {
      const duration = melting ? MELT_MS : CREEP_MS;
      const from = performance.now();
      let slow = false;
      const step = (now: number): void => {
        if (stopped) return;
        const t = Math.min(1, (now - from) / duration);
        const before = performance.now();
        draw(melting ? 1 - t : t, melting);
        // The Mac is in swap: if the first frame costs this much, the animation
        // is part of the problem. Jump to the end instead of limping there.
        if (!slow && performance.now() - before > SLOW_FRAME_MS) {
          slow = true;
          draw(melting ? 0 : 1, melting);
          if (melting) done();
          placeGlints();
          return;
        }
        if (t < 1) { frame = requestAnimationFrame(step); return; }
        if (melting) done();
        placeGlints();
      };
      frame = requestAnimationFrame(step);
    }

    if (freeze) {
      // The host's own text moves (a ticking chip, a name that changes): the
      // mask is rebuilt only when the BOXES moved, and the canvas repainted once.
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const recheck = (): void => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (stopped || !fields) return;
          const next = textRects(host);
          const key = rectKeyOf(next);
          const rect = host.getBoundingClientRect();
          const resized = Math.round(rect.width) !== Math.round(fields.width / fields.scale)
            || Math.round(rect.height) !== Math.round(fields.height / fields.scale);
          if (!resized && key === rectKey) return;
          build();
          draw(1, false);
          placeGlints();
        }, 250);
      };
      const ro = new ResizeObserver(recheck);
      ro.observe(host);
      const mo = new MutationObserver(recheck);
      mo.observe(host, { childList: true, characterData: true, subtree: true });
      // The palette has two halves, and the theme can change under a freeze.
      const themeWatch = new MutationObserver(() => { if (fields) draw(1, false); });
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      observers = [ro, mo, themeWatch];
      observers.push({ disconnect: () => { if (debounce) clearTimeout(debounce); } });
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const o of observers) o.disconnect();
      host.removeAttribute('data-swap-ice');
      host.classList.remove('swap-ice-host');
    };
  }, [freeze, freeze?.id, size]);

  return (
    <>
      <canvas ref={canvasRef} className="swap-ice" width={0} height={0} aria-hidden="true" />
      <div ref={glintRef} className="swap-ice-glints" aria-hidden="true" />
    </>
  );
}
