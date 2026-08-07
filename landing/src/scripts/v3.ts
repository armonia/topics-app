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
/* One state now, not two. The bar used to compute which ground was underneath
 * it on every scroll frame — three getBoundingClientRect() calls testing each
 * ink band against the bar's centre line — because the page had a light half and
 * a dark half. It has one ground, so the answer is always "ink" and the class is
 * gone from the stylesheet with it. What is left is whether the bar has left the
 * top of the page. */
const capsule = $('#capsule');
if (capsule) {
  const onScroll = () => capsule.classList.toggle('is-stuck', scrollY > 14);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
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

/* ── The field ───────────────────────────────────────────────────────────────
 * Nothing here. The background is one WebGL surface — see `fluid.ts` — and it
 * reads scroll and pointer itself, because it is the only consumer of either and
 * a uniform write beats a custom event.
 *
 * What this replaced: a pointer-tracking orb writing two custom properties per
 * frame, a section observer crossfading two field strengths, and a 2D canvas
 * drawing five hairlines and a travelling tick in #13161d — an ink colour, on a
 * ground that is now ink. That last one was the tell: a rAF loop, throttled to
 * 20fps and idled after six seconds, painting marks nobody could see. */

/* ── Parallax that means something ───────────────────────────────────────── */
/*
 * In every scene the actor and its context move at different rates, so the card
 * in front genuinely floats above the board it was taken from. That is the only
 * parallax on the page that carries an idea rather than an effect, and the
 * float over the hero is the second: it drifts against a stage that does not
 * move, because that stage is the live app and sliding a thing you can click is
 * not depth, it is a moving target.
 *
 * One rAF, geometry read once per frame, custom properties written once.
 */
if (!reduceMotion) {
  const scenes = $$<HTMLElement>('.scene');
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
    /* The float drifts against the stage, not with it: the stage holds the LIVE
       app now, and an iframe you can click is not something to slide around
       under the cursor. So the depth is carried entirely by the one layer that
       is allowed to move — matched rates would just be two things scrolling. */
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
