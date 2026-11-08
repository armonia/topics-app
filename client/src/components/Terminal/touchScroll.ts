import type { Terminal } from '@xterm/xterm';

// xterm 6 leaves mobile users stuck on the thin scrollbar because .xterm-screen
// sits above .xterm-viewport and absorbs touches. Capture-phase listeners on the
// container hijack vertical swipes before xterm's pointer handlers and drive the
// scroll via the public `scrollLines` API. On touchend a RAF loop continues the
// flick with exponential friction so it decelerates like iOS.
export function attachTerminalTouchScroll(el: HTMLElement, term: Terminal): () => void {
  const ac = new AbortController();
  const { signal } = ac;

  let startY = 0;
  let startX = 0;
  let linesScrolled = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let mode: 'idle' | 'pending' | 'scrolling' = 'idle';
  let momentumFrame: number | null = null;

  const getLineHeight = () => {
    const vp = el.querySelector('.xterm-viewport') as HTMLElement | null;
    const rows = term.rows || 24;
    const h = vp?.clientHeight ?? el.clientHeight;
    return h > 0 && rows > 0 ? h / rows : 17;
  };

  const stopMomentum = () => {
    if (momentumFrame !== null) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
    }
  };

  el.addEventListener('touchstart', (e) => {
    stopMomentum();
    if (e.touches.length !== 1) { mode = 'idle'; return; }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    linesScrolled = 0;
    lastY = startY;
    lastT = performance.now();
    velocity = 0;
    mode = 'pending';
  }, { passive: true, capture: true, signal });

  el.addEventListener('touchmove', (e) => {
    if (mode === 'idle' || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = startY - y;
    const dx = x - startX;
    if (mode === 'pending') {
      if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) {
        mode = 'scrolling';
      } else if (Math.abs(dx) > 6) {
        mode = 'idle';
        return;
      } else {
        return;
      }
    }
    const lineHeight = getLineHeight();
    const totalLines = Math.round(dy / lineHeight);
    const delta = totalLines - linesScrolled;
    if (delta !== 0) {
      try { term.scrollLines(delta); } catch {}
      linesScrolled = totalLines;
    }
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0 && dt < 100) {
      const instantV = (lastY - y) / dt;
      velocity = 0.7 * velocity + 0.3 * instantV;
    }
    lastY = y;
    lastT = now;
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false, capture: true, signal });

  const endTouch = () => {
    if (mode === 'scrolling' && Math.abs(velocity) > 0.12) {
      const lineHeight = getLineHeight();
      let lineAccumulator = 0;
      let lastFrame = performance.now();
      const tick = () => {
        if (signal.aborted) { momentumFrame = null; return; }
        const now = performance.now();
        const dt = Math.min(now - lastFrame, 32);
        lastFrame = now;
        lineAccumulator += (velocity * dt) / lineHeight;
        const linesNow = Math.trunc(lineAccumulator);
        if (linesNow !== 0) {
          try { term.scrollLines(linesNow); } catch {}
          lineAccumulator -= linesNow;
        }
        // Friction ~0.95 per 16.67ms frame — matches iOS deceleration feel
        velocity *= Math.pow(0.95, dt / 16.67);
        if (Math.abs(velocity) > 0.02) {
          momentumFrame = requestAnimationFrame(tick);
        } else {
          momentumFrame = null;
        }
      };
      momentumFrame = requestAnimationFrame(tick);
    }
    mode = 'idle';
  };
  el.addEventListener('touchend', endTouch, { passive: true, capture: true, signal });
  el.addEventListener('touchcancel', endTouch, { passive: true, capture: true, signal });

  signal.addEventListener('abort', stopMomentum);

  return () => ac.abort();
}
