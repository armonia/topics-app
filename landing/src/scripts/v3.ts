/**
 * v3 — the field, the parallax, and the arrivals.
 *
 * Three rules this file obeys, because the page it runs on is unusual:
 *
 * 1. NOTHING HERE IS LOAD-BEARING. Every element it touches is readable and
 *    complete without it. The reveal class is ADDED by this script rather than
 *    written into the markup, so a visitor with no JavaScript gets the page at
 *    full opacity instead of a blank column — which is the failure mode of
 *    every `.reveal { opacity: 0 }` written by hand.
 *
 * 2. THE MAIN THREAD IS SHARED WITH THE PRODUCT. The demo section boots the
 *    real React client in a same-origin iframe, which means it runs in this
 *    page's process, on this thread. The lattice stops drawing entirely while
 *    the demo is live, while the tab is hidden, in sections that do not want it,
 *    and after six seconds without a scroll or a pointer move.
 *
 * 3. ONE rAF, ONE READ. Scroll work happens in a single frame callback that
 *    reads geometry once and writes custom properties once. Anything that reads
 *    `getBoundingClientRect` inside a loop over many elements pays for a layout
 *    per element, which is how a "smooth" parallax ends up being the jank.
 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = <T extends Element = Element>(s: string, r: ParentNode = document): T | null =>
  r.querySelector<T>(s);
const $$ = <T extends Element = Element>(s: string, r: ParentNode = document): T[] =>
  [...r.querySelectorAll<T>(s)];

const body = document.body;

/* ── Arrivals ────────────────────────────────────────────────────────────── */
/* Applied here, not in the markup: see rule 1. */
const REVEALABLE = [
  '.shead', '.model__step', '.act__body', '.act__stage',
  '.compare__scroll', '.limits__item', '.limits__cta', '.more__item',
  '.plan', '.faq > div', '.dl-card', '.gate', '.agents-block', '.chapters',
].join(',');

if (!reduceMotion && 'IntersectionObserver' in window) {
  const targets = $$(REVEALABLE);
  for (const el of targets) el.classList.add('reveal');
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    },
    { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
  );
  /* Stagger inside a group, capped at four. Past the fourth the delay stops
     reading as rhythm and starts reading as a queue. */
  for (const el of targets) {
    const sibs = el.parentElement ? [...el.parentElement.children] : [];
    const i = Math.min(sibs.indexOf(el), 3);
    (el as HTMLElement).style.setProperty('--d', String(Math.max(0, i)));
    io.observe(el);
  }
}

/* ── The headline, composed out of characters ────────────────────────────── */
/* 6ms apart. The whole string goes into aria-label first, or a screen reader
   announces thirty-eight separate letters. */
const title = $<HTMLElement>('#heroTitle');
if (title && !reduceMotion) {
  const text = title.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  title.setAttribute('aria-label', text);
  let i = 0;
  const wrap = (node: Node): Node => {
    /* `.dim` is left whole. Its colour is a gradient clipped to text, and
       `background-clip: text` clips to the text of the element that carries the
       background — split it into child spans and the parent has no text of its
       own left to clip to, so the phrase paints nothing at all. It arrives as
       one block instead, which also reads better: the first line assembles
       itself, the second one lands. */
    if (node instanceof HTMLElement && node.classList.contains('dim')) {
      node.style.setProperty('--i', String(i + 6));
      node.classList.add('ch-block');
      return node;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      for (const ch of node.textContent ?? '') {
        const s = document.createElement('span');
        s.className = 'ch';
        s.setAttribute('aria-hidden', 'true');
        s.style.setProperty('--i', String(i++));
        s.textContent = ch;
        frag.appendChild(s);
      }
      return frag;
    }
    const clone = node.cloneNode(false);
    for (const kid of [...node.childNodes]) clone.appendChild(wrap(kid));
    return clone;
  };
  const rebuilt = document.createDocumentFragment();
  for (const kid of [...title.childNodes]) rebuilt.appendChild(wrap(kid));
  title.replaceChildren(rebuilt);
}

/* `is-ready` starts the headline and the travelling gradient together, after
   the webfont has settled — otherwise the characters animate in the fallback
   face and then jump when Switzer arrives. */
const ready = () => body.classList.add('is-ready');
if ('fonts' in document) {
  const t = setTimeout(ready, 900);          // never wait on a font that fails
  document.fonts.ready.then(() => { clearTimeout(t); ready(); }).catch(ready);
} else ready();

/* ── The capsule ─────────────────────────────────────────────────────────── */
/* Two states, and the second one exists because the page now has two grounds.
 * The bar floats over both, so it cannot pick a colour once: over paper it is
 * dark ink on light glass, over an ink band it has to invert.
 *
 * It is decided by GEOMETRY, not by the section observer. The observer answers
 * "what am I reading", which is the middle of the viewport; the bar needs
 * "what is directly underneath me", which is 46px from the top. Those two
 * disagree for about 60px on either side of every seam, and a nav that flips
 * colour half a section early is worse than one that never flips at all.
 *
 * Cost: three getBoundingClientRect() calls on a scroll that is already
 * running one. Both classes are set in the same handler so there is no second
 * listener and no second layout read. */
const capsule = $('#capsule');
if (capsule) {
  const bands = $$<HTMLElement>('.band--ink');
  const CAPSULE_MID = 46;
  const onScroll = () => {
    capsule.classList.toggle('is-stuck', scrollY > 14);
    let overInk = false;
    for (const b of bands) {
      const r = b.getBoundingClientRect();
      if (r.top <= CAPSULE_MID && r.bottom >= CAPSULE_MID) { overInk = true; break; }
    }
    document.body.classList.toggle('is-ink', overInk);
  };
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

/* ── The orb ─────────────────────────────────────────────────────────────── */
/* A light that follows the pointer, one per ink band, clipped to ink by the
 * band's own clip-path. Written as two custom properties on the root so all
 * four orbs read the same pair and there is one style write per frame rather
 * than four.
 *
 * The position is NOT transitioned in CSS — the glow snaps and only its
 * presence fades — so this handler has to be the thing that is smooth. It
 * coalesces to one rAF: a pointermove can fire far more often than the display
 * refreshes, and writing a custom property on every one of them is how an
 * effect this cheap ends up costing frames on a page that also runs a canvas
 * and a live React iframe.
 */
if (!matchMedia('(hover: none), (pointer: coarse)').matches
    && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const root = document.documentElement;
  let px = 0, py = 0, queued = false;
  const paint = () => {
    queued = false;
    root.style.setProperty('--orb-x', px + 'px');
    root.style.setProperty('--orb-y', py + 'px');
  };
  addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (!document.body.classList.contains('is-hovering')) document.body.classList.add('is-hovering');
    if (!queued) { queued = true; requestAnimationFrame(paint); }
  }, { passive: true });
  /* Leaving the window takes the light with you, rather than leaving it stuck
     wherever the pointer crossed the edge. */
  addEventListener('pointerleave', () => document.body.classList.remove('is-hovering'), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) document.body.classList.remove('is-hovering');
  });
}

/* ── Counters ────────────────────────────────────────────────────────────── */
/* The proof numbers now sit inside the hero, so they arrive with it. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
if (!reduceMotion) {
  for (const el of $$<HTMLElement>('[data-count]')) {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to)) continue;
    const io = new IntersectionObserver((en) => {
      if (!en[0].isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / 900);
        el.textContent = group(Math.round(to * easeOut(p)));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(el);
  }
}

/* ── The field: which register the page is in ────────────────────────────── */
/* Sections declare `data-field`; the field crossfades between the states. The
   observer watches the middle band of the viewport, so the state belongs to
   whatever you are actually looking at rather than to whatever is entering. */
const field = $<HTMLElement>('.field');
const STATES: Record<string, { lattice: number; wash: number }> = {
  dense: { lattice: 1, wash: 1 },
  quiet: { lattice: 0.42, wash: 0.45 },
  deep: { lattice: 0, wash: 0.7 },
};
let latticeWanted = 1;

if (field) {
  const marked = $$<HTMLElement>('[data-field]');
  const setState = (name: string) => {
    const s = STATES[name] ?? STATES.quiet;
    field.style.setProperty('--lattice', String(s.lattice));
    field.style.setProperty('--wash', String(s.wash));
    latticeWanted = s.lattice;
  };
  setState('dense');
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        setState((en.target as HTMLElement).dataset.field ?? 'quiet');
      }
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
  );
  for (const el of marked) io.observe(el);
}

/* ── The field: the lattice ──────────────────────────────────────────────── */
/*
 * A grid of dots on a 30px pitch, with a slow wave crossing it. Two things move
 * and neither of them is an element: the wave phase, and a vertical offset
 * derived from scroll — that offset is the parallax. Because it happens inside
 * the canvas, the parallax costs no layout and cannot shift anything.
 *
 * Everything about this is throttled on purpose. See rule 2 at the top.
 */
const canvas = $<HTMLCanvasElement>('#fieldLattice');
if (canvas && !reduceMotion) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (ctx) {
    /*
     * A first version of this drew a dot every 30px across the whole viewport:
     * about 1,300 marks, on a fixed pitch, related to nothing. That is
     * wallpaper, and wallpaper behind a screenshot is the exact thing this site
     * removed once already.
     *
     * What it draws instead is the page's OWN GRID: five vertical hairlines at
     * the edges and quarter points of the 1,180px content column — the same
     * divisions the long-tail grid and the pricing row are built on — and a tick
     * every 96px along the two outer ones. About forty marks instead of
     * thirteen hundred.
     *
     * The lines do not move, because they are registered to the layout and a
     * ruler that drifts is not a ruler. The TICKS move, at 0.12 of the scroll:
     * a travelling index against a fixed reference, which is what a measuring
     * instrument looks like and what a field of drifting dots never does.
     */
    const TICK = 96;
    const FPS = 20;
    const FRAME = 1000 / FPS;
    const IDLE_AFTER = 6000;
    const MAXW = 1180, PAD = 24;

    let dpr = 1, w = 0, h = 0;
    let xs: number[] = [];
    let raf = 0, last = 0, phase = 0;
    let lastActivity = performance.now();
    let running = false;

    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      w = innerWidth; h = innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const inner = Math.min(MAXW, w - PAD * 2);
      const left = (w - inner) / 2;
      /* Half-pixel offsets, or a 1px line straddles two device pixels and
         renders as a 2px smear at 40% alpha. */
      xs = [0, .25, .5, .75, 1].map((f) => Math.round(left + inner * f) + 0.5);
    };

    const draw = () => {
      const off = (scrollY * 0.12) % TICK;      // the travelling index
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#13161d';
      ctx.fillStyle = '#13161d';
      ctx.lineWidth = 1;

      /* The rules. Outer pair a touch stronger than the quarter marks, the way
         a scale reads: majors and minors. */
      for (let i = 0; i < xs.length; i++) {
        ctx.globalAlpha = i === 0 || i === xs.length - 1 ? 0.055 : 0.032;
        ctx.beginPath();
        ctx.moveTo(xs[i], 0);
        ctx.lineTo(xs[i], h);
        ctx.stroke();
      }

      /* The index. One slow breath across it so it reads as alive rather than
         as a static overlay — 0.024 of amplitude, which is under the threshold
         where anyone would call it an animation. */
      const breathe = 0.012 * Math.sin(phase) + 0.052;
      for (let y = -TICK + off; y < h + TICK; y += TICK) {
        ctx.globalAlpha = breathe;
        for (const edge of [xs[0], xs[xs.length - 1]]) {
          ctx.beginPath();
          ctx.moveTo(edge - 4.5, Math.round(y) + 0.5);
          ctx.lineTo(edge + 4.5, Math.round(y) + 0.5);
          ctx.stroke();
        }
        ctx.globalAlpha = breathe * 0.7;
        for (let i = 1; i < xs.length - 1; i++) {
          ctx.beginPath();
          ctx.arc(xs[i], Math.round(y), 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME) return;
      last = now;
      if (now - lastActivity > IDLE_AFTER) { stop(); return; }
      phase += 0.028;
      draw();
    };

    /* Nine ways this stops, and every one of them is a real machine somebody
       is using. The one that matters most is the third: once the demo iframe
       has been asked for, the React client is booting on this same thread, and
       a background animation stealing frames from the product you are trying to
       sell is the worst trade on the page. */
    type Nav = Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    const nav = navigator as Nav;
    const cheapDevice =
      nav.connection?.saveData === true ||
      (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 4) ||
      matchMedia('(pointer: coarse)').matches;

    const start = () => {
      if (running || document.hidden || latticeWanted === 0 || cheapDevice) return;
      if ($('.showcase.is-booted') || $('.showcase.is-live')) return;
      running = true; last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    const poke = () => { lastActivity = performance.now(); start(); };

    resize();
    draw();          // the grid exists even where it never animates
    start();

    addEventListener('resize', () => { resize(); draw(); poke(); }, { passive: true });
    addEventListener('scroll', poke, { passive: true });
    addEventListener('pointermove', poke, { passive: true });
    document.addEventListener('visibilitychange', () => { document.hidden ? stop() : poke(); });
  }
}

/* ── Parallax that means something ───────────────────────────────────────── */
/*
 * In every scene the actor and its context move at different rates, so the card
 * in front genuinely floats above the board it was taken from. That is the only
 * parallax on the page that carries an idea rather than an effect; the hero
 * screenshot gets a much smaller one so the crop at the fold feels like a
 * window rather than a picture.
 *
 * One rAF, geometry read once per frame, custom properties written once.
 */
if (!reduceMotion) {
  const scenes = $$<HTMLElement>('.scene');
  const shot = $<HTMLElement>('.hero__shot');
  const float = $<HTMLElement>('.hero__float');
  let ticking = false;

  const onFrame = () => {
    ticking = false;
    const vh = innerHeight;
    for (const s of scenes) {
      const r = s.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) continue;
      /* −1 when the scene is entering from the bottom, +1 when it is leaving
         at the top, 0 when it is centred. */
      const p = ((r.top + r.height / 2) - vh / 2) / (vh / 2 + r.height / 2);
      s.style.setProperty('--par', (Math.max(-1, Math.min(1, p))).toFixed(3));
    }
    /* Only where the stage actually crops. Below 700px the frame's height comes
       from the image, so sliding the image inside it just lifts it away from
       its own bottom edge — 42px of daylight under a window that is supposed to
       be flush. The breakpoint is the one the stylesheet uses for the same
       decision, so the two cannot disagree. */
    if (shot) {
      const y = innerWidth > 700 ? Math.min(scrollY, 700) * -0.06 : 0;
      shot.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
    }
    /* The float drifts against the shot, not with it. Same scroll, opposite
       sign and two and a half times the rate: that difference IS the depth —
       matched rates would just be two things scrolling. Only the layer that
       needs to look detached is allowed to move much. */
    if (float) {
      const y = Math.min(scrollY, 700) * 0.15;
      float.style.setProperty('--float-y', `${y.toFixed(1)}px`);
    }
  };

  const request = () => { if (!ticking) { ticking = true; requestAnimationFrame(onFrame); } };
  request();
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request, { passive: true });
}
