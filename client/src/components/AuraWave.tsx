import { useEffect, useId, useRef } from 'react';
import { readAuraEnergy, subscribeAuraTick } from '../lib/auraActivity';

// The "working" aura: a real, dynamic wave of iridescent smoke that hugs the
// pane's edge while a session works. It replaces the old rotating-band +
// orbiter CSS.
//
// The wave is a filled band between the window edge and an INVISIBLE contour:
// per frame we displace ~140 points sampled along the rounded-rect border by a
// small multi-harmonic sum `Σ Aₖ·sin(kₖ·s − ωₖ·t)`. Softness comes from drawing
// LAYERS nested contours from the border to fractions of that depth, with graded
// opacity, so their overlap ramps the alpha 100→0 from the border to the wave —
// smoke, but with zero per-frame blur (blurring changing geometry is far too
// costly at many panes, and CSS blur on an inner SVG path doesn't render in
// WKWebView). Three ~coprime integer harmonics make the crests all different
// (and morph over time); a slow envelope breathes the amplitude and band height.
//
// Speed is driven by activity: readAuraEnergy(activityId) rises with how fast
// things are streaming and the wave travels faster; it decays and the wave
// eases back. The phase is INTEGRATED (ph += speed·dt) so speed changes never
// teleport the wave. All DOM writes go through refs + setAttribute — no React
// state per frame — and every mounted aura shares one rAF (see auraActivity).

const SAMPLES = 140;
const DEFAULT_RADIUS = 16;
const BASE_SPEED = 1.6; // travel rate at energy 0.5-ish; scaled by activity

// wave shape (tuned live with Attilio: long, harmonious base + gentle overtones)
const CYCLES = 4;
const H1 = CYCLES;
const H2 = Math.max(2, Math.round(CYCLES * 1.7)); // 7
const H3 = Math.max(3, Math.round(CYCLES * 2.6)); // 10
const AMP = 9;          // base amplitude gain
const INSET = 13;       // mean band depth (px)
const INSET_SWELL = 5;  // band-height breathing (px)
const W_INSET = 0.5;    // band-breathing rate
const ENV_DEPTH = 0.6;  // amplitude-breathing depth
const ENV_CYCLES = 1.5; // spatial envelope cycles around the loop
const W_ENV = 0.45;     // envelope drift rate
const LAYERS = 5;       // nested fog contours whose overlap makes the soft 100→0 falloff

interface AuraWaveProps {
  /** Activity key (chat: topic.sessionKey, terminal: sessionId). Drives speed. */
  activityId?: string;
  /** Corner radius to match the host pane (defaults to 16). */
  radius?: number;
}

export function AuraWave({ activityId, radius = DEFAULT_RADIUS }: AuraWaveProps) {
  const uid = useId().replace(/:/g, '');
  const gradId = 'aura-grad-' + uid;
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const baseRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const svg = svgRef.current;
    const base = baseRef.current;
    if (!host || !svg || !base) return;
    // Graded opacity across the nested contours: outer/thin layers most opaque,
    // the layer reaching the wave faintest → their overlap ramps alpha 100→0
    // from the border to the wave.
    const fogs = Array.from(svg.querySelectorAll<SVGPathElement>('.fog'));
    if (!fogs.length) return;
    fogs.forEach((f, i) => { f.style.opacity = (0.5 * (fogs.length - i) / fogs.length).toFixed(3); });

    let P: { x: number; y: number }[] = [];
    let N: { x: number; y: number }[] = [];
    let rectPath = '';

    const roundRect = (w: number, h: number, r: number): string => {
      r = Math.min(r, w / 2, h / 2);
      return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
    };

    // Re-sample the border geometry (positions + inward normals) on mount and
    // whenever the pane resizes. Uses the browser's own path measurement.
    const sample = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w < 8 || h < 8) return;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      rectPath = roundRect(w, h, radius);
      base.setAttribute('d', rectPath);
      const L = base.getTotalLength();
      if (!L) return;
      P = [];
      N = [];
      const cx = w / 2;
      const cy = h / 2;
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
    };

    let ph = 0;      // integrated travel phase
    let phSlow = 0;  // integrated real-time phase (breathing, activity-independent)
    let energy = 0;  // eased activity level 0..1
    const TWO = Math.PI * 2;

    let dispArr: Float64Array | null = null;
    // Build and commit the fog contours from the current phases + energy.
    const draw = (): void => {
      const NS = P.length;
      if (!NS) return;
      const eased = energy * energy * (3 - 2 * energy); // smoothstep
      const ampMul = 0.85 + 0.35 * eased;
      const A = AMP * 1.35 * ampMul;
      const inset = INSET + INSET_SWELL * Math.sin(W_INSET * phSlow);
      const k1 = (TWO * H1) / NS;
      const k2 = (TWO * H2) / NS;
      const k3 = (TWO * H3) / NS;
      const ke = (TWO * ENV_CYCLES) / NS;
      const p1 = -ph;
      const p2 = 0.5 * ph + 1.7;
      const p3 = -1.3 * ph + 3.1;
      const we = W_ENV * phSlow;
      // 1) wave depth from the border, per sampled point
      let disp = dispArr;
      if (!disp || disp.length !== NS) disp = dispArr = new Float64Array(NS);
      for (let i = 0; i < NS; i++) {
        const envF = 1 + ENV_DEPTH * Math.sin(ke * i - we);
        const wave =
          0.68 * Math.sin(k1 * i + p1) +
          0.24 * Math.sin(k2 * i + p2) +
          0.08 * Math.sin(k3 * i + p3);
        const dd = inset + A * envF * wave;
        disp[i] = dd < 1.5 ? 1.5 : dd; // keep the contour just inside the border
      }
      // 2) LAYERS nested rings [border → disp·f], f = (L+1)/K — evenodd fills, no
      //    blur; their graded-opacity overlap is the soft haze.
      const K = fogs.length;
      for (let L = 0; L < K; L++) {
        const f = (L + 1) / K;
        let d = '';
        for (let q = 0; q <= NS; q++) {
          const j = q % NS;
          const dep = disp[j] * f;
          const x = P[j].x + N[j].x * dep;
          const y = P[j].y + N[j].y * dep;
          d += (q === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
        }
        fogs[L].setAttribute('d', rectPath + ' ' + d + 'Z');
      }
    };

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ro = new ResizeObserver(() => { sample(); if (reduce) draw(); });
    ro.observe(host);
    sample();

    if (reduce) {
      draw(); // one static, shaped haze — still a cue, no motion
      return () => ro.disconnect();
    }

    let last = performance.now();
    const tick = (now: number): void => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05; // clamp (tab throttling / resume) → no phase jump
      const target = readAuraEnergy(activityId);
      energy += (target - energy) * Math.min(1, dt / 0.6); // low-pass ease
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
    <div ref={hostRef} className="chat-working-aura aura-wave" aria-hidden="true">
      <svg ref={svgRef} className="wave-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#32c8ff" />
            <stop offset="28%" stopColor="#5e5ce6" />
            <stop offset="52%" stopColor="#bf5af2" />
            <stop offset="74%" stopColor="#ff6482" />
            <stop offset="100%" stopColor="#32c8ff" />
          </linearGradient>
        </defs>
        <path ref={baseRef} className="base" />
        {Array.from({ length: LAYERS }, (_, i) => (
          <path key={i} className="fog" style={{ fill: `url(#${gradId})` }} />
        ))}
      </svg>
    </div>
  );
}
