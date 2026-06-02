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

  /* terminal "agent" typing (Claude Code style, demo) */
  const term = $('#term');
  const lines = [
    '<span class="c-prompt">~/topics-app</span> <span class="c-cmd">claude</span> <span class="c-dim">"ship the v1.1 release"</span>',
    '<span class="c-violet">✻ Claude Code</span> <span class="c-dim">v2.1 · Opus 4.8 (1M context)</span>',
    '<span class="c-dim">● Reading project context…</span>',
    '<span class="c-blue">✱ Plan</span> <span class="c-dim">4 steps: bump version, tag, build, publish</span>',
    '<span class="c-dim">  → electron-app/package.json  v1.1.0</span>',
    '<span class="c-dim">  → git tag v1.1.0 &amp;&amp; git push origin v1.1.0</span>',
    '<span class="c-ok">✓ Release workflow triggered</span> <span class="c-dim">macOS · Windows · Linux</span>',
    '<span class="c-ok">✓ Done</span> <span class="c-dim">3 files changed · pushed to main</span>',
  ];
  const delays = [90, 520, 560, 620, 360, 360, 660, 420];
  function renderTerminal() {
    if (!term) return;
    if (reduceMotion) { term.innerHTML = lines.join('\n') + '\n<span class="c-prompt">~/topics-app</span> <span class="caret"></span>'; return; }
    let i = 0;
    const step = () => {
      if (i >= lines.length) { term.insertAdjacentHTML('beforeend', '\n<span class="c-prompt">~/topics-app</span> <span class="caret"></span>'); return; }
      term.insertAdjacentHTML('beforeend', (i ? '\n' : '') + lines[i]);
      const d = delays[i] || 400; i++; setTimeout(step, d);
    };
    setTimeout(step, 600);
  }
  if (term) {
    if ('IntersectionObserver' in window && !reduceMotion) {
      const tio = new IntersectionObserver((e) => { if (e[0].isIntersecting) { tio.disconnect(); renderTerminal(); } }, { threshold: 0.25 });
      tio.observe(term);
    } else { renderTerminal(); }
  }

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
    'mac-arm':  (n) => /arm64.*\.dmg$/i.test(n),
    'mac-intel':(n) => /\.dmg$/i.test(n) && !/arm64/i.test(n),
    'win':      (n) => /\.exe$/i.test(n),
    'appimage': (n) => /\.appimage$/i.test(n),
    'deb':      (n) => /\.deb$/i.test(n),
  };
  const PRIMARY_ASSET = { mac: 'mac-arm', win: 'win', linux: 'appimage' };

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
    } catch (_) { /* keep fallback links to releases page */ }
  }
  resolveDownloads();

  /* star count */
  (async () => {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const j = await r.json();
      const n = j.stargazers_count;
      if (typeof n === 'number') { const el = $('#starCount'); if (el) el.textContent = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
    } catch (_) {}
  })();
})();
