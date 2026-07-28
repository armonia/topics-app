import { useEffect, useRef } from 'react';
import { readAuraEnergy, subscribeAuraTick, wakeAuraTicker } from '../lib/auraActivity';

// The "working" aura: a soft, blurred wave of iridescent smoke hugging the
// pane's edge while a session works. It replaces the old rotating-band + orbiter
// CSS.
//
// Rendering: a low-resolution <canvas> (1/DOWNSCALE of the pane) redrawn every
// frame, then upscaled by CSS to fill the pane. Real blur — a genuinely soft,
// edgeless haze — is the whole point, but blurring pane-sized content every
// frame is far too costly (CSS/SVG blur of changing geometry collapses to
// ~15fps at a few panes). Drawing at half resolution and blurring only those
// few pixels with ctx.filter, then letting the bilinear upscale blur further,
// gives the same soft look for a fraction of the cost — 60fps even at 9 panes.
//
// Shape: per frame we displace ~120 points sampled along the rounded-rect border
// by a small multi-harmonic sum `Σ Aₖ·sin(kₖ·s − ωₖ·t)` to get the wave contour,
// then FILL the region between the window edge and that contour as MANY nested
// rings (dense at the border, fading inward). Enough rings + a firm blur means
// the steps dissolve into a continuous falloff (few rings at low res read as
// blocky bands) — a soft iridescent vignette that fills up to the window, not a
// band along the wave. Three ~coprime integer harmonics make the crests all
// different (and morph over time); a slow envelope breathes the amplitude.
//
// Speed tracks activity: readAuraEnergy(activityId) rises with token/output
// throughput so the wave travels faster mid-stream and eases back on a lull; the
// phase is INTEGRATED (ph += speed·dt) so speed changes never teleport it. A
// single shared rAF drives every mounted aura (see auraActivity).

const SAMPLES = 120;
const DEFAULT_RADIUS = 16;
const DOWNSCALE = 2;     // canvas backing store = pane / DOWNSCALE (cheap blur, upscaled)
const LAYERS = 16;       // nested rings for the border→wave fill: many + blur = no visible steps
const LAYER_EASE = 1.4;  // >1 clusters rings near the edge, spreads them toward the wave → long soft inner fade
const BASE_SPEED = 1.6;

// ── Geometry is PROPORTIONAL to pane size ────────────────────────────────────
// All lengths below are FRACTIONS of the backing min-dimension (min(bw,bh) in
// backing px), so the aura looks identical on a big pane and a small one. With
// absolute px, a fixed blur was a smaller fraction of a big pane → it read as
// sharp/defined there and soft on small panes (why the demo looked harder than
// the app). Fractions make every pane — and the demo — match.
const INSET_FRAC = 0.05;        // constant band depth (always-present glow)
const INSET_SWELL_FRAC = 0.018; // slow breathing of that depth
const AMP_FRAC = 0.05;          // wave amplitude
const BLUR_FRAC = 0.12;         // ctx blur radius (the softness lever)

// wave shape (tuned live with Attilio: long, harmonious base + gentle overtones)
const CYCLES = 4;
const H1 = CYCLES;
const H2 = Math.max(2, Math.round(CYCLES * 1.7)); // 7
const H3 = Math.max(3, Math.round(CYCLES * 2.6)); // 10
const W_INSET = 0.5;
const ENV_DEPTH = 0.6;
const ENV_CYCLES = 1.5;
const W_ENV = 0.45;

interface AuraWaveProps {
  /** Activity key (chat: topic.sessionKey, terminal: sessionId). Drives speed. */
  activityId?: string;
  /** Corner radius to match the host pane (defaults to 16). */
  radius?: number;
  /** If true, reduce opacity + amplitude (watching phase: Monitor armed, not actively working). */
  muted?: boolean;
}

export function AuraWave({ activityId, radius = DEFAULT_RADIUS, muted = false }: AuraWaveProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<SVGPathElement>(null);
  // `muted` changes whenever the session flips working ⇄ watching, which is far
  // too often to justify tearing down the canvas and re-sampling the geometry.
  // The draw loop reads it through a ref instead, so the wave softens on the very
  // next frame with no restart (it used to be captured once and go stale).
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!host || !canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let P: { x: number; y: number }[] = [];
    let N: { x: number; y: number }[] = [];
    let RE: number[] = []; // per-point reach = distance to nearest corner centre
    let bw = 0;
    let bh = 0;
    let grad: CanvasGradient | null = null;

    const roundRectPath = (w: number, h: number, r: number): string => {
      r = Math.min(r, w / 2, h / 2);
      return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
    };
    // Trace the SQUARE canvas edge as the fill's outer boundary (inner boundary =
    // the wave contour, via evenodd). We deliberately do NOT trace a rounded rect:
    // the host (.chat-working-aura: overflow:hidden + border-radius:inherit) rounds
    // the visible corner, so the glow reaches the window's own rounded corner with
    // no second rounded contour drawn inside → no "border-radius frame" artifact.
    const squareTrace = (): void => {
      ctx.moveTo(0, 0);
      ctx.lineTo(bw, 0);
      ctx.lineTo(bw, bh);
      ctx.lineTo(0, bh);
      ctx.closePath();
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
      // Sample from the pane's OWN corner radius so the wave hugs the corner at a
      // uniform offset (a big sampling radius pushed the contour far from the
      // corner → corners read as "forcedly full"). Record per-point REACH =
      // distance to the nearest corner-arc centre; draw() soft-clamps each
      // displacement below its reach so the tight-corner offset can't invert.
      const r = Math.min(radius / DOWNSCALE, bw / 2, bh / 2);
      base.setAttribute('d', roundRectPath(bw, bh, r));
      const L = base.getTotalLength();
      if (!L) return;
      P = [];
      N = [];
      RE = [];
      const cx = bw / 2;
      const cy = bh / 2;
      const cc = [[r, r], [bw - r, r], [bw - r, bh - r], [r, bh - r]]; // corner centres
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
        let reach = 1e9;
        for (let c = 0; c < 4; c++) {
          const d = Math.hypot(a.x - cc[c][0], a.y - cc[c][1]);
          if (d < reach) reach = d;
        }
        P.push({ x: a.x, y: a.y });
        N.push({ x: nx, y: ny });
        RE.push(reach);
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
    // For muted (watching) phase: reduce per-ring opacity to ~0.5 cumulative
    // at the border (vs ~0.75 normally), making the wave more subtle.
    const ALPHA_MUTED = 1 - Math.pow(0.5, 1 / LAYERS);
    const ALPHA_ACTIVE = 1 - Math.pow(0.25, 1 / LAYERS);

    const draw = (): void => {
      const NS = P.length;
      if (!NS || !grad) return;
      ctx.clearRect(0, 0, bw, bh);
      const isMuted = mutedRef.current;
      const layerAlpha = isMuted ? ALPHA_MUTED : ALPHA_ACTIVE;
      const backMin = Math.min(bw, bh);
      const eased = energy * energy * (3 - 2 * energy);
      const ampMul = 0.85 + 0.35 * eased;
      // For muted (watching) phase: reduce amplitude by 50% to make the wave subtler
      const ampFrac = isMuted ? AMP_FRAC * 0.5 : AMP_FRAC;
      const A = backMin * ampFrac * ampMul;
      const inset = backMin * INSET_FRAC + backMin * INSET_SWELL_FRAC * Math.sin(W_INSET * phSlow);
      const blurB = Math.max(3, backMin * BLUR_FRAC);
      const k1 = (TWO * H1) / NS;
      const k2 = (TWO * H2) / NS;
      const k3 = (TWO * H3) / NS;
      const ke = (TWO * ENV_CYCLES) / NS;
      const p1 = -ph;
      const p2 = 0.5 * ph + 1.7;
      const p3 = -1.3 * ph + 3.1;
      const we = W_ENV * phSlow;
      const rB = Math.min(radius / DOWNSCALE, bw / 2, bh / 2); // pane corner radius (backing)
      const cfa = rB * 1.5; // wave fades 0→1 across this reach band near each corner
      const cfb = rB * 4.0;
      let disp = dispArr;
      if (!disp || disp.length !== NS) disp = dispArr = new Float64Array(NS);
      for (let i = 0; i < NS; i++) {
        const envF = 1 + ENV_DEPTH * Math.sin(ke * i - we);
        const wave =
          0.68 * Math.sin(k1 * i + p1) +
          0.24 * Math.sin(k2 * i + p2) +
          0.08 * Math.sin(k3 * i + p3);
        // corner-fade: taper the WAVE to 0 near the corner (reach→rB) so the tight
        // corner is a calm, constant arc instead of a wiggling, pinched curve; the
        // wave only plays on the straight edges (reach ≫ rB).
        let t = (RE[i] - cfa) / (cfb - cfa);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cf = t * t * (3 - 2 * t);
        let dd = inset + A * envF * wave * cf;
        if (dd < 0.5) dd = 0.5;
        // soft-limit the offset below ~0.8·reach so the corner arc stays open and
        // convex (never inverts, never collapses to a cusp); ~unchanged on straight
        // edges where reach is huge.
        const re = RE[i] * 0.8;
        disp[i] = re > 0.001 ? re * Math.tanh(dd / re) : dd;
      }
      // FILL the region window-edge → wave as nested rings anchored at the
      // border (dense at the border, fading to the wave), under a blur → a soft
      // iridescent vignette that reaches the window edge (fills up to it, not a
      // band along the wave). evenodd: outer square edge minus the wave contour;
      // the host's rounded clip shapes the corner, so no rounded frame is drawn.
      ctx.fillStyle = grad;
      ctx.filter = `blur(${blurB}px)`;
      ctx.globalAlpha = layerAlpha;
      for (let Lr = 0; Lr < LAYERS; Lr++) {
        // eased spacing: rings cluster near the edge and spread toward the wave,
        // so the inner tip is covered by fewer rings → a long, soft inner fade
        // (no "netto" boundary as the wave recedes).
        const f = Math.pow((Lr + 1) / LAYERS, LAYER_EASE);
        ctx.beginPath();
        squareTrace(); // outer boundary = square canvas edge (host rounds the corner)
        ctx.moveTo(P[0].x + N[0].x * disp[0] * f, P[0].y + N[0].y * disp[0] * f);
        for (let q = 1; q < NS; q++) {
          ctx.lineTo(P[q].x + N[q].x * disp[q] * f, P[q].y + N[q].y * disp[q] * f);
        }
        ctx.closePath();
        ctx.fill('evenodd');
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

    // Don't draw what nobody can see. An aura inside a `display:none` keepalive
    // shell (PaneKeepAlive) or scrolled out of the viewport has NO layout box, so
    // IntersectionObserver reports it as non-intersecting — the right gate, and a
    // free one. Without it every mounted aura burns LAYERS blurred fills per
    // frame that travel all the way to the GPU process without a single pixel
    // reaching the screen.
    //
    // We deliberately do NOT gate on window focus: native panes steal focus, and
    // freezing a wave the user is plainly looking at would be a visible bug (same
    // reasoning as auraActivity's ticker, which freezes only on document.hidden).
    // Starts `true` because the observer's first callback lands a frame later — a
    // genuinely visible aura must never flash blank at mount.
    let visible = true;
    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      // Il ticker si parcheggia quando NESSUNA aura interseca: se questa torna
      // sullo schermo va risvegliato, altrimenti resterebbe ferma per sempre.
      if (visible) wakeAuraTicker();
    });
    io.observe(host);

    let last = performance.now();
    // Il valore di ritorno dice al ticker se qualcuno ha davvero visto qualcosa:
    // se nessun'aura disegna, il loop smette di chiedere frame.
    const tick = (now: number): boolean => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05; // clamp on resume → no phase jump
      // `last` is already refreshed above, so dt stays small when we resume.
      if (!visible) return false;
      const target = readAuraEnergy(activityId);
      energy += (target - energy) * Math.min(1, dt / 0.6);
      const speedMul = 0.45 + 1.9 * (energy * energy * (3 - 2 * energy));
      ph += BASE_SPEED * speedMul * dt;
      phSlow += dt;
      draw();
      return true;
    };
    const unsubscribe = subscribeAuraTick(tick);

    return () => {
      ro.disconnect();
      io.disconnect();
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
