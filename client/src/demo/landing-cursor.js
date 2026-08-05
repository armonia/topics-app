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
 *   - Every divider = Layout/SplitTree.tsx, `[data-split-divider="row|col"]`:
 *     onMouseDown on the bar, then window mousemove / window mouseup (plain
 *     MouseEvents, NO pointer capture). It commits ONCE on mouseup with the
 *     total delta, so a multi-waypoint drag is free — only the last position
 *     counts. During the drag it lays a full-screen overlay at the top of the
 *     stacking order, which is why the pointer re-appends itself below.
 *
 * Hard rules: never opens menus/modals, never navigates, never touches
 * localStorage. Skips entirely under prefers-reduced-motion; pauses between
 * steps while the document is hidden. Every step re-queries its target and
 * silently skips when missing. Defensive try/catch everywhere — the demo
 * must never break because of the choreography.
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var REDUCED = false;
  try {
    if (window.__landingGhostCursor) return;
    window.__landingGhostCursor = true;
    // Reduced motion does NOT disable the chapters — it removes the MOTION.
    // Bailing out here (as this script used to) left the landing's chapter
    // buttons wired to nothing for exactly the visitors least able to follow a
    // moving pointer. Instead the pointer stays hidden, every glide collapses
    // to an instant jump, and the autoplay tour never starts: a chapter click
    // still switches the real pane, just without the choreography.
    REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return; }

  var START_AT_MS = 1200;     // start almost immediately once the UI has mounted
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
    if (REDUCED) ms = 0;   // jump, don't travel
    return new Promise(function (resolve) {
      try { setTransition(ms); place(x, y); } catch (e) {}
      setTimeout(resolve, ms + 60);
    });
  }
  // Under reduced motion the pointer never becomes visible — the pane still
  // switches, so the chapter works; there is just nothing gliding across it.
  function fadeCursor(on) { if (cursor) cursor.style.opacity = (on && !REDUCED) ? "1" : "0"; }

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
    if (REDUCED) {
      // Deliver the drag as a single jump: the pane really resizes, the
      // visitor just isn't shown 60 frames of it travelling.
      moveInstant(x1, y1);
      fire(window, "mousemove", x1, y1, 1);
      return Promise.resolve({ x: x1, y: y1 });
    }
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
      // SplitTree covers the screen with a fixed overlay at z-index 2147483647
      // for the duration of the drag. The pointer is at the same z-index, so
      // the later element wins and the pointer would vanish exactly while it is
      // doing the most visible thing on the page. Re-appending puts it last.
      try { if (cursor && document.body) document.body.appendChild(cursor); } catch (e) {}
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

  /* Every seam in the app is now ONE component (Layout/SplitTree.tsx), marked
   * `data-split-divider="row|col"`: `row` = a left|right split, so a vertical
   * bar dragged along X; `col` = a top|bottom split, a horizontal bar dragged
   * along Y. What tells the app-level seams from a project's inner ones is not
   * a different attribute but WHERE they sit — inside a `[data-testid=
   * "project-window"]` or outside it.
   *
   * This used to look for `[data-divider-row][data-divider-col]` and
   * `[data-panel-divider-row]`, attributes the old GroupLayout/PanelGrid
   * dividers carried and the shared component does not. Every lookup returned
   * null, and because a missing target is a deliberate no-op here, three
   * scenes had quietly stopped dragging anything at all. A selector that
   * cannot match is a test that cannot fail. */
  function projectWindowOf(paneId) {
    var t = q('[data-pane-id="' + paneId + '"]');
    return t && t.closest ? t.closest('[data-testid="project-window"]') : null;
  }
  function outsideProjectWindows(dir) {
    try {
      var all = document.querySelectorAll('[data-split-divider="' + dir + '"]');
      for (var i = 0; i < all.length; i++) {
        if (!all[i].closest('[data-testid="project-window"]')) return all[i];
      }
    } catch (e) { /* fall through */ }
    return null;
  }
  // The terminals|stage seam INSIDE acme-web. Scoped to that project's window so
  // the app-level column seam below can never stand in for it.
  function innerDivider() {
    var w = projectWindowOf("terminal:cc1") || projectWindowOf("terminal:cc2");
    return (w && q('[data-split-divider="row"]', w)) || null;
  }
  // App-level seam between acme-api and acme-mobile (side by side, bottom row).
  function appDivider() { return outsideProjectWindows("row"); }
  // App-level seam between the acme-web row and the row under it.
  function rowDivider() { return outsideProjectWindows("col"); }

  /* ---- groups: a chapter switches GROUP, it does not stretch a split -------
   * The stage used to be one quarter of a window split four ways, so a chapter
   * about the board showed a board the size of a business card, and the way out
   * was to drag two dividers before every chapter. Both are gone: a chapter
   * clicks the group it belongs to, and the group holds exactly what the
   * chapter is about — one window, whole frame.
   *
   * This is the product's own model, not a demo trick. A gruppo is a set of
   * tabs (`Pane.spaceId` + the `spaces` registry); the chips are the app's own
   * SpaceSwitcher, and the click below is a real click on a real chip. */
  function groupChip(spaceId) { return q('[data-space-id="' + spaceId + '"]'); }
  function activeGroup() {
    var el = q('[data-space-id][aria-selected="true"]');
    return el ? el.getAttribute("data-space-id") : null;
  }
  /** Switch to a group unless it is already the active one. */
  function useGroup(tok, spaceId) {
    return act(tok, function () {
      if (activeGroup() === spaceId) return null;
      var chip = groupChip(spaceId);
      if (!chip) return null;
      return glideAndClick(chip, 0.5, 0.5).then(function () { return sleep(420); });
    });
  }
  var GROUP_DEFAULT = "space:default", GROUP_PROJECTS = "space:projects", GROUP_NUMBERS = "space:numbers";

  /* ---- the stage: chapter tabs seeded by landing-boot.js ------------------- */
  function stageTab(id) { return q('[data-pane-id="' + id + '"]'); }

  /* ---- cancellation ------------------------------------------------------- *
   * One scene at a time. Starting a scene (or the visitor grabbing the mouse)
   * cancels whatever was running: every await goes through `hold`, which
   * rejects as soon as the token is stale, so a half-played scene unwinds
   * instead of fighting the new one for the cursor. */
  var runToken = 0;
  function cancelled(tok) { return tok !== runToken; }
  function hold(tok, ms) {
    return sleep(ms).then(function () {
      if (cancelled(tok)) throw new Error("cancelled");
    });
  }
  /** Run `fn` unless the scene was superseded or the tab is in the background. */
  function act(tok, fn) {
    if (cancelled(tok)) return Promise.reject(new Error("cancelled"));
    return whenVisible().then(function () {
      if (cancelled(tok)) throw new Error("cancelled");
      return Promise.resolve().then(fn).catch(function (e) {
        // A missing target must skip, but a cancellation must propagate.
        if (e && e.message === "cancelled") throw e;
      });
    });
  }

  /* ---- messaging back to the landing page --------------------------------- */
  function emit(name, scene) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "topics-demo", type: name, scene: scene || null }, "*");
      }
    } catch (e) { /* cross-origin or detached — the demo still works alone */ }
  }

  /* ---- scenes ------------------------------------------------------------- *
   * A scene is a short, readable gesture on the REAL app. Each one re-queries
   * its targets, so a scene whose pane is missing degrades to a no-op rather
   * than throwing. Keep them under ~6s: they are illustrations, not films. */

  /** Switch the right-hand stage to a chapter tab and let the eye land on it.
   *  Makes room first: a board, a dashboard or a diff in a quarter of a window
   *  is a thumbnail, and a thumbnail is what the visitor came here to avoid. */
  function showStage(tok, paneId, dwellMs, spaceId) {
    return useGroup(tok, spaceId || GROUP_DEFAULT).then(function () {
      return act(tok, function () {
        var el = stageTab(paneId);
        if (!el) return;
        return glideAndClick(el, 0.5, 0.5);
      });
    }).then(function () {
      return act(tok, function () {
        // Drift into the pane body so the visitor looks at the CONTENT, not the tab.
        var host = stageTab(paneId);
        var cell = host && host.closest ? host.closest("[data-group-cell]") : null;
        var p = cell ? pointOf(cell, 0.5, 0.42) : null;
        if (!p) return;
        return glide(p.x, p.y, 850);
      });
    }).then(function () { return hold(tok, dwellMs == null ? 900 : dwellMs); });
  }

  var SCENES = {
    /* Several whole projects open at once — the app-level split. This is the
     * chapter that puts the three windows back on equal terms after a stage
     * chapter has given acme-web the room. */
    workspace: function (tok) {
      return useGroup(tok, GROUP_PROJECTS).then(function () {
        return act(tok, function () {
          var el = tabCC(4); // focus acme-mobile (bottom-left window)
          if (!el) return;
          return glideAndClick(el, 0.42, 0.5);
        });
      }).then(function () {
        return act(tok, function () {
          var el = appDivider();
          if (!el) return;
          return glideAndDrag(el, [{ dx: 130, ms: 950, holdMs: 400 }, { dx: 4, ms: 750 }]);
        });
      }).then(function () { return hold(tok, 500); });
    },

    /* Two live Claude Code sessions in one project, side by side with the app.
     * Here the room goes the OTHER way: the terminals are the subject, so the
     * split lands at 62% and the preview keeps the rest. */
    terminals: function (tok) {
      return useGroup(tok, GROUP_DEFAULT).then(function () {
        return act(tok, function () {
          var el = tabCC(2);
          if (!el) return;
          return glideAndClick(el, 0.42, 0.5);
        });
      }).then(function () { return hold(tok, 1400); })
        .then(function () {
          return act(tok, function () {
            var el = tabCC(1);
            if (!el) return;
            return glideAndClick(el, 0.42, 0.5);
          });
        }).then(function () { return hold(tok, 700); });
    },

    /* Resize the terminal | preview split — the layout is yours. */
    layout: function (tok) {
      return act(tok, function () {
        var el = innerDivider();
        if (!el) return;
        return glideAndDrag(el, [{ dx: -110, ms: 1000, holdMs: 350 }, { dx: 6, ms: 800 }]);
      }).then(function () { return hold(tok, 500); });
    },

    /* Floating splits: the desktop paint mode, shown by toggling the app's own
     * class on the app's own root with the app's own CSS. Nothing is drawn or
     * faked — the panels really do detach into cards, the dividers really do go
     * transparent, and the gaps really do show what is behind.
     *
     * What is NOT real here, and the hint on the button says so: on macOS those
     * gaps show the desktop through a native vibrancy view (App.tsx wires
     * useFloatingVibrancy, which streams the card rects to `vibrancy_set_regions`).
     * A browser cannot host an NSVisualEffectView, so here they show the
     * demo's own emulated backdrop. The geometry is the product; the material
     * behind it is not, and claiming otherwise would be a lie told in CSS.
     *
     * Why the class survives: on web `isDesktop` is false, so the className
     * React computes for the root is constant between renders and React never
     * rewrites the attribute. That is true today by accident rather than by
     * contract, so the scene re-asserts the class instead of assuming it. */
    floating: function (tok) {
      /* The class lands on the element App.tsx builds at its root — a div whose
       * className is a Tailwind string (`flex bg-app-bg overflow-hidden
       * max-w-[100vw]`), not a stable hook. Match on the two classes that
       * identify it rather than on a brittle escaped selector, and walk up from
       * a pane so this keeps working if the tree gains a wrapper. */
      var root = (function () {
        var el = q("#root");
        if (!el) return null;
        var cands = el.querySelectorAll("div.bg-app-bg.overflow-hidden");
        for (var i = 0; i < cands.length; i++) {
          if (cands[i].className.indexOf("max-w-[100vw]") >= 0) return cands[i];
        }
        return cands[0] || null;
      })();
      if (!root) return Promise.resolve();
      // Three windows make three cards; one window alone makes one, which shows
      // nothing. The GROUP is part of what this chapter shows.
      return useGroup(tok, GROUP_PROJECTS).then(function () { return act(tok, function () {
        // Park the pointer over the seam that is about to open, so the eye is
        // already where the change happens.
        var d = innerDivider();
        var p = d ? pointOf(d) : null;
        return p ? glide(p.x, p.y, 700) : null;
      }).then(function () {
        return act(tok, function () { root.classList.add("floating-splits"); return sleep(120); });
      }).then(function () { return hold(tok, 2600); })
        .then(function () {
          // Back off. Leaving it on would turn a demonstration into a costume.
          return act(tok, function () { root.classList.remove("floating-splits"); });
        }).then(function () { return hold(tok, 500); });
      });
    },

    /* acme-web's own tabs: they live inside a ProjectWindow (git, files and the
     * per-project board have no standalone renderer), and that window is alone
     * in the default group, so the frame is theirs. */
    browser:   function (tok) { return showStage(tok, "browser:c1", 1500); },
    board:     function (tok) { return showStage(tok, "kanban:c1", 1800); },
    git:       function (tok) { return showStage(tok, "git:c1", 1400); },
    files:     function (tok) { return showStage(tok, "files:c1", 1400); },
    /* Queste due rendono STANDALONE, quindi sono un gruppo a sé: due tab, una
     * finestra, tutto il riquadro. */
    fleet:     function (tok) { return showStage(tok, "__board__", 1600, GROUP_NUMBERS); },
    dashboard: function (tok) { return showStage(tok, "__dashboard__", 1800, GROUP_NUMBERS); },
  };

  /* Autoplay order — the product's argument, told in sequence: you keep whole
   * projects open, agents run in them, a board drives the agents, and the
   * numbers tell you what it cost. */
  var TOUR = ["terminals", "browser", "board", "fleet", "dashboard", "workspace"];

  /* ---- player -------------------------------------------------------------- */
  var autoplay = true;
  var tourIndex = 0;
  var idleTimer = 0;

  function playScene(name) {
    var fn = SCENES[name];
    if (!fn) return Promise.resolve();
    var tok = ++runToken;
    emit("scene-start", name);
    return whenVisible()
      .then(function () {
        if (cancelled(tok)) throw new Error("cancelled");
        ensureCursor();
        fadeCursor(true);
        return sleep(220);
      })
      .then(function () { return fn(tok); })
      .then(function () {
        if (cancelled(tok)) return;
        emit("scene-end", name);
      })
      .catch(function () { /* cancelled or a missing target — never throw */ });
  }

  /** Visitor asked for a chapter: stop the tour, play it, then stay put. */
  function playOnDemand(name) {
    autoplay = false;
    clearTimeout(idleTimer);
    playScene(name).then(function () {
      // Park the pointer out of the way so it never covers what it just showed.
      var tok = runToken;
      if (cancelled(tok)) return;
      return glide(Math.max(40, window.innerWidth - 64), Math.max(40, window.innerHeight - 44), 650)
        .then(function () { if (!cancelled(tok)) fadeCursor(false); });
    });
  }

  function tourStep() {
    if (!autoplay) return;
    var name = TOUR[tourIndex % TOUR.length];
    tourIndex++;
    playScene(name).then(function () {
      if (!autoplay) return;
      idleTimer = setTimeout(tourStep, LOOP_PAUSE_MS);
    });
  }

  /* ---- the visitor always wins -------------------------------------------- *
   * The demo is the real app and must stay usable. The moment a REAL pointer or
   * key event arrives (isTrusted — our own synthetic events are not), the ghost
   * stops mid-gesture and gets out of the way. Nothing resumes on its own;
   * only a chapter button brings it back. */
  function yieldToVisitor() {
    if (!autoplay && runToken === 0) return;
    autoplay = false;
    clearTimeout(idleTimer);
    runToken++;            // cancels any scene in flight
    fadeCursor(false);
    emit("visitor-took-over", null);
  }
  ["pointerdown", "wheel", "keydown", "touchstart"].forEach(function (t) {
    try {
      addEventListener(t, function (e) { if (e && e.isTrusted) yieldToVisitor(); },
        { passive: true, capture: true });
    } catch (e) { /* older browsers: the tour simply keeps running */ }
  });

  /* ---- public API: the landing page's chapter buttons ---------------------- */
  window.__topicsDemo = {
    scenes: Object.keys(SCENES),
    play: playOnDemand,
    stop: yieldToVisitor,
  };
  addEventListener("message", function (ev) {
    var d = ev && ev.data;
    if (!d || d.source !== "topics-landing") return;
    if (d.type === "play" && typeof d.scene === "string") playOnDemand(d.scene);
    else if (d.type === "stop") yieldToVisitor();
  });

  /* ---- boot: wait for the app to mount, then start the tour ---------------- */
  var bootT0 = Date.now();
  (function waitForMount() {
    try {
      if (tabCC(2) && tabCC(1)) {
        ensureCursor(); // exists (hidden) as soon as the UI is up
        emit("ready", null);
        // No unsolicited motion for visitors who asked for none. The chapter
        // buttons still drive the app; nothing moves until one is pressed.
        if (REDUCED) { autoplay = false; return; }
        setTimeout(tourStep, Math.max(0, START_AT_MS - (Date.now() - bootT0)));
        return;
      }
    } catch (e) { /* keep polling */ }
    if (Date.now() - bootT0 > 20000) return; // give up silently
    setTimeout(waitForMount, 250);
  })();
})();
