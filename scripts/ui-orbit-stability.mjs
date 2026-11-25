#!/usr/bin/env node
/**
 * scripts/ui-orbit-stability.mjs - does an edition (ORBIT, or the Consorzio
 * with `--entry consorzio`) stay the same after a person has gone around it
 * for a while?
 *
 * WHY. Attilio (08/11): «Rivedi tutto in termini di esperienza e stabilità».
 * A preview that leaks shows it late: a listener added on every page and never
 * removed, an interval that keeps ticking after its screen is gone, a header
 * that jumps when the content arrives. None of these fails a click; all of
 * them make the app heavier and twitchier the longer it is open.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `orbit.html` in headless WebKit at 1440x900 with a fresh state, and before
 * any script of the page runs it wraps `addEventListener` /
 * `removeEventListener` and the timers, so it can count what is live at any
 * moment. Then:
 *   1. warms up with one round of the route list, lets the page idle, reads
 *      the counts (the baseline);
 *   2. navigates ROUNDS x routes (50 navigations: the sidebar's sections, the
 *      sub-pages of Conoscenza, the menu pages, a card, back and forward);
 *      on every navigation it reads the place of the chrome (sidebar, tab
 *      bar, header of the pane) at the first frame and again after 400 ms:
 *      anything that moved by more than 1px is a layout jump;
 *   3. idles again (toasts and closing timers expire) and reads the counts.
 * Live listeners, live intervals and pending timeouts must be back at the
 * baseline (a small tolerance for the timeouts of the last screen's own
 * closing animations); no page error is allowed.
 *
 *   node scripts/ui-orbit-stability.mjs [--entry orbit|consorzio] [--rounds 5]
 *
 * Exit 0: the numbers before and after, equal. Exit 1: what grew, by type.
 */
import { webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";

/* The places a person goes through, in order; each round visits them all. 10 routes x 5 rounds = 50 navigations. */
const ORBIT_ROUTES = [
  "/da-fare",
  "/da-fare/kanban",
  "/da-fare/per-stato",
  "/da-fare/card/SG-4128",
  "/flussi",
  "/conoscenza/documenti",
  "/conoscenza/contratti",
  "/conoscenza/contratti/c-castellabate",
  "/conoscenza/dati/scadenzario",
  "/squadra",
];
const ENTRY = arg("entry") ?? "orbit";
/** The screens an entry other than ORBIT is walked through: the first example of each, read from the page. */
const SCREENS = ["orbit-list", "orbit-kanban", "orbit-stages", "orbit-card", "orbit-flows", "orbit-knowledge", "orbit-contracts", "orbit-contract", "orbit-deadlines", "orbit-team"];
const ROUNDS = Number(arg("rounds") ?? "5");
/** Pending timeouts may differ by this much: the last screen's own fades and debounces. */
const TIMEOUT_TOLERANCE = 2;
const IDLE_MS = 7000;

/* Runs in the page before its own scripts: counts what is live. */
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

/* Where the chrome stands: a header that moves between the first frame and 400 ms later is a jump. */
const CHROME = () => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  return {
    sidebar: box("nav[aria-label]"),
    tabs: box("[role=tablist]"),
    header: box("[data-screen] header"),
    first: box("[data-screen] header + *"),
  };
};

const { base, close } = await serveDist("ui-orbit-stability", ENTRY);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
collectErrors(page, errors);
await page.addInitScript(INSTRUMENT);
await page.goto(`${base}?fresh=1&speed=0.05#/da-fare`);
await page.waitForFunction(() => window.__demo);
const ROUTES = ENTRY === "orbit" ? ORBIT_ROUTES : await page.evaluate((screens) => {
  const places = window.__demo.places();
  return screens.map((id) => places.find((x) => x.id === id)?.samples[0]).filter(Boolean);
}, SCREENS);

const settle = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
const go = async (route) => {
  await page.evaluate((r) => { location.hash = r; }, route);
  await page.waitForFunction((r) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${r}`, route, { timeout: 5000 }).catch(() => {});
};

const jumps = [];
const wrongPlaces = [];
async function visit(route, measure) {
  await go(route);
  await settle();
  const at = await page.evaluate(() => location.hash);
  const screen = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
  if (screen === "not-found" || screen === "no-access" || !screen) wrongPlaces.push(`${route}: ${screen ?? "nothing"} (${at})`);
  if (!measure) return;
  const first = await page.evaluate(CHROME);
  await page.waitForTimeout(400);
  const later = await page.evaluate(CHROME);
  for (const k of Object.keys(first)) {
    const a = first[k];
    const b = later[k];
    if (!a || !b) continue;
    const moved = a.some((v, i) => Math.abs(v - b[i]) > 1);
    if (moved) jumps.push(`${route}: ${k} da [${a}] a [${b}]`);
  }
}

/* 1. warm-up and baseline */
for (const r of ROUTES) await visit(r, false);
await go(ROUTES[0]);
await page.waitForTimeout(IDLE_MS);
const before = await page.evaluate(() => window.__stability());

/* 2. 50 navigations, with back and forward on the way */
let navigations = 0;
for (let round = 0; round < ROUNDS; round++) {
  for (const r of ROUTES) {
    await visit(r, true);
    navigations++;
  }
  await page.goBack();
  await settle();
  await page.goForward();
  await settle();
}

/* 3. back where the baseline was read, idle, read again */
await go(ROUTES[0]);
await page.waitForTimeout(IDLE_MS);
const after = await page.evaluate(() => window.__stability());

await browser.close();
close();

const grew = [];
if (after.listeners > before.listeners) {
  const types = Object.keys({ ...before.byType, ...after.byType }).filter((t) => (after.byType[t] ?? 0) > (before.byType[t] ?? 0)).map((t) => `${t} ${before.byType[t] ?? 0}→${after.byType[t]}`);
  grew.push(`listener: ${before.listeners} → ${after.listeners} (${types.join(", ")})`);
}
if (after.windowListeners > before.windowListeners) grew.push(`listener su window/document: ${before.windowListeners} → ${after.windowListeners}`);
if (after.intervals > before.intervals) grew.push(`interval attivi: ${before.intervals} → ${after.intervals}`);
if (after.timeouts > before.timeouts + TIMEOUT_TOLERANCE) grew.push(`timeout in attesa: ${before.timeouts} → ${after.timeouts}`);

console.log(`${navigations} navigazioni (${ROUNDS} giri di ${ROUTES.length} posti, con indietro e avanti)`);
console.log(`prima: ${before.listeners} listener (${before.windowListeners} su window/document), ${before.intervals} interval, ${before.timeouts} timeout`);
console.log(`dopo:  ${after.listeners} listener (${after.windowListeners} su window/document), ${after.intervals} interval, ${after.timeouts} timeout`);
if (jumps.length) console.error(`scatti di layout, ${jumps.length}:\n  ${[...new Set(jumps)].join("\n  ")}`);
if (wrongPlaces.length) console.error(`posti sbagliati:\n  ${[...new Set(wrongPlaces)].join("\n  ")}`);
if (grew.length) console.error(`cresciuto:\n  ${grew.join("\n  ")}`);
if (errors.length) console.error(`errori della pagina, ${errors.length}:\n  ${[...new Set(errors)].join("\n  ")}`);
if (grew.length || jumps.length || errors.length || wrongPlaces.length) {
  console.error("ui-orbit-stability: FAIL");
  process.exit(1);
}
console.log("ui-orbit-stability: ok, niente cresce, niente si sposta, nessun errore");
