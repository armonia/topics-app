#!/usr/bin/env node
/**
 * scripts/ui-app-crawl.mjs - click EVERY control of the organizations preview
 * and fail on any click that does nothing.
 *
 * WHY. A preview that "looks done" hides its dead ends in the controls nobody
 * tried: a filter that does not filter, a button wired to nothing, a chip that
 * looks like a link. Attilio asked for an app where every button does what it
 * says; a person cannot press four thousand controls after every change, this
 * script can.
 *
 * HOW. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `app.html` in headless WebKit at 1440x900 with a fresh state and fast jobs,
 * asks the app for its places (`window.__demo.places()`), and for every sample
 * address of every place:
 *   1. resets the demo to that address (`window.__demo.reset(path)`), so each
 *      click starts from the same state;
 *   2. lists the visible controls of the screen (buttons, links, tabs, rows,
 *      switches, checkboxes, menu items, inputs, selects, focusable elements);
 *      the window chrome (sidebar, tab bar) is crawled once, on the first place;
 *   3. clicks the n-th one (types into an input, picks another option of a
 *      select) and compares before/after: the address, the DOM, the values of
 *      the fields, the stored state, downloads and popups. Nothing changed =
 *      a DEAD click;
 *   4. when a click opens a menu, a dialog or a listbox, clicks every control
 *      inside it too (one level deep), each from a fresh reset.
 * Controls that re-select what is already selected (aria-selected="true",
 * aria-current, a checked radio, a select with one option) are skipped and
 * counted; a control under a popover or dialog the screen keeps open is counted
 * as covered (reachable once it closes); disabled controls are listed (the
 * current person lacks a permission, or a form is incomplete). A field is used
 * the way a person would: text gets a letter, a number the up arrow, a date a
 * date, a select another option, a visually hidden checkbox its label.
 * A sample that lands on another screen, on «no access» or «not found», and
 * any console error, exception or failed request fail the run. So does a
 * control of the browser drawn anywhere on the way (a native select, a date
 * or range input, a visible native checkbox, a `title` tooltip), on the
 * place and inside every menu or dialog a click opened, and, for the SARIM
 * edition, a retired word of its glossary in the text on screen.
 *
 *   node scripts/ui-app-crawl.mjs [--entry sarim|consorzio] [--only n01,x06] [--persona legale] [--max 400] [--shard 1/3]
 *       [--routes /flussi/nocera-pec,/da-fare/card/PEC-2418/flusso] [--max-clicks 300]
 *
 * `--routes` crawls only those addresses (hash paths, comma separated) instead
 * of every place of the app: each one is explored the same way, with what its
 * controls open in place; the window chrome (sidebar, tab bar) is left out.
 * `--max-clicks N` stops the whole run after N clicks (the lap in progress is
 * left as it is and the exit code says only what was seen up to there), so a
 * check of one screen takes minutes and not the hour of the full crawl.
 * Both default to off: with neither the crawl is the one it always was.
 *
 * `--entry sarim` crawls the SARIM edition (`sarim.html`) and `--entry consorzio` the
 * Consorzio edition (`consorzio.html`) instead of `app.html`.
 *
 * Exit 0: every click did something and the page logged no error.
 * Exit 1: the list of dead clicks and errors, by place.
 */
import { webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";

const entry = arg("entry") ?? "app";
const only = arg("only")?.split(",");
const persona = arg("persona");
const maxPerSample = Number(arg("max") ?? "400");
const routes = arg("routes")?.split(",").map((r) => r.trim()).filter(Boolean);
const maxClicks = arg("max-clicks") === undefined ? Infinity : Number(arg("max-clicks"));
if (!Number.isFinite(maxClicks) && arg("max-clicks") !== undefined) {
  console.error("ui-app-crawl: --max-clicks wants a number");
  process.exit(2);
}
/* `--shard 2/3`: only every third place starting from the second, to run three crawlers side by side. */
const [shardIndex, shardCount] = (arg("shard") ?? "1/1").split("/").map(Number);

const CONTROLS = [
  "button", "a[href]", "[role=button]", "[role=tab]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]",
  "[role=option]", "[role=row][tabindex]", "[role=treeitem][tabindex]", "[role=switch]", "[role=checkbox]", "[role=radio]",
  "[role=link]", "input:not([type=hidden])", "select", "textarea",
  /* focusable for another reason than being pressed: a scrollable region, a document, a tab panel */
  "[tabindex='0']:not([role=region]):not([role=document]):not([role=article]):not([role=tabpanel]):not([role=log]):not([role=group])",
].join(",");
const OVERLAYS = "[role=menu],[role=dialog],[role=listbox],[role=alertdialog]";
/* Only the overlays a click opened: those already open before it are marked and left out. */
const NEW_OVERLAYS = OVERLAYS.split(",").map((s) => `${s}:not([data-crawl-old])`).join(",");
const markOverlays = () => page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => e.setAttribute("data-crawl-old", "")), OVERLAYS);

const { base, close } = await serveDist("ui-app-crawl", entry);
const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
/* The crawler never leaves the preview: a source link opens a popup (counted below) whose page must not load from the
   internet. On a machine with a network the real page loads, slowly, and the click times out as if it did nothing. */
await context.route((url) => !url.href.startsWith(base.replace(/[^/]*$/, "")), (route) => route.abort().catch(() => {}));
let downloads = 0;
let popups = 0;
/* `window.open` is counted, not run: WebKit on Windows emits no popup event for a `noopener` window whose page the
   route above aborts, and the click that opened it times out, so a working «Apri la pagina» read as a dead click.
   The count goes into the snapshot, so the call is the click's effect on every browser. */
await context.addInitScript(() => {
  window.open = () => { window.__crawlOpened = (window.__crawlOpened ?? 0) + 1; return null; };
});
/* CRAWL_DEBUG: every full-window click-away layer that appears, with where it lives, so a click it took can be traced. */
if (process.env.CRAWL_DEBUG) await context.addInitScript(() => {
  window.__shields = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      for (const el of [n, ...n.querySelectorAll("div.fixed.inset-0")]) {
        if (!el.classList?.contains("fixed") || !el.classList.contains("inset-0") || !String(el.className).includes("z-[9999]")) continue;
        const chain = [];
        for (let a = el.parentElement; a && chain.length < 6; a = a.parentElement) chain.push(`${a.tagName.toLowerCase()}.${String(a.className).slice(0, 50)}${a.getAttribute("role") ? `[role=${a.getAttribute("role")}]` : ""}${a.getAttribute("aria-label") ? `[${a.getAttribute("aria-label").slice(0, 40)}]` : ""}`);
        window.__shields.push(`${location.hash} ${String(el.className).slice(0, 40)} < ${chain.join(" < ")}`);
      }
    }
  }).observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
/* Registered after the crawler's own page, or that page would count as a popup and be closed. */
context.on("page", (p) => { if (p === page) return; popups++; p.close().catch(() => {}); });
page.on("download", () => { downloads++; });
const errors = [];
collectErrors(page, errors);

const query = new URLSearchParams({ fresh: "1", speed: "0.02", ...(persona ? { persona } : {}) });
await page.goto(`${base}?${query}#/${entry !== "app" ? "da-fare" : "panoramica"}`);
await page.waitForFunction(() => window.__demo);
const allPlaces = await page.evaluate(() => window.__demo.places());
/* `--routes`: one place per address, named after the place the app says draws it (or the address itself). */
const places = (routes
  ? routes.map((r) => ({ id: allPlaces.find((p) => p.samples.includes(r))?.id ?? r, samples: [r] }))
  : allPlaces)
  .filter((p) => !only || only.includes(p.id))
  .filter((_, i) => i % shardCount === shardIndex - 1);

/** In the page: the controls under `scope` (or outside the screen when `chrome`), split by what the crawler does with them. */
const listControls = (scope, chrome) => page.evaluate(({ CONTROLS, scope, chrome }) => {
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const screen = document.querySelector("[data-screen]");
  const seen = new Set();
  const live = [];
  const skipped = [];
  const disabled = [];
  const describe = (el) => {
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const name = (el.getAttribute("aria-label") || el.getAttribute("data-tip") || el.textContent || el.getAttribute("placeholder") || el.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 70);
    return `${role} «${name}»`;
  };
  for (const root of roots) {
    for (const el of root.querySelectorAll(CONTROLS)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (chrome && screen?.contains(el)) continue;
      if (!chrome && scope === null && !screen?.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[inert],[aria-hidden=true]")) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") { disabled.push(describe(el)); continue; }
      if (el.matches("[aria-selected=true],[aria-current]:not([aria-current=false]),[role=radio][aria-checked=true],[role=menuitemradio][aria-checked=true]")) { skipped.push(describe(el)); continue; }
      live.push(describe(el));
    }
  }
  return { live, skipped, disabled };
}, { CONTROLS, scope, chrome });

/** In the page: the n-th live control, as a handle. */
const nthControl = (scope, chrome, n) => page.evaluateHandle(({ CONTROLS, scope, chrome, n }) => {
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const screen = document.querySelector("[data-screen]");
  const seen = new Set();
  let i = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll(CONTROLS)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (chrome && screen?.contains(el)) continue;
      if (!chrome && scope === null && !screen?.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[inert],[aria-hidden=true]")) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.matches("[aria-selected=true],[aria-current]:not([aria-current=false]),[role=radio][aria-checked=true],[role=menuitemradio][aria-checked=true]")) continue;
      if (i++ === n) return el;
    }
  }
  return null;
}, { CONTROLS, scope, chrome, n });

const snapshot = () => page.evaluate(() => {
  const html = document.body.innerHTML;
  let h = 0;
  for (let i = 0; i < html.length; i++) h = (h * 31 + html.charCodeAt(i)) | 0;
  const fields = [...document.querySelectorAll("input,textarea,select")].map((e) => (e.type === "checkbox" || e.type === "radio" ? e.checked : e.value)).join("|");
  /* Each edition keeps its state under its own key: the app says which. */
  const key = window.__demo?.storageKey ?? "topics-org-preview";
  return `${location.hash}§${html.length}:${h}§${fields}§${window.__crawlOpened ?? 0}§${localStorage.getItem(key)?.length ?? 0}:${localStorage.getItem(key)}`;
});
const overlayCount = () => page.evaluate((sel) => document.querySelectorAll(sel).length, OVERLAYS);

/* Controls of the browser instead of the layer's own, and retired words on screen (`scripts/check-ui-native.mjs`, `check-sarim-words.mjs` read the sources; this reads what is drawn). */
/* The retired word is spelled in two pieces so that the sources keep passing `check-sarim-words.mjs` while this still looks for it on screen. */
const RETIRED_ON_SCREEN = entry !== "app" ? new RegExp(["fun", "nel"].join(""), "i") : null;
const natives = new Set();
const nativeScan = (where) => page.evaluate(({ where, retired }) => {
  const found = [];
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.getAttribute("type") ? `[type=${e.getAttribute("type")}]` : ""}`;
  for (const e of document.querySelectorAll("select, datalist, input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], input[type=color], input[type=range]")) found.push(`${where}: ${name(e)}`);
  for (const e of document.querySelectorAll("input[type=checkbox], input[type=radio]")) {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (r.width > 1 && r.height > 1 && cs.opacity !== "0" && cs.clip !== "rect(0px, 0px, 0px, 0px)") found.push(`${where}: visible ${name(e)}`);
  }
  for (const e of document.querySelectorAll("[title]")) if (!(e instanceof SVGElement)) found.push(`${where}: title= on ${name(e)} «${e.getAttribute("title").slice(0, 40)}»`);
  if (retired) {
    const m = document.body.innerText.match(new RegExp(retired, "i"));
    if (m) found.push(`${where}: «${m[0]}» on screen`);
  }
  return found;
}, { where, retired: RETIRED_ON_SCREEN?.source ?? null }).then((list) => list.forEach((x) => natives.add(x)));

/* Waits for the entrance animations too (dialog, popover): under load they outlast two frames, and a control read halfway
   (the panel still moving) was clicked where it no longer was, so its own label seemed to cover the field. */
const settle = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const running = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime));
  Promise.race([Promise.all(running.map((a) => a.finished.catch(() => {}))), new Promise((t) => setTimeout(t, 1500))]).then(() => setTimeout(ok, 30));
}))));

async function resetTo(path) {
  await page.evaluate((p) => window.__demo.reset(p), path);
  await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, path, { timeout: 5000 }).catch(() => {});
  /* Resetting to the address already shown resolves the wait at once: on a loaded machine the dialog and the open list of
     the click before can still be drawn, and the list's click-away layer then takes the next click. Wait until they are gone. */
  await page.waitForFunction((sel) => !document.querySelector(sel), OVERLAYS, { timeout: 3000 }).catch(() => {});
  await settle();
}

/* Time to press a control: with six WebKit crawls at once (ui-crawl-stress) the wait for "stable" passes 2 s with
   nothing on top of the control. A control that is really covered stays dead at 6 s too. */
const PRESS_MS = 6000;

/** Clicks a control the way a person would use it; returns false when it could not be pressed. */
async function press(handle) {
  let el = handle.asElement();
  if (!el) return false;
  /* A person scrolls a control into view before pressing it: a row low in a scrolling list is under the pointer only then. */
  await el.scrollIntoViewIfNeeded({ timeout: PRESS_MS }).catch(() => {});
  const kind = await el.evaluate((e) => (e.tagName === "SELECT" ? "select" : e.matches("input[type=number]") ? "number" : e.matches("input[type=date],input[type=time],input[type=datetime-local],input[type=month]") ? "date" : e.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]),textarea") ? "text" : "click"));
  /* What a person's pointer would hit at the control's centre: the control, its own label, or something on top. */
  const hit = await el.evaluate((e, overlays) => {
    const r = e.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || e === top || e.contains(top)) return "self";
    const label = e.labels?.[0];
    if (label && (label === top || label.contains(top))) return "label";
    if (top.closest(overlays) && !e.closest(overlays)) return "overlay";
    return "other";
  }, OVERLAYS);
  if (hit === "overlay") return "covered";
  if (hit === "label") el = await el.evaluateHandle((e) => e.labels[0]).then((h) => h.asElement());
  try {
    if (kind === "select") {
      const values = await el.evaluate((s) => [...s.options].map((o) => o.value).filter((v) => v !== s.value));
      /* one option only: it shows the only value there is, nothing to choose */
      if (!values.length) return "single";
      await el.selectOption(values[0], { timeout: PRESS_MS });
    } else if (kind === "date") {
      const next = await el.evaluate((e) => ({ date: "2026-11-20", time: "10:15", "datetime-local": "2026-11-20T10:15", month: "2026-12" })[e.type]);
      await el.fill(next, { timeout: PRESS_MS });
    } else if (kind === "number" && hit !== "label") {
      await el.click({ timeout: PRESS_MS });
      await page.keyboard.press("ArrowUp");
    } else if (kind === "text" && hit !== "label") {
      await el.click({ timeout: PRESS_MS });
      await page.keyboard.type("a");
    } else {
      await el.click({ timeout: PRESS_MS });
    }
    return true;
  } catch (e) {
    if (process.env.CRAWL_DEBUG) console.log(`       (${String(e.message).split("\n").slice(0, 10).join(" | ")})`);
    return false;
  }
}

const report = [];
let totalClicks = 0;
let totalDead = 0;
let crawledChrome = false;
const capped = () => totalClicks >= maxClicks;

for (const place of places) {
  if (capped()) break;
  for (const sample of place.samples) {
    if (capped()) break;
    await resetTo(sample);
    const landed = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
    const entry = { id: place.id, sample, landed, clicks: 0, dead: [], skipped: 0, covered: 0, disabled: [], wrong: null };
    if (landed === "not-found" || landed === "no-access" || !landed) entry.wrong = `landed on ${landed ?? "nothing"}`;
    await nativeScan(sample);
    const scopes = [{ scope: null, chrome: false }];
    if (!crawledChrome && shardIndex === 1 && !routes) { scopes.push({ scope: null, chrome: true }); crawledChrome = true; }
    for (const { scope, chrome } of scopes) {
      if (capped()) break;
      /* Listed from a fresh start too: the previous scope's last click may have opened tabs or overlays. */
      await resetTo(sample);
      const first = await listControls(scope, chrome);
      entry.skipped += first.skipped.length;
      entry.disabled.push(...first.disabled);
      const count = Math.min(first.live.length, maxPerSample);
      for (let n = 0; n < count; n++) {
        if (capped()) break;
        await resetTo(sample);
        await markOverlays(); /* before the snapshot: the mark itself is a change of the DOM */
        const before = await snapshot();
        const overlaysBefore = await overlayCount();
        const d0 = downloads;
        const p0 = popups;
        const pressed = await press(await nthControl(scope, chrome, n));
        await settle();
        const label = `${chrome ? "[finestra] " : ""}${first.live[n]}`;
        /* Under a popover or dialog the screen opened on purpose: reachable once it closes, not dead. */
        if (pressed === "covered") { entry.covered++; continue; }
        if (pressed === "single") { entry.skipped++; continue; }
        entry.clicks++;
        totalClicks++;
        /* WebKit on Windows can time out the click that opens a popup although the popup opened: that click did something. */
        if (!pressed && popups === p0) { entry.dead.push(`${label} (non si riesce a premere: coperto o fuori schermo)`); totalDead++; continue; }
        const after = await snapshot();
        if (after === before && downloads === d0 && popups === p0) { entry.dead.push(label); totalDead++; continue; }
        /* A click that opened a menu or a dialog: everything inside it gets clicked too, from a fresh start. */
        if ((await overlayCount()) > overlaysBefore) {
          await nativeScan(`${sample} → ${label}`);
          const inner = await listControls(NEW_OVERLAYS, false);
          for (let k = 0; k < Math.min(inner.live.length, 40); k++) {
            if (capped()) break;
            await resetTo(sample);
            await markOverlays();
            const reopened = await press(await nthControl(scope, chrome, n));
            await settle();
            if (reopened !== true) break;
            const b2 = await snapshot();
            const d2 = downloads;
            const p2 = popups;
            const ok = await press(await nthControl(NEW_OVERLAYS, false, k));
            await settle();
            if (ok === "covered") { entry.covered++; continue; }
            if (ok === "single") { entry.skipped++; continue; }
            entry.clicks++;
            totalClicks++;
            const lab2 = `${label} → ${inner.live[k]}`;
            if (!ok && popups === p2) {
              /* CRAWL_DEBUG: what sits on top of the control that could not be pressed, with its ancestors. */
              if (process.env.CRAWL_DEBUG) {
                const onTop = await (await nthControl(NEW_OVERLAYS, false, k))?.asElement()?.evaluate((e) => {
                  const r = e.getBoundingClientRect();
                  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  const chain = [];
                  for (let n = top; n && chain.length < 8; n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}.${String(n.className).slice(0, 60)}${n.getAttribute("role") ? `[role=${n.getAttribute("role")}]` : ""}${n.getAttribute("aria-label") ? `[${n.getAttribute("aria-label").slice(0, 40)}]` : ""}`);
                  return chain.join(" < ");
                }).catch((err) => String(err).slice(0, 120));
                console.log(`       (sopra: ${onTop})`);
                const shields = await page.evaluate(() => (window.__shields ?? []).slice(-4)).catch(() => []);
                for (const sh of shields) console.log(`       (strato: ${sh})`);
              }
              entry.dead.push(`${lab2} (non si riesce a premere)`); totalDead++; continue;
            }
            if ((await snapshot()) === b2 && downloads === d2 && popups === p2) { entry.dead.push(lab2); totalDead++; }
          }
        }
      }
    }
    const tag = entry.wrong || entry.dead.length ? "FAIL" : "ok  ";
    console.log(`${tag} ${place.id.padEnd(8)} ${sample.padEnd(46)} ${String(entry.clicks).padStart(4)} clic  ${entry.dead.length} morti  ${entry.skipped} già scelti  ${entry.covered} sotto una finestra  ${entry.disabled.length} spenti${entry.wrong ? `  ${entry.wrong}` : ""}`);
    for (const d of entry.dead) console.log(`       morto: ${d}`);
    report.push(entry);
  }
}

await browser.close();
close();

const wrong = report.filter((r) => r.wrong);
const disabled = report.flatMap((r) => r.disabled.map((d) => `${r.sample}: ${d}`));
if (disabled.length) console.log(`\nspenti (permesso mancante o modulo incompleto), ${disabled.length}:\n  ${[...new Set(disabled)].join("\n  ")}`);
if (errors.length) console.error(`\nerrori della pagina, ${errors.length}:\n  ${[...new Set(errors)].join("\n  ")}`);
if (natives.size) console.error(`\ncontrolli del browser o parole ritirate a schermo, ${natives.size}:\n  ${[...natives].join("\n  ")}`);
if (capped()) console.log(`\ntetto di ${maxClicks} clic raggiunto: il resto non è stato provato`);
console.log(`\n${report.length} indirizzi, ${places.length} posti, ${totalClicks} clic, ${totalDead} morti, ${wrong.length} indirizzi sbagliati, ${errors.length} errori, ${natives.size} nativi`);
if (totalDead || wrong.length || errors.length || natives.size) {
  console.error("ui-app-crawl: FAIL");
  process.exit(1);
}
console.log("ui-app-crawl: ok, ogni clic fa qualcosa");
