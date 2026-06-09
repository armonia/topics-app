/* ─────────────────────────────────────────────────────────────────────────
 * Topics landing demo — ghost cursor (classic script, injected at BODY END)
 *
 * An animated macOS-style pointer that visibly *uses* the embedded demo:
 * it switches Claude Code tabs, drags the terminal/preview split, focuses
 * the acme-api window and resizes the bottom window row — all by driving
 * the REAL app (synthetic MouseEvents through React's own handlers and the
 * useGridResize window listeners), never by faking pixels.
 *
 * Event contracts it relies on (see the components):
 *   - PaneTabBar tab activation = onClick on `[data-pane-id]` (bubbles).
 *   - GroupLayout inner divider  = `[data-divider-row][data-divider-col]`,
 *     onMouseDown on the divider, then window mousemove / window mouseup
 *     (useGridResize — plain MouseEvents, NO pointer capture).
 *   - PanelGrid app-level divider = `[data-panel-divider-row][data-panel-divider-col]`,
 *     same mousedown→window-move→window-up protocol.
 *
 * Hard rules: never opens menus/modals, never navigates, never touches
 * localStorage. Skips entirely under prefers-reduced-motion; pauses between
 * steps while the document is hidden. Every step re-queries its target and
 * silently skips when missing. Defensive try/catch everywhere — the demo
 * must never break because of the choreography.
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  try {
    if (window.__landingGhostCursor) return;
    window.__landingGhostCursor = true;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (e) { return; }

  var START_AT_MS = 6000;     // ≈3s after the WS transcripts finish streaming
  var LOOP_PAUSE_MS = 25000;  // long pause between rounds
  var GLIDE_EASE = "cubic-bezier(.22,.61,.36,1)";

  /* ---- tiny utils -------------------------------------------------------- */
  function q(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function whenVisible() {
    return new Promise(function (resolve) {
      (function check() {
        try { if (!document.hidden) return resolve(); } catch (e) { return resolve(); }
        setTimeout(check, 500);
      })();
    });
  }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function fire(target, type, x, y, buttons) {
    try {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: 0, buttons: buttons || 0, detail: 1,
      }));
    } catch (e) { /* never break the app */ }
  }

  /* ---- cursor overlay ----------------------------------------------------- */
  var cursor = null, cursorSvg = null;
  var pos = { x: 0, y: 0 };

  function injectStyleOnce() {
    if (q("#landing-ghost-cursor-style")) return;
    var s = document.createElement("style");
    s.id = "landing-ghost-cursor-style";
    s.textContent =
      "@keyframes lgc-ripple{" +
      "0%{transform:translate(-50%,-50%) scale(.3);opacity:.6}" +
      "100%{transform:translate(-50%,-50%) scale(1.7);opacity:0}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureCursor() {
    if (cursor && cursor.isConnected) return cursor;
    injectStyleOnce();
    cursor = document.createElement("div");
    cursor.id = "landing-ghost-cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;" +
      "z-index:2147483647;pointer-events:none;opacity:0;will-change:transform;" +
      "transition:transform 700ms " + GLIDE_EASE + ",opacity 400ms ease;";
    // macOS-style arrow: near-black fill, white outline, soft drop shadow.
    // Tip of the arrow sits at viewBox (3,2) → offset so translate3d(x,y)
    // puts the TIP exactly on the action point.
    cursor.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" ' +
      'style="display:block;margin-left:-2.5px;margin-top:-1.7px;' +
      'transform-origin:3px 2px;transition:transform 130ms ease;' +
      'filter:drop-shadow(0 1.5px 3px rgba(0,0,0,.5));">' +
      '<path d="M3 2 L3 19.5 L7.6 15.4 L10.2 21.2 L13.4 19.8 L10.8 14.1 L17 14.1 Z" ' +
      'fill="#1b1b1f" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cursorSvg = cursor.firstChild;
    (document.body || document.documentElement).appendChild(cursor);
    return cursor;
  }

  function setTransition(ms) {
    if (!cursor) return;
    cursor.style.transition = (ms > 0 ? "transform " + ms + "ms " + GLIDE_EASE + "," : "") + "opacity 400ms ease";
  }
  function place(x, y) {
    pos.x = x; pos.y = y;
    if (cursor) cursor.style.transform = "translate3d(" + x + "px," + y + "px,0)";
  }
  function moveInstant(x, y) { setTransition(0); place(x, y); }
  function glide(x, y, ms) {
    ms = ms || 750;
    return new Promise(function (resolve) {
      try { setTransition(ms); place(x, y); } catch (e) {}
      setTimeout(resolve, ms + 60);
    });
  }
  function fadeCursor(on) { if (cursor) cursor.style.opacity = on ? "1" : "0"; }

  function ripple(x, y) {
    try {
      var r = document.createElement("div");
      r.style.cssText =
        "position:fixed;left:" + x + "px;top:" + y + "px;width:34px;height:34px;" +
        "border-radius:50%;border:2px solid rgba(255,255,255,.85);" +
        "background:rgba(255,255,255,.18);pointer-events:none;z-index:2147483646;" +
        "animation:lgc-ripple 450ms ease-out forwards;";
      document.body.appendChild(r);
      setTimeout(function () { try { r.remove(); } catch (e) {} }, 520);
    } catch (e) {}
  }
  function press() {
    try {
      if (!cursorSvg) return;
      cursorSvg.style.transform = "scale(.82)";
      setTimeout(function () { try { cursorSvg.style.transform = ""; } catch (e) {} }, 140);
    } catch (e) {}
  }

  /* ---- interaction primitives -------------------------------------------- */
  function pointOf(el, fx, fy) {
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width * (fx == null ? 0.5 : fx), y: r.top + r.height * (fy == null ? 0.5 : fy) };
  }

  /** Glide to the element and click it through the real React handlers. */
  function glideAndClick(el, fx, fy) {
    var p = pointOf(el, fx, fy);
    if (!p) return Promise.resolve(false);
    return glide(p.x, p.y, 800).then(function () {
      press(); ripple(p.x, p.y);
      fire(el, "mousedown", p.x, p.y, 1);
      fire(el, "mouseup", p.x, p.y, 0);
      fire(el, "click", p.x, p.y, 0);
      return sleep(220).then(function () { return true; });
    });
  }

  /** One eased drag segment: cursor visual + window mousemove stay in sync. */
  function dragSegment(x0, y0, x1, y1, ms) {
    return new Promise(function (resolve) {
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      function step(now) {
        try {
          if (now == null) now = Date.now();
          var t = Math.min(1, (now - t0) / ms);
          var e2 = easeInOut(t);
          var x = x0 + (x1 - x0) * e2, y = y0 + (y1 - y0) * e2;
          moveInstant(x, y);
          fire(window, "mousemove", x, y, 1);
          if (t < 1) { requestAnimationFrame(step); } else { resolve({ x: x, y: y }); }
        } catch (e) { resolve({ x: x1, y: y1 }); }
      }
      requestAnimationFrame(step);
    });
  }

  /**
   * Full divider drag: glide onto the divider, mousedown on it, eased
   * mousemoves on window through each waypoint, mouseup on window.
   * `waypoints` = [{dx, dy, ms, holdMs}] relative to the grab point.
   */
  function glideAndDrag(el, waypoints) {
    var p = pointOf(el);
    if (!p) return Promise.resolve(false);
    return glide(p.x, p.y, 700).then(function () {
      press();
      fire(el, "mousedown", p.x, p.y, 1);
      var chain = Promise.resolve({ x: p.x, y: p.y });
      waypoints.forEach(function (w) {
        chain = chain.then(function (cur) {
          var tx = p.x + (w.dx || 0), ty = p.y + (w.dy || 0);
          return dragSegment(cur.x, cur.y, tx, ty, w.ms || 700).then(function (end) {
            return w.holdMs ? sleep(w.holdMs).then(function () { return end; }) : end;
          });
        });
      });
      return chain.then(function (end) {
        fire(window, "mouseup", end.x, end.y, 0);
        return sleep(180).then(function () { return true; });
      });
    });
  }

  /* ---- target lookups (always FRESH — layout may have changed) ------------ */
  // acme-web's Claude Code tabs: pane ids are seeded by landing-boot.js.
  function tabCC(n) { return q('[data-pane-id="terminal:cc' + n + '"]'); }
  // The terminal|preview split divider INSIDE acme-web. Scope through the
  // cc1 tab's group cell so the (divider-less) acme-api/mobile GroupLayouts
  // can never be confused for it; fall back to the only inner column divider.
  function innerDivider() {
    var tab = tabCC(1) || tabCC(2);
    var cell = tab && tab.closest ? tab.closest("[data-group-cell]") : null;
    var row = cell && cell.parentElement;
    var d = row ? q("[data-divider-row][data-divider-col]", row) : null;
    return d || q("[data-divider-row][data-divider-col]");
  }
  // App-level divider between acme-api and acme-mobile (bottom row, col 0).
  function appDivider() {
    return q('[data-panel-divider-row="1"][data-panel-divider-col="0"]') ||
           q("[data-panel-divider-row][data-panel-divider-col]");
  }

  /* ---- choreography -------------------------------------------------------- */
  var round = 0;

  function runRound() {
    var seq = Promise.resolve();
    function step(fn) {
      seq = seq.then(function () {
        return whenVisible().then(function () {
          return Promise.resolve().then(fn).catch(function () { /* skip silently */ });
        });
      });
      return seq;
    }

    // (a) switch to the SECOND Claude Code tab in acme-web
    step(function () {
      var el = tabCC(2);
      if (!el) return;
      return glideAndClick(el, 0.42, 0.5).then(function () { return sleep(450); });
    });

    // (b) drag the terminal|preview split inside acme-web (~100px), settle.
    // Direction alternates per round so the loop doesn't ratchet into the clamp.
    step(function () {
      var el = innerDivider();
      if (!el) return;
      var dir = (round % 2 === 0) ? -1 : 1;
      return glideAndDrag(el, [{ dx: dir * 100, ms: 1100 }]).then(function () { return sleep(400); });
    });

    // (c) focus the acme-api window via its Claude Code tab
    step(function () {
      var el = tabCC(3);
      if (!el) return;
      return glideAndClick(el, 0.42, 0.5).then(function () { return sleep(400); });
    });

    // (d) drag the acme-api | acme-mobile divider out ~120px, then settle
    // back near 50/50 (same grab — the hook tracks delta from mousedown).
    step(function () {
      var el = appDivider();
      if (!el) return;
      return glideAndDrag(el, [
        { dx: 120, ms: 900, holdMs: 350 },
        { dx: 4, ms: 700 },
      ]).then(function () { return sleep(400); });
    });

    // (e) back to the FIRST Claude tab, then park + fade out
    step(function () {
      var el = tabCC(1);
      if (!el) return;
      return glideAndClick(el, 0.42, 0.5);
    });
    step(function () {
      var px = Math.max(40, window.innerWidth - 72);
      var py = Math.max(40, window.innerHeight - 48);
      return glide(px, py, 700).then(function () { return sleep(2000); }).then(function () { fadeCursor(false); });
    });

    return seq;
  }

  function loop() {
    whenVisible()
      .then(function () {
        ensureCursor();
        // each round re-enters from a quiet corner and fades in
        moveInstant(window.innerWidth * 0.46, window.innerHeight * 0.32);
        return sleep(60);
      })
      .then(function () { fadeCursor(true); return sleep(420); })
      .then(runRound)
      .catch(function () { /* round must never throw */ })
      .then(function () {
        round++;
        setTimeout(loop, LOOP_PAUSE_MS);
      });
  }

  /* ---- boot: wait for the app to mount, start at ≈t+6s --------------------- */
  var bootT0 = Date.now();
  (function waitForMount() {
    try {
      if (tabCC(2) && tabCC(1)) {
        ensureCursor(); // exists (hidden) as soon as the UI is up
        var delay = Math.max(0, START_AT_MS - (Date.now() - bootT0));
        setTimeout(loop, delay);
        return;
      }
    } catch (e) { /* keep polling */ }
    if (Date.now() - bootT0 > 20000) return; // give up silently
    setTimeout(waitForMount, 250);
  })();
})();
