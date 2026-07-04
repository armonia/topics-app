import { useEffect, useRef } from 'react';
import { readAuraEnergy, subscribeAuraTick } from '../lib/auraActivity';

// The "working" aura: a soft, blurred wave of iridescent smoke hugging the
// pane's edge while a session works. It replaces the old rotating-band + orbiter
// CSS.
//
// Rendering: a low-resolution <canvas> (1/DOWNSCALE of the pane) redrawn every
// frame, then upscaled by CSS to fill the pane. Real blur — a genuinely soft,
// edgeless haze — is the whole point, but blurring pane-sized content every
// frame is far too costly (CSS/SVG blur of changing geometry collapses to
// ~15fps at a few panes). Drawing at 1/3 resolution and blurring only those few
// pixels with ctx.filter, then letting the bilinear upscale blur further, gives
// the same soft look for ~1/9 the cost — 60fps even at 9 panes.
//
// Shape: per frame we displace ~120 points sampled along the rounded-rect border
// by a small multi-harmonic sum `Σ Aₖ·sin(kₖ·s − ωₖ·t)` to get the wave contour,
// then stroke it a few times (wide→narrow, faint→bright) under a blur — a soft
// glowing band with a bright core that fades on both sides. It follows the
// irregular wave rather than the rounded rectangle, so the corners never read as
// a framed edge. Three ~coprime integer harmonics make the crests all different
// (and morph over time); a slow envelope breathes the amplitude and band height.
//
// Speed tracks activity: readAuraEnergy(activityId) rises with token/output
// throughput so the wave travels faster mid-stream and eases back on a lull; the
// phase is INTEGRATED (ph += speed·dt) so speed changes never teleport it. A
// single shared rAF drives every mounted aura (see auraActivity).

const SAMPLES = 120;
const DEFAULT_RADIUS = 16;
const DOWNSCALE = 3;    // canvas backing store = pane / DOWNSCALE (cheap blur, upscaled)
const BLUR_BACKING = 5; // ctx blur in backing px (≈ DOWNSCALE× in screen px, + upscale)
const BASE_SPEED = 1.6;
// Blurred strokes centered on the wave contour ([screen-px width, alpha]). The
// glow follows the irregular wave — not the rounded rect — so the corners never
// read as a framed edge, and it fades softly on both sides of the wave.
const STROKES: readonly (readonly [number, number])[] = [[46, 0.18], [26, 0.30], [11, 0.48]];

// wave shape (tuned live with Attilio: long, harmonious base + gentle overtones)
const CYCLES = 4;
const H1 = CYCLES;
const H2 = Math.max(2, Math.round(CYCLES * 1.7)); // 7
const H3 = Math.max(3, Math.round(CYCLES * 2.6)); // 10
const AMP = 9;
const INSET = 24;
const INSET_SWELL = 6;
const W_INSET = 0.5;
const ENV_DEPTH = 0.6;
const ENV_CYCLES = 1.5;
const W_ENV = 0.45;

interface AuraWaveProps {
  /** Activity key (chat: topic.sessionKey, terminal: sessionId). Drives speed. */
  activityId?: string;
  /** Corner radius to match the host pane (defaults to 16). */
  radius?: number;
}

export function AuraWave({ activityId, radius = DEFAULT_RADIUS }: AuraWaveProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!host || !canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let P: { x: number; y: number }[] = [];
    let N: { x: number; y: number }[] = [];
    let bw = 0;
    let bh = 0;
    let grad: CanvasGradient | null = null;

    const roundRectPath = (w: number, h: number, r: number): string => {
      r = Math.min(r, w / 2, h / 2);
      return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
    };
    // Re-sample the border geometry (in backing-store pixels) on mount and on
    // resize. Uses the hidden <path>'s own measurement.
    const sample = (): void => {
      const cw = host.clientWidth;
      const ch = host.clientHeight;
      if (cw < 8 || ch < 8) return;
      bw = Math.max(1, Math.round(cw / DOWNSCALE));
      bh = Math.max(1, Math.round(ch / DOWNSCALE));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const r = Math.min(radius / DOWNSCALE, bw / 2, bh / 2);
      base.setAttribute('d', roundRectPath(bw, bh, r));
      const L = base.getTotalLength();
      if (!L) return;
      P = [];
      N = [];
      const cx = bw / 2;
      const cy = bh / 2;
      for (let i = 0; i < SAMPLES; i++) {
        const s = (i / SAMPLES) * L;
        const a = base.getPointAtLength(s);
        const b = base.getPointAtLength((s + 2) % L);
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        let nx = ty;
        let ny = -tx;
        if ((cx - a.x) * nx + (cy - a.y) * ny < 0) { nx = -nx; ny = -ny; } // inward
        P.push({ x: a.x, y: a.y });
        N.push({ x: nx, y: ny });
      }
      grad = ctx.createLinearGradient(0, 0, bw, bh);
      grad.addColorStop(0, '#32c8ff');
      grad.addColorStop(0.28, '#5e5ce6');
      grad.addColorStop(0.52, '#bf5af2');
      grad.addColorStop(0.74, '#ff6482');
      grad.addColorStop(1, '#32c8ff');
    };

    let ph = 0;
    let phSlow = 0;
    let energy = 0;
    let dispArr: Float64Array | null = null;
    const TWO = Math.PI * 2;

    const draw = (): void => {
      const NS = P.length;
      if (!NS || !grad) return;
      ctx.clearRect(0, 0, bw, bh);
      const eased = energy * energy * (3 - 2 * energy);
      const ampMul = 0.85 + 0.35 * eased;
      const A = (AMP * 1.35 * ampMul) / DOWNSCALE;
      const inset = (INSET + INSET_SWELL * Math.sin(W_INSET * phSlow)) / DOWNSCALE;
      const k1 = (TWO * H1) / NS;
      const k2 = (TWO * H2) / NS;
      const k3 = (TWO * H3) / NS;
      const ke = (TWO * ENV_CYCLES) / NS;
      const p1 = -ph;
      const p2 = 0.5 * ph + 1.7;
      const p3 = -1.3 * ph + 3.1;
      const we = W_ENV * phSlow;
      let disp = dispArr;
      if (!disp || disp.length !== NS) disp = dispArr = new Float64Array(NS);
      for (let i = 0; i < NS; i++) {
        const envF = 1 + ENV_DEPTH * Math.sin(ke * i - we);
        const wave =
          0.68 * Math.sin(k1 * i + p1) +
          0.24 * Math.sin(k2 * i + p2) +
          0.08 * Math.sin(k3 * i + p3);
        const dd = inset + A * envF * wave;
        disp[i] = dd < 1 ? 1 : dd;
      }
      // the wave contour (single closed loop), then stroke it a few times at
      // decreasing width / rising alpha — a soft glowing band with a bright core
      // that fades on both sides, following the wave (so no framed corners).
      ctx.beginPath();
      ctx.moveTo(P[0].x + N[0].x * disp[0], P[0].y + N[0].y * disp[0]);
      for (let q = 1; q < NS; q++) {
        ctx.lineTo(P[q].x + N[q].x * disp[q], P[q].y + N[q].y * disp[q]);
      }
      ctx.closePath();
      ctx.strokeStyle = grad;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.filter = `blur(${BLUR_BACKING}px)`;
      for (let s = 0; s < STROKES.length; s++) {
        ctx.globalAlpha = STROKES[s][1];
        ctx.lineWidth = STROKES[s][0] / DOWNSCALE;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
    };

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ro = new ResizeObserver(() => { sample(); if (reduce) draw(); });
    ro.observe(host);
    sample();
    if (reduce) {
      draw();
      return () => ro.disconnect();
    }

    let last = performance.now();
    const tick = (now: number): void => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05; // clamp on resume → no phase jump
      const target = readAuraEnergy(activityId);
      energy += (target - energy) * Math.min(1, dt / 0.6);
      const speedMul = 0.45 + 1.9 * (energy * energy * (3 - 2 * energy));
      ph += BASE_SPEED * speedMul * dt;
      phSlow += dt;
      draw();
    };
    const unsubscribe = subscribeAuraTick(tick);

    return () => {
      ro.disconnect();
      unsubscribe();
    };
  }, [activityId, radius]);

  return (
    <div ref={hostRef} className="chat-working-aura aura-canvas" aria-hidden="true">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <path ref={baseRef} />
      </svg>
      <canvas ref={canvasRef} />
    </div>
  );
}
