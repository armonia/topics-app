/**
 * What every page needs: the year, the sticky nav, the scroll reveal, the star
 * count.
 *
 * This was `public/app.js` — a 331-line IIFE served verbatim, so it was never
 * typechecked, never minified, never hashed, and every page loaded all of it
 * including the parts only the home page used. Now it is two modules under
 * `src/`, which means `astro check` reads them and Vite bundles them per page.
 */

const REPO = 'armonia/topics-app';

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $ = <T extends Element = Element>(s: string, r: ParentNode = document): T | null =>
  r.querySelector<T>(s);
export const $$ = <T extends Element = Element>(s: string, r: ParentNode = document): T[] =>
  [...r.querySelectorAll<T>(s)];

/* The copyright year, so nobody has to remember to change it in January. */
const year = $('#year');
if (year) year.textContent = String(new Date().getFullYear());

/* The nav grows a rule and a blur once you have left the top. */
const nav = $('#nav');
if (nav) {
  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 12);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

/* Scroll reveal. Nodes that never intersect stay hidden, so anything that must
   be readable without JavaScript must not carry `.reveal` — and if the observer
   is missing or motion is reduced, everything is shown at once. */
const reveals = $$('.reveal');
if ('IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of reveals) io.observe(el);
} else {
  for (const el of reveals) el.classList.add('in');
}

/* Star count. Zero is worse social proof than no number at all, so a repo with
   no stars simply shows nothing rather than advertising the fact. */
const starEl = $('#starCount');
if (starEl) {
  (async () => {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return;
      const j = (await r.json()) as { stargazers_count?: number };
      const n = j.stargazers_count;
      if (typeof n === 'number' && n > 0) {
        starEl.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      }
    } catch {
      /* no count is a fine outcome */
    }
  })();
}

/* Copy-to-clipboard for any `[data-copy="#id"]` button. Used by the block that
   hands an install prompt to an agent. */
for (const btn of $$<HTMLButtonElement>('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const target = $(btn.dataset.copy ?? '');
    if (!target?.textContent) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = was; }, 1600);
    } catch {
      /* Clipboard is permission-gated and can simply say no. The text is
         selectable, which is the fallback that always works. */
    }
  });
}
