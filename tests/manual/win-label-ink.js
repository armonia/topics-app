// WHERE THE LABEL'S INK LANDS INSIDE ITS ROW, measured with the system font of
// the machine the engine is running on.
//
// `items-center` centres the LINE BOX; inside it the engine lays the text on the
// BASELINE, which sits at `ascent` from the top of the font box. Ascent and
// descent are the font's numbers, and they are not symmetric, so the rectangle
// the eye calls "the text" — cap height down to the baseline — ends up off the
// row's axis by an amount that is a property of the FONT, not of our CSS. On
// macOS the stack resolves to SF, on Windows to Segoe UI, and the two do not
// agree: that is why "the tab label is not vertically aligned" is a report that
// only ever arrives from Windows.
//
// This measures that offset for every label in the page, and prints the font
// that produced it. Positive = the ink sits BELOW the row's centre.
//
//   bun run tests/manual/run-ui12-windows.ts tests/manual/win-label-ink.js
//
// Run the same file against a Mac Chrome to get the other side of the
// comparison: the number is only meaningful next to its twin.
//
// WHAT IT SETTLED, 30/08. Windows +0,50 · macOS +0,42, and the obvious cure
// (`text-box-edge: cap alphabetic` on the label, `padding-block: 0.35em` so
// `truncate`'s `overflow: hidden` does not eat the tails) takes both to 0,00
// with the descenders intact - and puts the BASELINE on a half pixel, which
// `tab-label-baseline.spec.ts` catches on LABEL-1 and LABEL-2. The two cannot
// hold together: the cap box's centre sits `cap/2` from the baseline, and with
// a cap of 9,00 / 9,16 that point is half a pixel away whenever the baseline is
// whole. The grid wins; the reasoning lives next to `TAB_LABEL_TYPE`
// (client/src/lib/selectionStyles.ts). Keep this file: it is what turns the
// question from an adjective into two numbers.
(async () => {
  await new Promise((r) => setTimeout(r, 3500));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  /** Cap height and baseline geometry for a computed style, from the engine. */
  const metrics = (cs) => {
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    const m = ctx.measureText("Hxp");
    return {
      ascent: m.fontBoundingBoxAscent,
      descent: m.fontBoundingBoxDescent,
      cap: ctx.measureText("H").actualBoundingBoxAscent,
      font: ctx.font,
    };
  };

  const letto = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-testid="pane-tab-label"],[data-row-name],[data-testid="topic-name"],[data-testid="project-card-label"]')) {
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 4) continue;
    const row = el.closest('[data-testid="pane-tab"],[role="tab"],[data-testid="topic-row"],li,button,a') ?? el.parentElement;
    if (!row) continue;
    const rr = row.getBoundingClientRect();
    if (rr.height < 8) continue;
    const cs = getComputedStyle(el);
    const fm = metrics(cs);
    const L = parseFloat(cs.lineHeight);
    const trimmed = cs.textBoxTrim && cs.textBoxTrim !== "none";
    // Half-leading is floored by Blink; with the trim the box IS the cap box.
    const halfLeading = trimmed ? 0 : Math.floor((L - fm.ascent - fm.descent) / 2);
    const capTop = trimmed ? 0 : halfLeading + fm.ascent - fm.cap;
    const capBottom = trimmed ? r.height : halfLeading + fm.ascent;
    const inkCentreInRow = (r.top - rr.top) + (capTop + capBottom) / 2;
    const key = `${el.getAttribute("data-testid") ?? el.getAttribute("data-row-name")}|${Math.round(rr.height)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    letto.push({
      cosa: el.getAttribute("data-testid") ?? `row:${el.getAttribute("data-row-name")}`,
      riga: Math.round(rr.height * 100) / 100,
      scarto: Math.round((inkCentreInRow - rr.height / 2) * 100) / 100,
      font: fm.font,
      cap: Math.round(fm.cap * 100) / 100,
      ascent: Math.round(fm.ascent * 100) / 100,
      descent: Math.round(fm.descent * 100) / 100,
      trim: trimmed ? cs.textBoxEdge : "no",
    });
  }

  // A synthetic control with the tab's exact classes, so the reading exists even
  // on a bundle that has no panes to show: without a server there are no tabs,
  // and "no labels found" would read the same as "all centred".
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;display:flex;align-items:center;height:28px;width:200px";
  const span = document.createElement("span");
  span.className = "text-[13px] font-medium leading-5 truncate flex-1 min-w-0";
  span.setAttribute("data-testid", "sonda-etichetta");
  span.textContent = "Hxp Esempio";
  probe.appendChild(span);
  document.body.appendChild(probe);
  {
    const cs = getComputedStyle(span);
    const fm = metrics(cs);
    const L = parseFloat(cs.lineHeight);
    const trimmed = cs.textBoxTrim && cs.textBoxTrim !== "none";
    const r = span.getBoundingClientRect();
    const halfLeading = trimmed ? 0 : Math.floor((L - fm.ascent - fm.descent) / 2);
    const capTop = trimmed ? 0 : halfLeading + fm.ascent - fm.cap;
    const capBottom = trimmed ? r.height : halfLeading + fm.ascent;
    letto.push({
      cosa: "sonda (classi della tab, riga 28)",
      riga: 28,
      scarto: Math.round(((28 - r.height) / 2 + (capTop + capBottom) / 2 - 14) * 100) / 100,
      font: fm.font,
      cap: Math.round(fm.cap * 100) / 100,
      ascent: Math.round(fm.ascent * 100) / 100,
      descent: Math.round(fm.descent * 100) / 100,
      trim: trimmed ? cs.textBoxEdge : "no",
      altezzaScatola: Math.round(r.height * 100) / 100,
    });
  }
  // AND THE TAILS SURVIVE. The trim puts the box bottom on the baseline, so the
  // padding is the only thing between g/j/p/q/y and the `overflow: hidden` that
  // `truncate` brings. Measured rather than assumed: the deepest descender of
  // the string against the padding actually applied.
  {
    const t = document.createElement("span");
    t.className = span.className;
    t.style.cssText = "position:fixed;left:-9999px;top:0";
    t.textContent = "gjpqy Ag";
    document.body.appendChild(t);
    const cs = getComputedStyle(t);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    const m = ctx.measureText("gjpqy Ag");
    letto.push({
      cosa: "code delle lettere",
      discendente: Math.round(m.actualBoundingBoxDescent * 100) / 100,
      paddingSotto: Math.round(parseFloat(cs.paddingBottom) * 100) / 100,
      tagliate: m.actualBoundingBoxDescent > parseFloat(cs.paddingBottom) + 0.01,
    });
    t.remove();
  }
  probe.remove();

  return JSON.stringify({
    supportaTrim: CSS.supports("text-box-edge", "cap alphabetic"),
    ua: navigator.userAgent.slice(0, 90),
    letto,
  }, null, 2);
})()
