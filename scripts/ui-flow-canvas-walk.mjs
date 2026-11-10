#!/usr/bin/env node
/**
 * scripts/ui-flow-canvas-walk.mjs - the bar of the single flow canvas: seven
 * named checks (c1..c7) that prove the flow is ONE component, drawn the same
 * way wherever it shows, with its cases (lanes) side by side in a strip that
 * scrolls sideways.
 *
 * WHY. Attilio (09/11): «è confusionario così il flusso deve essere una cosa
 * unica eventualmente scrollabile anche in orizzontale se serve per gestire
 * casi diversi paralleli». Three drawings of the same flow (its page, the
 * card that reads it, one run of it) had drifted apart; the fix is one
 * component with three modes (edit / read / run). A walk that stops at the
 * first red hides the others, so every check starts from a clean state,
 * reports ok or ROSSO with its reason, and never stops the rest.
 *
 * WHAT. Serves a build of `client/` (default `dist-ui`) and drives it in
 * headless WebKit. The views come from the real fixtures, with the lanes they
 * already have:
 *   - consorzio.html#/flussi/nocera-pec                        edit (PEC flow, 7 lanes)
 *   - consorzio.html#/da-fare/card/PEC-2418/flusso             read
 *   - app.html#/flussi/pec/esecuzioni/e-0412                   run
 *   - sarim.html#/flussi/sarim-segnalazioni                    edit (5 lanes)
 *   - sarim.html#/da-fare/card/SG-4124/flusso                  read
 *
 *   c1  the same component from every entrance: one canvas per view, the mode
 *       the entrance asks for, a split with at least two lanes
 *   c2  lanes side by side: same top, left strictly increasing, no overlap
 *   c3  the strip scrolls (arrow keys, shift+wheel, drag) when the lanes do not
 *       fit at 1440x900; the «prev» edge button shows; the page never scrolls sideways
 *   c4  read and run: one lane taken (the others off), one current step, the
 *       taken lane brought into the visible part of the strip
 *   c5  the detail of a step opens in the side panel without leaving the page
 *       and closes again
 *   c6  phone 390x844: no sideways scroll of the page, the strip snaps on x,
 *       one lane about as wide as the strip
 *   c7  no listener grows over 30 navigations between the editor and the card
 *
 *   node scripts/ui-flow-canvas-walk.mjs [--dist dist-ui] [--only c1,c3] [--shots <dir>]
 *       [--video <file.webm>] [--expect-red c2]
 *
 * Exit 0: all ok and no console error. Exit 1: one is red (or an error showed
 * up). With `--expect-red c2` the walk runs against the planted-defect build
 * (`ui-flow-canvas-mutant.mjs`): exit 0 ONLY when every listed check is red;
 * the others may be anything (the planted break stacks the lanes and may well
 * hurt more than one control). Exit 2: the build does not boot.
 */
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { devices, webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";
import { POINTER } from "./ui-app/walk-runner.mjs";

const DIST = arg("dist") ?? "dist-ui";
const VIDEO = arg("video") ? resolve(arg("video")) : undefined;
const SHOTS = arg("shots") ? resolve(arg("shots")) : undefined;
const ONLY = arg("only")?.split(",");
const IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
const EXPECT_RED = arg("expect-red") === undefined ? undefined : arg("expect-red") === "all" ? IDS : arg("expect-red").split(",");
const SCRIPT = "ui-flow-canvas-walk";
process.on("exit", (code) => { if (code) console.error(`${SCRIPT}: esce con ${code}`); });
process.on("unhandledRejection", (e) => { console.error(`${SCRIPT}: errore non gestito: ${e?.stack ?? e}`); process.exit(3); });

/* Words of the interface that the bar reads (the copy files are the source: copy.flows.canvas). */
const PREV_LABEL = "Casi a sinistra"; // allow-italian: aria-label of the strip's «prev» edge button (copy.flows.canvas.prev)
const CLOSE_LABEL = "Chiudi il dettaglio del passo"; // allow-italian: aria-label of the detail's close button (copy.flows.canvas.detail.close)

/** The five views of the bar: the entry (html page), the address, the mode the canvas must be in. */
const VIEWS = [
  { id: "consorzio-editor", entry: "consorzio", path: "/flussi/nocera-pec", mode: "edit" },
  { id: "consorzio-card", entry: "consorzio", path: "/da-fare/card/PEC-2418/flusso", mode: "read" },
  { id: "app-esecuzione", entry: "app", path: "/flussi/pec/esecuzioni/e-0412", mode: "run" },
  { id: "sarim-editor", entry: "sarim", path: "/flussi/sarim-segnalazioni", mode: "edit" },
  { id: "sarim-card", entry: "sarim", path: "/da-fare/card/SG-4124/flusso", mode: "read" },
];
const START = { app: "/panoramica", sarim: "/da-fare", consorzio: "/da-fare" };
const viewById = (id) => VIEWS.find((v) => v.id === id);
const TAKEN_VIEWS = VIEWS.filter((v) => v.mode !== "edit");

/* ---------- servers and pages ---------- */

const servers = {};
for (const entry of ["consorzio", "sarim", "app"]) servers[entry] = await serveDist(SCRIPT, entry, DIST);
const closeAll = () => Object.values(servers).forEach((s) => s.close());

const errors = [];
const beat = (page, ms = 80) => page.waitForTimeout(VIDEO ? Math.max(ms, 500) : ms);
const settle = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 30)))));

/**
 * A page that moves between the three entries and opens views: `open(view)`
 * resets the demo at the address of the view and waits for its canvas.
 * Resolves to a problem line (string) when the canvas never shows, else null.
 */
function env(page) {
  const ensure = async (entry) => {
    const { base } = servers[entry];
    if (page.url().split("?")[0] === base && (await page.evaluate(() => Boolean(window.__demo)).catch(() => false))) return;
    await page.goto(`${base}?fresh=1&speed=0.1#${START[entry]}`);
    await page.waitForFunction(() => window.__demo && document.querySelector("[data-screen]"), undefined, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
  };
  const open = async (view) => {
    try {
      await ensure(view.entry);
      await page.evaluate((p) => window.__demo.reset(p), view.path);
      await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, view.path, { timeout: 6000 }).catch(() => {});
      await page.waitForSelector("[data-testid=flow-canvas]", { state: "visible", timeout: 8000 });
    } catch {
      const where = await page.evaluate(() => `${document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? "nessuna schermata"} a ${location.hash}`).catch(() => "pagina non raggiungibile");
      return `${view.id}: il canvas del flusso non compare (${where})`;
    }
    await settle(page);
    await beat(page, 250);
    return null;
  };
  return { page, ensure, open };
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}

/** Waits until a number read from the page stops changing (a smooth scroll that has landed). */
async function steady(page, read, arg0) {
  let last = await page.evaluate(read, arg0);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(80);
    const now = await page.evaluate(read, arg0);
    if (now === last) return now;
    last = now;
  }
  return last;
}

/* ---------- c1..c7 ---------- */

/** c1: the same component, from every entrance. */
async function c1(e) {
  const problems = [];
  const log = [];
  for (const view of VIEWS) {
    const bad = await e.open(view);
    if (bad) { problems.push(bad); continue; }
    const m = await e.page.evaluate(() => {
      const all = document.querySelectorAll("[data-testid=flow-canvas]");
      const c = all[0];
      const splits = c ? [...c.querySelectorAll("[data-flow-split]")] : [];
      return {
        canvases: all.length,
        mode: c?.getAttribute("data-flow-mode") ?? null,
        readonly: Boolean(c?.hasAttribute("data-flow-readonly")),
        steps: c?.querySelectorAll("[data-flow-step]").length ?? 0,
        splits: splits.length,
        lanes: Math.max(0, ...splits.map((s) => s.querySelectorAll("[data-flow-lane]").length)),
      };
    });
    await shot(e.page, `c1-${view.id}`);
    const why = [];
    if (m.canvases !== 1) why.push(`${m.canvases} canvas nella pagina, attesi 1`);
    if (m.mode !== view.mode) why.push(`modo ${m.mode}, atteso ${view.mode}`);
    if (view.mode === "read" && !m.readonly) why.push("in lettura manca data-flow-readonly");
    if (view.mode !== "read" && m.readonly) why.push(`in ${view.mode} c'è data-flow-readonly`);
    if (m.steps < 1) why.push("nessun passo");
    if (m.splits < 1) why.push("nessuna divisione in casi");
    else if (m.lanes < 2) why.push(`la divisione ha ${m.lanes} casi, attesi almeno 2`);
    if (why.length) problems.push(`${view.id}: ${why.join(", ")}`);
    log.push(`${view.id} ${m.mode} ${m.lanes} casi`);
  }
  return { problems, measure: log.join("; ") };
}

/** c2: for each split the lanes stand side by side: same top, left increasing, no overlap. */
async function c2(e) {
  const problems = [];
  const log = [];
  for (const view of VIEWS) {
    const bad = await e.open(view);
    if (bad) { problems.push(bad); continue; }
    const rows = await e.page.evaluate(() => [...document.querySelectorAll("[data-testid=flow-canvas] [data-flow-split]")].map((split) => ({
      id: split.getAttribute("data-flow-split"),
      lanes: [...split.querySelectorAll("[data-flow-lane]")].map((l) => {
        const r = l.getBoundingClientRect();
        const step = l.querySelector("[data-flow-step]");
        return { id: l.getAttribute("data-flow-lane"), top: r.top, left: r.left, right: r.right, width: r.width, firstStep: step ? step.getBoundingClientRect().top : undefined };
      }),
      letters: split.querySelectorAll("[data-flow-lane-index-letter]").length,
    })));
    const nested = await e.page.evaluate(() => document.querySelectorAll("[data-testid=flow-canvas] [role=button] button, [data-testid=flow-canvas] button button").length);
    const why = [];
    for (const split of rows) {
      const lanes = split.lanes;
      for (let i = 1; i < lanes.length; i++) {
        const a = lanes[i - 1];
        const b = lanes[i];
        if (Math.abs(b.top - lanes[0].top) > 2) why.push(`il caso ${b.id} sta a ${Math.round(b.top - lanes[0].top)}px sotto il primo`);
        else if (!(b.left > a.left)) why.push(`il caso ${b.id} non sta a destra di ${a.id}`);
        else if (b.left < a.right - 0.5) why.push(`il caso ${b.id} si sovrappone a ${a.id} di ${Math.round(a.right - b.left)}px`);
      }
      if (lanes.length < 2) why.push(`${split.id}: ${lanes.length} caso`);
      const tops = lanes.map((l) => l.firstStep).filter((t) => t !== undefined);
      if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 2) why.push(`${split.id}: il primo passo dei casi non è allineato (${Math.round(Math.max(...tops) - Math.min(...tops))}px di scarto)`);
      if (split.letters !== lanes.length) why.push(`${split.id}: ${split.letters} lettere di posizione per ${lanes.length} casi`);
    }
    if (nested) why.push(`${nested} pulsanti dentro un pulsante`);
    if (!rows.length) why.push("nessuna divisione");
    if (why.length) problems.push(`${view.id}: ${[...new Set(why)].slice(0, 3).join("; ")}`);
    log.push(`${view.id} ${rows.reduce((n, s) => n + s.lanes.length, 0)} casi in fila`);
  }
  return { problems, measure: log.join("; ") };
}

/** The strip of the first split with a horizontal overflow, as a locator-free handle: marks it and returns its box. */
const markStrip = (page) => page.evaluate(() => {
  document.querySelectorAll("[data-walk-strip]").forEach((s) => s.removeAttribute("data-walk-strip"));
  const strips = [...document.querySelectorAll("[data-testid=flow-canvas] [data-flow-lanes]")];
  const strip = strips.find((s) => s.scrollWidth > s.clientWidth) ?? strips[0];
  if (!strip) return null;
  strip.setAttribute("data-walk-strip", "");
  strip.scrollIntoView({ block: "center" });
  return { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth };
});
const stripLeft = () => document.querySelector("[data-walk-strip]")?.scrollLeft ?? -1;
const STRIP = "[data-walk-strip]";

/** A point inside the strip that the screen shows (the strip is tall: the middle of the part in view). */
const stripPoint = (page) => page.evaluate(() => {
  const strip = document.querySelector("[data-walk-strip]");
  const r = strip.getBoundingClientRect();
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  return { x: r.left + r.width / 2, y: (top + bottom) / 2, left: r.left, right: r.right };
});

/** c3: the strip scrolls with the keys, shift+wheel and a drag; the edge button shows; the page stays put. */
async function c3(e) {
  const { page } = e;
  const view = viewById("consorzio-editor");
  const bad = await e.open(view);
  if (bad) return { problems: [bad] };
  const problems = [];
  const log = [];
  const dims = await markStrip(page);
  if (!dims) return { problems: ["il canvas non ha nessuna striscia dei casi"] };
  if (!(dims.scrollWidth > dims.clientWidth)) return { problems: [`la striscia non scorre di lato: larga ${dims.scrollWidth}px in ${dims.clientWidth}px (7 casi attesi più larghi dello schermo)`] };
  log.push(`striscia ${dims.scrollWidth}px in ${dims.clientWidth}px`);
  await page.evaluate(() => { document.querySelector("[data-walk-strip]").scrollLeft = 0; });
  await steady(page, stripLeft);

  /* arrow keys: focus the strip, ArrowRight moves it */
  const k0 = await page.evaluate(stripLeft);
  const focused = await page.evaluate(() => { const s = document.querySelector("[data-walk-strip]"); s.focus({ preventScroll: true }); return document.activeElement === s; });
  if (!focused) problems.push("la striscia non prende il focus (manca tabindex)");
  await page.keyboard.press("ArrowRight");
  const k1 = await steady(page, stripLeft);
  if (!(k1 > k0)) problems.push(`ArrowRight non sposta la striscia (${Math.round(k0)} → ${Math.round(k1)})`);
  log.push(`frecce ${Math.round(k0)}→${Math.round(k1)}`);

  /* shift + wheel: a real wheel with Shift held; if the engine does not carry the modifier, a dispatched event stands in */
  const p = await stripPoint(page);
  await page.mouse.move(p.x, p.y);
  const w0 = await page.evaluate(stripLeft);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 240);
  await page.keyboard.up("Shift");
  let w1 = await steady(page, stripLeft);
  let how = "rotella";
  if (!(w1 > w0)) {
    await page.evaluate(() => {
      const strip = document.querySelector("[data-walk-strip]");
      strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, shiftKey: true, bubbles: true, cancelable: true }));
    });
    w1 = await steady(page, stripLeft);
    how = "evento dispatch";
  }
  if (!(w1 > w0)) problems.push(`Maiusc + rotella non sposta la striscia (${Math.round(w0)} → ${Math.round(w1)})`);
  log.push(`maiusc+rotella (${how}) ${Math.round(w0)}→${Math.round(w1)}`);

  /* drag on the background of the strip (the gap between two cases) */
  const dims2 = await page.evaluate(() => { const s = document.querySelector("[data-walk-strip]"); return { left: s.scrollLeft, max: s.scrollWidth - s.clientWidth }; });
  const q = await stripPoint(page);
  /* the first gap between two cases that is on show right now, else just right of the first case */
  const lanesRects = await page.evaluate(() => [...document.querySelectorAll("[data-walk-strip] > [data-flow-lane]")].map((l) => { const r = l.getBoundingClientRect(); return [r.left, r.right]; }));
  const gap = lanesRects.slice(0, -1).map(([, right], i) => right + (lanesRects[i + 1][0] - right) / 2).find((x) => x > q.left + 40 && x < q.right - 40);
  const startX = gap ?? (lanesRects[0][1] + 6);
  const dx = dims2.left + 200 < dims2.max ? -200 : 200;
  await page.mouse.move(startX, q.y);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, q.y, { steps: 6 });
  await page.mouse.move(startX + dx, q.y, { steps: 6 });
  await page.mouse.up();
  const d1 = await steady(page, stripLeft);
  if (Math.abs(d1 - dims2.left) < 20) problems.push(`trascinare con il mouse non sposta la striscia (${Math.round(dims2.left)} → ${Math.round(d1)})`);
  log.push(`trascinamento ${Math.round(dims2.left)}→${Math.round(d1)}`);

  /* the edge button that says there are cases to the left */
  await page.evaluate(() => { document.querySelector("[data-walk-strip]").scrollLeft = 300; });
  await steady(page, stripLeft);
  const prev = page.getByRole("button", { name: PREV_LABEL });
  const prevShown = await prev.first().isVisible().catch(() => false);
  if (!prevShown) problems.push(`dopo lo scorrimento il pulsante «${PREV_LABEL}» non si vede`);
  await shot(page, "c3-striscia-scorsa");

  /* the page itself never scrolls sideways */
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
  if (Math.max(wide.doc, wide.body) > wide.inner) problems.push(`la pagina scorre di lato: larga ${Math.max(wide.doc, wide.body)}px su ${wide.inner}px`);
  log.push(`pagina ${wide.doc}px su ${wide.inner}px`);
  return { problems, measure: log.join("; ") };
}

/** c4: read and run: one lane taken, the others off, one current step, the taken lane in view. */
async function c4(e) {
  const problems = [];
  const log = [];
  for (const view of TAKEN_VIEWS) {
    const bad = await e.open(view);
    if (bad) { problems.push(bad); continue; }
    const m = await e.page.evaluate(() => {
      const c = document.querySelector("[data-testid=flow-canvas]");
      const lanes = [...c.querySelectorAll("[data-flow-lane]")];
      const taken = lanes.filter((l) => l.hasAttribute("data-flow-lane-taken"));
      const others = lanes.filter((l) => !l.hasAttribute("data-flow-lane-taken"));
      let overlap = 0;
      let width = 0;
      if (taken[0]) {
        const strip = taken[0].closest("[data-flow-lanes]").getBoundingClientRect();
        const lane = taken[0].getBoundingClientRect();
        overlap = Math.min(strip.right, lane.right) - Math.max(strip.left, lane.left);
        width = lane.width;
      }
      return {
        lanes: lanes.length,
        taken: taken.length,
        takenOff: taken.filter((l) => l.hasAttribute("data-flow-lane-off")).length,
        othersNotOff: others.filter((l) => !l.hasAttribute("data-flow-lane-off")).length,
        current: c.querySelectorAll("[data-flow-step-current]").length,
        overlap,
        width,
      };
    });
    await shot(e.page, `c4-${view.id}`);
    const why = [];
    if (m.taken !== 1) why.push(`${m.taken} casi presi, atteso 1`);
    if (m.takenOff) why.push("il caso preso è segnato come spento");
    if (m.othersNotOff) why.push(`${m.othersNotOff} casi non presi non sono segnati come spenti`);
    if (m.current !== 1) why.push(`${m.current} passi correnti, atteso 1`);
    if (m.taken === 1 && m.overlap < Math.min(m.width, Math.max(m.width * 0.5, 1))) why.push(`il caso preso non è nella parte visibile della striscia (si vedono ${Math.max(0, Math.round(m.overlap))}px su ${Math.round(m.width)}px)`);
    if (why.length) problems.push(`${view.id}: ${why.join(", ")}`);
    log.push(`${view.id} ${m.taken} preso su ${m.lanes}, ${m.current} corrente`);
  }
  return { problems, measure: log.join("; ") };
}

/** c5: the detail of a step opens in the side panel, in place, and closes again. */
async function c5(e) {
  const { page } = e;
  const problems = [];
  const log = [];
  for (const view of TAKEN_VIEWS) {
    const bad = await e.open(view);
    if (bad) { problems.push(bad); continue; }
    /* a step that is not the current one, in the column of the flow if there is one (a lane may sit under an edge button) */
    const pick = await page.evaluate(() => {
      const c = document.querySelector("[data-testid=flow-canvas]");
      const steps = [...c.querySelectorAll("[data-flow-step]:not([data-flow-step-current])")];
      const inColumn = steps.filter((s) => !s.closest("[data-flow-lanes]"));
      const done = inColumn.find((s) => s.hasAttribute("data-flow-step-done"));
      return (done ?? inColumn[0] ?? steps[0])?.getAttribute("data-flow-step") ?? null;
    });
    if (!pick) { problems.push(`${view.id}: nessun passo che non sia il corrente`); continue; }
    const before = await page.evaluate(() => ({ hash: location.hash, details: document.querySelectorAll("[data-flow-step-detail]").length }));
    const card = page.locator(`[data-testid=flow-canvas] [data-flow-step="${pick}"] p > button[aria-pressed]`).first();
    await card.scrollIntoViewIfNeeded();
    if (VIDEO) {
      const box = await card.boundingBox();
      if (box) await page.mouse.move(box.x + 8, box.y + 8, { steps: 12 });
    }
    await card.click({ position: { x: 6, y: 6 } });
    const shown = await page.waitForSelector(`[data-flow-step-detail="${pick}"]`, { state: "visible", timeout: 4000 }).then(() => true, () => false);
    const why = [];
    if (!shown) {
      why.push(`premere il passo ${pick} non apre il suo dettaglio`);
    } else {
      await beat(page, 250);
      const m = await page.evaluate((id) => {
        const d = document.querySelector(`[data-flow-step-detail="${id}"]`);
        const canvas = document.querySelector("[data-testid=flow-canvas]");
        const r = d.getBoundingClientRect();
        return { hash: location.hash, inCanvas: canvas.contains(d), width: r.width, height: r.height, inView: r.right > 0 && r.left < window.innerWidth };
      }, pick);
      if (m.hash !== before.hash) why.push(`l'indirizzo cambia da ${before.hash} a ${m.hash}`);
      if (m.inCanvas) why.push("il dettaglio sta dentro il canvas, non nel pannello laterale");
      if (m.width < 40 || m.height < 40 || !m.inView) why.push("il dettaglio non si vede");
      await shot(page, `c5-${view.id}-dettaglio`);
      const close = page.locator(`[data-flow-step-detail="${pick}"]`).getByRole("button", { name: CLOSE_LABEL });
      if (!(await close.count())) {
        why.push(`nel dettaglio manca il pulsante «${CLOSE_LABEL}»`);
      } else {
        await close.first().click();
        await settle(page);
        const gone = await page.evaluate((id) => ({ same: document.querySelectorAll(`[data-flow-step-detail="${id}"]`).length, all: document.querySelectorAll("[data-flow-step-detail]").length, hash: location.hash }), pick);
        if (gone.same) why.push("Chiudi non toglie il dettaglio del passo");
        else if (gone.all !== before.details) why.push(`dopo Chiudi i dettagli aperti sono ${gone.all}, prima ${before.details}`);
        if (gone.hash !== before.hash) why.push(`dopo Chiudi l'indirizzo è ${gone.hash}`);
      }
    }
    if (why.length) problems.push(`${view.id}: ${why.join("; ")}`);
    log.push(`${view.id} passo ${pick}`);
  }
  return { problems, measure: log.join("; ") };
}

/** c6: on a phone no page scroll, the strip snaps on x, one lane about one strip wide. */
async function c6(_e, phoneEnv) {
  const problems = [];
  const log = [];
  for (const view of VIEWS) {
    const bad = await phoneEnv.open(view);
    if (bad) { problems.push(`telefono: ${bad}`); continue; }
    const m = await phoneEnv.page.evaluate(() => {
      const doc = document.documentElement;
      const strip = [...document.querySelectorAll("[data-testid=flow-canvas] [data-flow-lanes]")][0];
      const lane = strip?.querySelector("[data-flow-lane]");
      return {
        docWide: doc.scrollWidth - doc.clientWidth,
        bodyWide: document.body.scrollWidth - document.body.clientWidth,
        hasStrip: Boolean(strip),
        snap: strip ? getComputedStyle(strip).scrollSnapType : "",
        scrolls: strip ? strip.scrollWidth > strip.clientWidth : false,
        stripWidth: strip?.clientWidth ?? 0,
        laneWidth: lane?.getBoundingClientRect().width ?? 0,
        stripHeight: strip?.getBoundingClientRect().height ?? 0,
        firstLaneHeight: lane?.getBoundingClientRect().height ?? 0,
        tallestLane: Math.max(0, ...[...(strip?.querySelectorAll("[data-flow-lane]") ?? [])].map((l) => l.getBoundingClientRect().height)),
      };
    });
    const why = [];
    if (m.docWide > 1) why.push(`la pagina scorre di lato di ${m.docWide}px`);
    if (m.bodyWide > 1) why.push(`il body scorre di lato di ${m.bodyWide}px`);
    if (!m.hasStrip) why.push("nessuna striscia dei casi");
    else {
      if (!/\bx\b|\bboth\b/.test(m.snap)) why.push(`la striscia non aggancia sull'asse x (scroll-snap-type: ${m.snap || "none"})`);
      if (!m.scrolls) why.push("la striscia non scorre di lato");
      if (m.laneWidth < m.stripWidth * 0.7 || m.laneWidth > m.stripWidth + 1) why.push(`un caso è largo ${Math.round(m.laneWidth)}px su una striscia di ${m.stripWidth}px, atteso circa uno per schermo`);
    }
    if (m.stripHeight > m.firstLaneHeight + 8) why.push(`la striscia è alta ${Math.round(m.stripHeight)}px, il caso in vista ${Math.round(m.firstLaneHeight)}px (il più lungo ${Math.round(m.tallestLane)}px)`);
    if (why.length) problems.push(`${view.id}: ${why.join("; ")}`);
    log.push(`${view.id} caso ${Math.round(m.laneWidth)}/${m.stripWidth}px, alto ${Math.round(m.stripHeight)}px`);
  }
  return { problems, measure: log.join("; ") };
}

/* Runs in the page before its own scripts: counts what is live (the same counter as ui-sarim-stability.mjs). */
const INSTRUMENT = () => {
  const keyOf = (target, type, fn, opts) => {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    return { target, type, fn, capture };
  };
  const list = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn) {
      const k = keyOf(this, type, fn, opts);
      if (!list.some((x) => x.target === k.target && x.type === k.type && x.fn === k.fn && x.capture === k.capture)) list.push(k);
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const k = keyOf(this, type, fn, opts);
    const i = list.findIndex((x) => x.target === k.target && x.type === k.type && x.fn === k.fn && x.capture === k.capture);
    if (i >= 0) list.splice(i, 1);
    return remove.call(this, type, fn, opts);
  };
  const timeouts = new Set();
  const intervals = new Set();
  const st = window.setTimeout;
  const ct = window.clearTimeout;
  const si = window.setInterval;
  const ci = window.clearInterval;
  window.setTimeout = function (fn, ms, ...rest) {
    const id = st.call(window, (...a) => { timeouts.delete(id); if (typeof fn === "function") fn(...a); }, ms, ...rest);
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); return ct.call(window, id); };
  window.setInterval = function (fn, ms, ...rest) { const id = si.call(window, fn, ms, ...rest); intervals.add(id); return id; };
  window.clearInterval = function (id) { intervals.delete(id); return ci.call(window, id); };
  /* Listeners on nodes that left the document die with them: only the connected ones count. */
  window.__stability = () => {
    const connected = list.filter((x) => !(x.target instanceof Node) || x.target.isConnected || x.target === document || x.target === window);
    const onWindow = connected.filter((x) => x.target === window || x.target === document).length;
    const byType = {};
    for (const x of connected) byType[x.type] = (byType[x.type] ?? 0) + 1;
    return { listeners: connected.length, windowListeners: onWindow, timeouts: timeouts.size, intervals: intervals.size, byType };
  };
};

/** c7: 30 navigations between the editor and the card flow (and back): nothing live grows. */
async function c7(_e, browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    collectErrors(page, errors);
    await page.addInitScript(INSTRUMENT);
    const editor = viewById("consorzio-editor");
    const card = viewById("consorzio-card");
    await page.goto(`${servers.consorzio.base}?fresh=1&speed=0.05#${START.consorzio}`);
    await page.waitForFunction(() => window.__demo && document.querySelector("[data-screen]"), undefined, { timeout: 15000 });
    const go = async (view) => {
      await page.evaluate((p) => { location.hash = p; }, view.path);
      await page.waitForSelector(`[data-testid=flow-canvas][data-flow-mode="${view.mode}"]`, { timeout: 6000 });
      await settle(page);
    };
    /* warm-up: one round, idle, baseline (taken on the editor, where the run ends) */
    await go(editor);
    await go(card);
    await go(editor);
    await page.waitForTimeout(4000);
    const before = await page.evaluate(() => window.__stability());
    let navigations = 0;
    for (let i = 0; i < 15; i++) {
      await go(card);
      await go(editor);
      navigations += 2;
    }
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => window.__stability());
    const problems = [];
    if (after.listeners > before.listeners) {
      const types = Object.keys({ ...before.byType, ...after.byType }).filter((t) => (after.byType[t] ?? 0) > (before.byType[t] ?? 0)).map((t) => `${t} ${before.byType[t] ?? 0}→${after.byType[t]}`);
      problems.push(`listener: ${before.listeners} → ${after.listeners} (${types.join(", ")})`);
    }
    if (after.windowListeners > before.windowListeners) problems.push(`listener su window/document: ${before.windowListeners} → ${after.windowListeners}`);
    if (after.intervals > before.intervals) problems.push(`interval attivi: ${before.intervals} → ${after.intervals}`);
    if (after.timeouts > before.timeouts + 2) problems.push(`timeout in attesa: ${before.timeouts} → ${after.timeouts}`);
    return { problems, measure: `${navigations} navigazioni: listener ${before.listeners}→${after.listeners}, interval ${before.intervals}→${after.intervals}, timeout ${before.timeouts}→${after.timeouts}` };
  } finally {
    await context.close();
  }
}

const CHECKS = [
  ["c1", "stesso componente", c1, "desktop"],
  ["c2", "casi affiancati", c2, "desktop"],
  ["c3", "scorrimento orizzontale", c3, "desktop"],
  ["c4", "caso preso e passo corrente", c4, "desktop"],
  ["c5", "dettaglio sul posto", c5, "desktop"],
  ["c6", "telefono", c6, "phone"],
  ["c7", "niente cresce", c7, "browser"],
];

/* ---------- the run ---------- */

const videoDir = VIDEO ? join(tmpdir(), `ui-flow-canvas-walk-${process.pid}`) : undefined;
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const results = [];
let booted = false;

const browser = await webkit.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: VIDEO ? 1 : 2,
    ...(VIDEO ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  if (VIDEO) await page.addInitScript(POINTER);
  collectErrors(page, errors);
  const desktop = env(page);
  booted = await desktop.ensure("consorzio").then(() => true, () => false);

  let phoneContext;
  let phoneEnv;
  if (booted) {
    for (const [id, name, run, kind] of CHECKS) {
      if (ONLY && !ONLY.includes(id)) continue;
      let outcome;
      try {
        if (kind === "phone") {
          phoneContext ??= await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
          if (!phoneEnv) {
            const phonePage = await phoneContext.newPage();
            phonePage.setDefaultTimeout(8000);
            collectErrors(phonePage, errors);
            phoneEnv = env(phonePage);
          }
          outcome = await run(desktop, phoneEnv);
        } else {
          outcome = await run(desktop, kind === "browser" ? browser : undefined);
        }
      } catch (e) {
        outcome = { problems: [`il controllo si è fermato: ${String(e.message).split("\n")[0]}`] };
      }
      const red = outcome.problems.length > 0;
      results.push({ id, name, red, reason: outcome.problems.join("; "), measure: outcome.measure ?? "" });
      console.log(`${red ? "ROSSO" : "ok   "} ${id}  ${name.padEnd(28)} ${red ? outcome.problems.join("; ") : outcome.measure}`);
    }
    if (VIDEO) await page.waitForTimeout(800);
  }
  await phoneContext?.close();
  const recorded = VIDEO ? await page.video()?.path() : undefined;
  await context.close();
  if (recorded) {
    await mkdir(dirname(VIDEO), { recursive: true });
    /* The temp folder may sit on another disk (Windows: C: and E:), where a rename cannot go. */
    await rename(recorded, VIDEO).catch(() => copyFile(recorded, VIDEO));
    await rm(videoDir, { recursive: true, force: true });
    console.log(`video -> ${VIDEO}`);
  }
} finally {
  await browser.close();
  closeAll();
}

if (!booted) {
  console.error(`${SCRIPT}: la pagina non parte (nessun __demo o nessuna schermata): ${[...new Set(errors)].join(" | ") || "nessun errore in console"}`);
  process.exit(2);
}

const unique = [...new Set(errors)];
if (unique.length) console.error(`errori della pagina:\n  ${unique.join("\n  ")}`);

if (EXPECT_RED) {
  /* The planted-defect build: every control listed must be red; the others may be anything. */
  const stayedGreen = EXPECT_RED.filter((id) => !results.find((r) => r.id === id)?.red);
  console.log(`${SCRIPT}: ${results.filter((r) => r.red).length} rossi su ${results.length} (${results.filter((r) => r.red).map((r) => r.id).join(", ") || "nessuno"})`);
  if (stayedGreen.length) {
    console.error(`${SCRIPT}: rimasti VERDI sul mutante (la rottura non li tocca): ${stayedGreen.join(", ")}`);
    process.exit(1);
  }
  console.log(`${SCRIPT}: ok, rossi come attesi (${EXPECT_RED.join(", ")})`);
} else {
  const red = results.filter((r) => r.red);
  console.log(`${SCRIPT}: ${results.length - red.length} ok su ${results.length}, ${unique.length} errori in console`);
  if (red.length || unique.length) {
    console.error(`${SCRIPT}: FAIL${red.length ? `, rossi: ${red.map((r) => r.id).join(", ")}` : ""}${unique.length ? ", errori in console" : ""}`);
    process.exit(1);
  }
}
