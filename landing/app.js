/* Topics landing: behavior. Vanilla, no deps. */
(() => {
  'use strict';
  const REPO = 'armonia/topics-app';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  $('#year').textContent = new Date().getFullYear();

  /* sticky nav glass */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 12);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  /* cursor spotlight */
  if (!reduceMotion && matchMedia('(pointer:fine)').matches) {
    let raf = 0, mx = 50, my = 0;
    addEventListener('pointermove', (e) => {
      mx = (e.clientX / innerWidth) * 100; my = (e.clientY / innerHeight) * 100;
      if (!raf) raf = requestAnimationFrame(() => {
        document.body.style.setProperty('--mx', mx + '%');
        document.body.style.setProperty('--my', my + '%');
        raf = 0;
      });
    }, { passive: true });
  }

  /* scroll reveal */
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((el) => io.observe(el));
  } else { reveals.forEach((el) => el.classList.add('in')); }

  /* OS detection -> suggest current OS first */
  function detectOS() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const plat = (navigator.platform || '').toLowerCase();
    if (/win/.test(ua) || /win/.test(plat)) return 'win';
    if (/linux|x11|ubuntu|fedora/.test(ua) && !/android/.test(ua)) return 'linux';
    return 'mac';
  }
  const OS = detectOS();
  const OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' }[OS];

  const ASSET = {
    // ONE universal macOS dmg (Apple Silicon + Intel) since v1.0.3.
    'mac':      (n) => /\.dmg$/i.test(n),
    'win':      (n) => /\.exe$/i.test(n),
    'appimage': (n) => /\.appimage$/i.test(n),
    'deb':      (n) => /\.deb$/i.test(n),
  };
  const PRIMARY_ASSET = { mac: 'mac', win: 'win', linux: 'appimage' };

  // current OS card first (CSS uses .is-primary -> order:1) + labelled CTA
  const label = `Download for ${OS_LABEL}`;
  const dlLabel = $('#primaryDownloadLabel'); if (dlLabel) dlLabel.textContent = label;
  const dlBtn = $('#primaryDownload'); if (dlBtn) dlBtn.setAttribute('aria-label', label);
  const card = $(`.dl-card[data-os="${OS}"]`);
  if (card) {
    card.classList.add('is-primary');
    const first = card.querySelector(`[data-asset="${PRIMARY_ASSET[OS]}"]`) || card.querySelector('.dl-link');
    if (first) first.classList.add('is-primary');
  }

  async function resolveDownloads() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const assets = rel.assets || [];
      const url = (slot) => { const a = assets.find((x) => ASSET[slot] && ASSET[slot](x.name)); return a && a.browser_download_url; };
      $$('[data-asset]').forEach((el) => { const u = url(el.dataset.asset); if (u) { el.href = u; el.removeAttribute('target'); } });
      const pUrl = url(PRIMARY_ASSET[OS]);
      if (dlBtn && pUrl) { dlBtn.href = pUrl; dlBtn.removeAttribute('target'); }
      const tag = $('#latestTag'); if (tag && rel.tag_name) tag.textContent = `· latest: ${rel.tag_name}`;
      const pill = $('#pillRelease'); if (pill && rel.tag_name) pill.textContent = `${rel.tag_name} is out · macOS, Windows & Linux`;
    } catch (_) { /* keep fallback links to releases page */ }
  }
  resolveDownloads();

  /* ═══ demo chapters ═══════════════════════════════════════════════════════
   * The buttons don't animate anything themselves: they ask the embedded app to
   * play a named scene, and the app replies with what it is doing. The demo is
   * the REAL client, so it stays clickable throughout — when a visitor grabs the
   * mouse the app tells us it took over and we drop the active highlight. */
  const frame = $('#demoFrame');
  const chapterBtns = $$('.chapter');
  const demoStatus = $('#demoStatus');
  const DEFAULT_STATUS = demoStatus ? demoStatus.textContent : '';

  if (frame && chapterBtns.length) {
    const post = (msg) => {
      try { frame.contentWindow.postMessage(Object.assign({ source: 'topics-landing' }, msg), '*'); }
      catch (_) { /* frame not ready yet — the click is simply a no-op */ }
    };
    const markActive = (scene) => {
      chapterBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.scene === scene));
    };

    chapterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const scene = btn.dataset.scene;
        markActive(scene);
        if (demoStatus) demoStatus.textContent = (btn.querySelector('.chapter__hint') || {}).textContent || DEFAULT_STATUS;
        post({ type: 'play', scene });
        // Keep the stage in view: pressing a chapter from far down the rail
        // should not leave the visitor looking at buttons instead of the app.
        const stage = frame.closest('.showcase');
        if (stage && stage.getBoundingClientRect().bottom > window.innerHeight) {
          stage.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
        }
      });
    });

    addEventListener('message', (ev) => {
      const d = ev && ev.data;
      if (!d || d.source !== 'topics-demo') return;
      if (d.type === 'scene-start') markActive(d.scene);
      else if (d.type === 'visitor-took-over') {
        // The visitor is driving now. Stop claiming a chapter is playing.
        markActive(null);
        if (demoStatus) demoStatus.textContent = "You're driving — the tour stepped aside.";
      }
    });
  }

  /* ═══ checkout ════════════════════════════════════════════════════════════
   * Paid plans go through Stripe-hosted checkout: paste the Payment Link for
   * each plan below and the buttons become real. Until then they must NOT
   * pretend to sell — an empty link falls back to the waitlist, and the button
   * relabels itself so nobody clicks "Get Pro" into a dead end. */
  const CHECKOUT = {
    pro: '',    // e.g. 'https://buy.stripe.com/xxxxxxxxxxxx'
    team: '',   // e.g. 'https://buy.stripe.com/yyyyyyyyyyyy'
  };
  const WAITLIST = 'mailto:topics@armonia.io?subject=Topics%20Pro%20waitlist';

  $$('[data-checkout]').forEach((el) => {
    const plan = el.dataset.checkout;
    const url = CHECKOUT[plan];
    const labelEl = el.querySelector('span') || el;
    if (url) {
      el.href = url;
      el.setAttribute('rel', 'noopener');
      el.setAttribute('target', '_blank');
    } else {
      el.href = `${WAITLIST}%20(${plan})`;
      labelEl.textContent = plan === 'team' ? 'Join the Team waitlist' : 'Join the Pro waitlist';
      el.setAttribute('aria-label', `${labelEl.textContent} — checkout opens soon`);
      const card = el.closest('.plan');
      const fine = card && card.querySelector('.plan__fine');
      if (fine) fine.textContent = 'Opening soon — we will email you before we charge anyone.';
    }
  });

  /* star count */
  (async () => {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const j = await r.json();
      const n = j.stargazers_count;
      // 0 is worse social proof than no number — only show a real count.
      if (typeof n === 'number' && n > 0) { const el = $('#starCount'); if (el) el.textContent = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
    } catch (_) {}
  })();
})();
