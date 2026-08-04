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

  /**
   * Matchers for the files a release actually contains. Keep this list honest:
   * a slot with no matching asset silently leaves its link pointing at the
   * releases page, and the visitor clicks a download button that downloads
   * nothing.
   *
   * There is no AppImage and there never will be on this pipeline: the Linux
   * job builds `--bundles deb,rpm` because linuxdeploy chokes on the ~100MB bun
   * sidecar. The page offered AppImage as the PRIMARY Linux download anyway, so
   * every Linux visitor hit a dead button while the .rpm that does exist was
   * not offered at all.
   */
  const ASSET = {
    // ONE universal macOS dmg (Apple Silicon + Intel) since v1.0.3.
    'mac':  (n) => /\.dmg$/i.test(n),
    'win':  (n) => /\.exe$/i.test(n),
    'msi':  (n) => /\.msi$/i.test(n),
    'deb':  (n) => /\.deb$/i.test(n),
    'rpm':  (n) => /\.rpm$/i.test(n),
  };
  const PRIMARY_ASSET = { mac: 'mac', win: 'win', linux: 'deb' };

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

  /**
   * Releases are tagged `tauri-vX.Y.Z` because the tag is what triggers the
   * build workflow. That is a fact about our CI, not a thing a visitor should
   * ever read: on the page the version is just `v2.2.11`.
   */
  function prettyTag(tag) {
    return String(tag || '').replace(/^tauri-/, '');
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
      const tag = $('#latestTag'); if (tag && rel.tag_name) tag.textContent = `· latest: ${prettyTag(rel.tag_name)}`;
      const pill = $('#pillRelease'); if (pill && rel.tag_name) pill.textContent = `${prettyTag(rel.tag_name)} is out for macOS, Windows and Linux`;
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
        // The rail sits directly under the stage, so if you can reach a chapter
        // the app is almost certainly already on screen. Scroll ONLY when the
        // stage is completely out of view; the earlier "bottom below the fold"
        // test fired on every click and yanked the page upward, taking the
        // button the visitor had just pressed with it.
        const stage = frame.closest('.showcase');
        if (!stage) return;
        const r = stage.getBoundingClientRect();
        const offscreen = r.bottom < 0 || r.top > window.innerHeight;
        if (offscreen) stage.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      });
    });

    /* Expand. A class on <body>, never a DOM move: re-parenting the iframe
     * re-creates it, the app reloads, and whatever the tour was doing is gone.
     * Scroll position is saved and restored by hand because `overflow:hidden`
     * on body loses it in some browsers. */
    const expandBtn = $('#demoExpand');
    if (expandBtn) {
      let savedScroll = 0;
      const setExpanded = (on) => {
        if (on) savedScroll = window.scrollY;
        document.body.classList.toggle('demo-expanded', on);
        expandBtn.setAttribute('aria-expanded', String(on));
        const label = expandBtn.querySelector('.expand__label');
        if (label) label.textContent = on ? 'Close' : 'Expand';
        const icon = expandBtn.querySelector('use');
        if (icon) icon.setAttribute('href', on ? '#ic-collapse' : '#ic-expand');
        expandBtn.setAttribute('aria-label', on ? 'Close the expanded demo' : 'Expand the demo to fill the window');
        if (!on) window.scrollTo(0, savedScroll);
      };
      expandBtn.addEventListener('click', () => setExpanded(!document.body.classList.contains('demo-expanded')));
      addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('demo-expanded')) setExpanded(false);
      });
    }

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
      // A Payment Link exists: promote the waitlist button into a real one, and
      // drop the "in progress" framing the markup ships with.
      el.href = url;
      el.setAttribute('rel', 'noopener');
      el.setAttribute('target', '_blank');
      labelEl.textContent = plan === 'team' ? 'Get Team' : 'Get Pro';
      const card = el.closest('.plan');
      if (card) {
        card.classList.remove('plan--soon');
        const badge = card.querySelector('.plan__badge');
        if (badge) badge.remove();
        const per = card.querySelector('.plan__per');
        if (per) per.textContent = per.textContent.replace(/,\s*planned$/, '');
        const fine = card.querySelector('.plan__fine');
        if (fine) fine.textContent = 'Cancel any time. The app keeps working without it.';
      }
    } else {
      // No link configured, which is today. The markup already reads as a
      // waitlist, so there is nothing to rewrite: just point it somewhere.
      el.href = `${WAITLIST}%20(${plan})`;
    }
  });

  /* ═══ type / backdrop lab ═════════════════════════════════════════════════
   * Add ?lab=1 to any URL to get a switcher for the `data-font` and `data-bg`
   * variants. It exists so the choice is made by looking at the real page with
   * real content, instead of at a swatch sheet where every font looks fine.
   * Absent the flag this costs one URL check and renders nothing. */
  (() => {
    const qs = new URLSearchParams(location.search);
    if (qs.get('lab') !== '1') return;

    // The page ships only the three families it renders. Pull the other
    // candidates in now, so comparing them is honest rather than a preview of
    // a system fallback wearing the right name.
    const extra = document.createElement('link');
    extra.rel = 'stylesheet';
    extra.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';
    document.head.appendChild(extra);

    const FONTS = [
      ['editorial', 'Gambarino + Switzer', 'Shipping. Display serif with real character, variable grotesque body, Commit Mono.'],
      ['bricolage', 'Bricolage Grotesque', 'One family, three optical sizes. What fly.io ships.'],
      ['inter', 'Inter', 'Neutral and everywhere. The safe, invisible choice.'],
      ['instrument', 'Instrument Serif', 'The previous pick. Thinner and more generic than Gambarino.'],
      ['plex', 'IBM Plex', 'Engineering heritage, one family throughout.'],
    ];
    const BGS = [
      ['weave', 'Weave', 'Dot lattice, one cool wash from the top.'],
      ['ink', 'Ink', 'Deep blue gradient with a beam behind the hero.'],
      ['carbon', 'Carbon', 'Flat. All colour comes from the content.'],
    ];
    const root = document.documentElement;
    const saved = { font: localStorage.getItem('lab-font'), bg: localStorage.getItem('lab-bg') };
    if (saved.font) root.setAttribute('data-font', saved.font);
    if (saved.bg) root.setAttribute('data-bg', saved.bg);

    // innerHTML is safe here: every string interpolated below comes from the
    // two const arrays a few lines up. No user input, no network data, and the
    // panel only ever exists behind an explicit ?lab=1 flag.
    const panel = document.createElement('div');
    panel.className = 'lab';
    const group = (title, items, attr, key) => `
      <div class="lab__group">
        <p class="lab__title">${title}</p>
        ${items.map(([v, name, note]) => `
          <button class="lab__opt" data-attr="${attr}" data-val="${v}" data-key="${key}" type="button">
            <span class="lab__name">${name}</span><span class="lab__note">${note}</span>
          </button>`).join('')}
      </div>`;
    panel.innerHTML =
      `<p class="lab__head">Pick a look</p>` +
      group('Type', FONTS, 'data-font', 'lab-font') +
      group('Backdrop', BGS, 'data-bg', 'lab-bg') +
      `<p class="lab__foot">Tell me the two names and I will make them the default, then drop the other fonts from the page.</p>`;
    document.body.appendChild(panel);

    const sync = () => {
      panel.querySelectorAll('.lab__opt').forEach((b) => {
        b.classList.toggle('is-on', root.getAttribute(b.dataset.attr) === b.dataset.val);
      });
    };
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('.lab__opt');
      if (!b) return;
      root.setAttribute(b.dataset.attr, b.dataset.val);
      try { localStorage.setItem(b.dataset.key, b.dataset.val); } catch (_) {}
      sync();
    });
    sync();
  })();

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
