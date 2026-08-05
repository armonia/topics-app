/**
 * The home page only: download resolution, the demo frame, checkout.
 *
 * Everything here touches an element that exists on `/` and nowhere else, which
 * is why it is a separate module — the changelog and the reading pages used to
 * download and parse all of it for the four lines they actually ran.
 */
import { $, $$, reduceMotion } from './site';

const REPO = 'armonia/topics-app';

/* ═══ the rotating agent name ══════════════════════════════════════════════
 * One slot in the sub-headline, doing the "works with" job above the fold
 * without spending a second row on it. The paragraph reads correctly with the
 * slot never changing, so JS off costs nothing, and it does not run for a
 * visitor who asked for less motion. */
const slot = $('#agentSlot');
if (slot && !reduceMotion) {
  const NAMES = ['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode'];
  let i = 0;
  setInterval(() => {
    i = (i + 1) % NAMES.length;
    slot.classList.add('is-out');
    setTimeout(() => {
      slot.textContent = NAMES[i];
      slot.classList.remove('is-out');
    }, 160);
  }, 2600);
}

/* ═══ downloads ════════════════════════════════════════════════════════════ */

type OS = 'mac' | 'win' | 'linux';

function detectOS(): OS {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/win/.test(ua)) return 'win';
  if (/linux|x11|ubuntu|fedora/.test(ua) && !/android/.test(ua)) return 'linux';
  return 'mac';
}
const os = detectOS();
const OS_LABEL: Record<OS, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

/**
 * Matchers for the files a release actually contains. Keep this list honest: a
 * slot with no matching asset silently leaves its link pointing at the releases
 * page, and the visitor clicks a download button that downloads nothing.
 *
 * There is no AppImage and there never will be on this pipeline — the Linux job
 * builds `--bundles deb,rpm` because linuxdeploy chokes on the ~100MB bun
 * sidecar. The page offered AppImage as the PRIMARY Linux download anyway, so
 * every Linux visitor hit a dead button while the .rpm that does exist was not
 * offered at all.
 */
const ASSET: Record<string, (n: string) => boolean> = {
  mac: (n) => /\.dmg$/i.test(n),   // one universal dmg since v1.0.3
  win: (n) => /\.exe$/i.test(n),
  msi: (n) => /\.msi$/i.test(n),
  deb: (n) => /\.deb$/i.test(n),
  rpm: (n) => /\.rpm$/i.test(n),
};
const PRIMARY_ASSET: Record<OS, string> = { mac: 'mac', win: 'win', linux: 'deb' };

const dlLabel = $('#primaryDownloadLabel');
const dlBtn = $<HTMLAnchorElement>('#primaryDownload');
const label = `Download for ${OS_LABEL[os]}`;
if (dlLabel) dlLabel.textContent = label;
if (dlBtn) dlBtn.setAttribute('aria-label', label);

const card = $(`.dl-card[data-os="${os}"]`);
if (card) {
  card.classList.add('is-primary');
  const first = card.querySelector(`[data-asset="${PRIMARY_ASSET[os]}"]`) ?? card.querySelector('.dl-link');
  first?.classList.add('is-primary');
}

/**
 * Releases are tagged `tauri-vX.Y.Z` because the tag is what triggers the build
 * workflow. That is a fact about our CI, not something a visitor should read.
 */
const prettyTag = (tag: string) => String(tag || '').replace(/^tauri-/, '');

interface Release {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

(async () => {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const rel = (await res.json()) as Release;
    const assets = rel.assets ?? [];
    const url = (slotName: string) => assets.find((x) => ASSET[slotName]?.(x.name))?.browser_download_url;

    for (const el of $$<HTMLAnchorElement>('[data-asset]')) {
      const u = url(el.dataset.asset ?? '');
      if (u) {
        el.href = u;
        el.removeAttribute('target');
      }
    }
    const primary = url(PRIMARY_ASSET[os]);
    if (dlBtn && primary) {
      dlBtn.href = primary;
      dlBtn.removeAttribute('target');
    }
    const tag = $('#latestTag');
    if (tag && rel.tag_name) tag.textContent = `· latest: ${prettyTag(rel.tag_name)}`;
    // The proof row is rendered from package.json at build time; if a release
    // has gone out since, this corrects it in place. Only the version string —
    // the surrounding sentence is the page's, not the API's.
    const version = $('#pillRelease');
    if (version && rel.tag_name) version.textContent = prettyTag(rel.tag_name);
  } catch {
    /* the fallback links already point at the releases page */
  }
})();

/* ═══ the demo ═════════════════════════════════════════════════════════════
 * The buttons do not animate anything themselves: they ask the embedded app to
 * play a named scene, and the app replies with what it is doing. The demo is
 * the REAL client, so it stays clickable throughout — when a visitor grabs the
 * mouse the app tells us it took over and we drop the active highlight. */

const frame = $<HTMLIFrameElement>('#demoFrame');
const chapterBtns = $$<HTMLButtonElement>('.chapter');
const demoStatus = $('#demoStatus');
const DEFAULT_STATUS = demoStatus?.textContent ?? '';
const stage = frame?.closest('.showcase') ?? null;

/**
 * The iframe ships with `data-src` and no `src`, so nothing loads until asked.
 * It is a full React client — 449KB on the wire, ~1.55MB to parse — and being
 * same-origin it shares this document's process and main thread. `loading=lazy`
 * was doing nothing: the frame starts around 585px and Chrome's lazy threshold
 * is 1250px, so it booted while the visitor was still reading the headline.
 *
 * One-way and idempotent. Setting `src` again reloads the app and throws away
 * whatever session the tour was in the middle of.
 */
let booted = false;
function boot(): boolean {
  if (booted || !frame?.dataset.src) return false;
  booted = true;
  frame.src = frame.dataset.src;
  stage?.classList.add('is-booted');
  /* The poster is a picture of the app; once the app is there, it is a picture
     of what is behind it. It fades on the frame's load rather than on a timer,
     so a slow machine never shows a blank frame under a removed poster. */
  frame.addEventListener('load', () => stage?.classList.add('is-live-shot'), { once: true });
  return true;
}

/* ── BOOTED ON ARRIVAL, NOT ON A CLICK ────────────────────────────────────
 * There used to be a play button on the poster. A play triangle asks a visitor
 * who has read one sentence to commit to watching something, and it is the one
 * gesture that turns the site's only genuinely unique asset — the real client,
 * running — into a thumbnail.
 *
 * So nobody presses anything. The page paints first and the client boots on the
 * next idle slot, which is the whole reason this is not simply `src` in the
 * HTML: the frame is same-origin, so it shares this document's main thread, and
 * 449KB of React parsed during the hero's first paint is paid for by the hero.
 * `requestIdleCallback` with a 2.5s ceiling means a busy machine still gets
 * there, just after everything that matters more.
 */
const idle: (cb: () => void, t: number) => void =
  'requestIdleCallback' in window
    ? (cb, t) => (window as unknown as { requestIdleCallback: (c: () => void, o: { timeout: number }) => void })
        .requestIdleCallback(cb, { timeout: t })
    : (cb, t) => { setTimeout(cb, Math.min(t, 400)); };

/* THE POSTER'S TAG NAME DECIDES, and this file is shared by two pages so that
 * matters. On /v3 the poster is a <div>: nothing to press, so the demo boots
 * itself. On the live home page it is still a <button>, and a page that ships a
 * button has to honour it — auto-booting there would leave a control that
 * announces itself to a screen reader, takes focus, and does nothing.
 * Keying on the element rather than on a page class means the behaviour follows
 * the markup that expresses it, and neither page can drift from its own. */
const poster = $('#demoPoster');
const gated = poster?.tagName === 'BUTTON';

if (gated) {
  poster?.addEventListener('click', () => {
    boot();
    try { frame?.focus(); } catch { /* focus is a nicety */ }
  });
} else if (frame) {
  if (document.readyState === 'complete') idle(boot, 2500);
  else addEventListener('load', () => idle(boot, 2500), { once: true });
}

if (frame && chapterBtns.length) {
  const post = (msg: Record<string, unknown>) => {
    try {
      frame.contentWindow?.postMessage({ source: 'topics-landing', ...msg }, '*');
    } catch {
      /* frame not ready — the click is simply a no-op */
    }
  };
  const markActive = (scene: string | null) => {
    for (const b of chapterBtns) b.classList.toggle('is-active', b.dataset.scene === scene);
  };

  for (const btn of chapterBtns) {
    btn.addEventListener('click', () => {
      const scene = btn.dataset.scene ?? '';
      markActive(scene);
      if (demoStatus) {
        demoStatus.textContent = btn.querySelector('.chapter__hint')?.textContent || DEFAULT_STATUS;
      }
      // Picking a chapter is also a request to start the demo. The app cannot
      // hear a postMessage before it has loaded, so on the very first click the
      // scene is sent from the frame's own load event instead.
      if (boot()) frame.addEventListener('load', () => post({ type: 'play', scene }), { once: true });
      else post({ type: 'play', scene });

      // The rail sits directly under the stage, so if you can reach a chapter
      // the app is almost certainly on screen. Scroll ONLY when the stage is
      // completely out of view; the earlier "bottom below the fold" test fired
      // on every click and yanked the page upward, taking the button the
      // visitor had just pressed with it.
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        stage.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }
    });
  }

  /* The scroll shield. An iframe consumes the wheel, so a visitor scrolling
   * past the demo used to get trapped: the pointer crosses the frame, the app's
   * own scroll containers eat the gesture, and the page stops. The shield is a
   * transparent layer in THIS document, so a wheel over it scrolls the page.
   *
   * Click to hand the demo over — the layer goes away and the app is fully live
   * underneath. It re-arms when the pointer leaves, so the next time you scroll
   * past, you scroll past. */
  const shield = $('#demoShield');
  if (shield && stage) {
    const setLive = (on: boolean) => {
      stage.classList.toggle('is-live', on);
      if (on) { try { frame.focus(); } catch { /* nicety */ } }
    };
    shield.addEventListener('click', () => { boot(); setLive(true); });
    // `mouseleave` does not fire while the pointer is inside the iframe, so
    // this only triggers on a real exit.
    stage.addEventListener('mouseleave', () => setLive(false));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.body.classList.contains('demo-expanded')) setLive(false);
    });
    // Picking a chapter is a request to WATCH, not to drive: keep the shield.
    for (const btn of chapterBtns) btn.addEventListener('click', () => setLive(false));
  }

  /* Expand. A class on <body>, never a DOM move: re-parenting the iframe
   * re-creates it, the app reloads, and whatever the tour was doing is gone. */
  const expandBtn = $<HTMLButtonElement>('#demoExpand');
  if (expandBtn) {
    let savedScroll = 0;
    const setExpanded = (on: boolean) => {
      if (on) { savedScroll = window.scrollY; boot(); }
      document.body.classList.toggle('demo-expanded', on);
      expandBtn.setAttribute('aria-expanded', String(on));
      const lbl = expandBtn.querySelector('.expand__label');
      if (lbl) lbl.textContent = on ? 'Close' : 'Expand';
      expandBtn.querySelector('use')?.setAttribute('href', on ? '#ic-collapse' : '#ic-expand');
      expandBtn.setAttribute('aria-label', on ? 'Close the expanded demo' : 'Expand the demo to fill the window');
      if (!on) window.scrollTo(0, savedScroll);
    };
    expandBtn.addEventListener('click', () => setExpanded(!document.body.classList.contains('demo-expanded')));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('demo-expanded')) setExpanded(false);
    });
  }

  addEventListener('message', (ev: MessageEvent) => {
    const d = ev?.data as { source?: string; type?: string; scene?: string } | undefined;
    if (!d || d.source !== 'topics-demo') return;
    if (d.type === 'scene-start') markActive(d.scene ?? null);
    else if (d.type === 'visitor-took-over') {
      markActive(null);
      if (demoStatus) demoStatus.textContent = "You're driving — the tour stepped aside.";
    }
  });
}

/* ═══ checkout ═════════════════════════════════════════════════════════════
 * Three plans, all of which can be delivered the day they are bought. Paste a
 * Stripe Payment Link below and the button becomes a checkout.
 *
 * Until a link exists the button is NOT a waitlist — a waitlist for a thing
 * that already exists is just a way of not taking money. It opens an email with
 * the plan in the subject, which is a real purchase path today: the invoice one
 * is how Commercial works anyway, and the other two get a link back by reply.
 * The markup ships with the working label, so JavaScript off sells the same
 * thing JavaScript on does.
 */
const CHECKOUT: Record<string, string> = {
  supporter: '',   // e.g. 'https://buy.stripe.com/xxxxxxxxxxxx'
  founding: '',
  commercial: '',  // stays empty on purpose: an invoice is a conversation
};
const SALES = 'topics@armonia.io';
const SUBJECT: Record<string, string> = {
  supporter: 'Topics Supporter',
  founding: 'Topics Founding user',
  commercial: 'Topics Commercial licence and invoice',
};

for (const el of $$<HTMLAnchorElement>('[data-checkout]')) {
  const plan = el.dataset.checkout ?? '';
  const url = CHECKOUT[plan];
  if (url) {
    el.href = url;
    el.setAttribute('rel', 'noopener');
    el.setAttribute('target', '_blank');
  } else {
    el.href = `mailto:${SALES}?subject=${encodeURIComponent(SUBJECT[plan] ?? 'Topics')}`;
  }
}
