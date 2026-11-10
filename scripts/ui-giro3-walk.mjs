#!/usr/bin/env node
/**
 * scripts/ui-giro3-walk.mjs - the bar of round 3: nine named checks (p1..p9),
 * one per point of Attilio's brief of 09/11, run on the two demos
 * (`orbit.html` and `consorzio.html`) with the same code.
 *
 * WHY. Round 3 asked for nine things (the flow of a card read in place, a
 * kanban with readable columns, a card page with a hierarchy, two demos, the
 * AI chat, no pinned programs, one global search, no meaningless entries,
 * tabs that do not multiply). A walk that stops at the first red hides the
 * other eight, and a walk written with the ids of one organization proves
 * nothing for the other. So every check starts from a clean state, reports
 * ok or ROSSO with its reason, never stops the others, and reads the ids of
 * cards, flows and programs from the page itself (the kanban, the list, the
 * Programmi page), never from a table written by hand.
 *
 * WHAT. Serves a build of `client/` (default `dist-ui`) and opens the entry
 * in headless WebKit at 1440x900. Each check resets the demo
 * (`window.__demo.reset`) and drives the page with real presses and keys.
 *
 *   node scripts/ui-giro3-walk.mjs --entry orbit|consorzio [--dist dist-ui-mutant]
 *       [--expect-red all|p1,p5] [--only p1,p3] [--video <file.webm>] [--shots <dir>]
 *
 * Exit 0: all nine ok and no console error. Exit 1: one is red (or an error
 * showed up). With `--expect-red all` the walk runs against the planted-defect
 * build (`ui-giro3-mutant.mjs`): exit 0 ONLY when all nine are red, and it says
 * which stayed green otherwise; `--expect-red p5,p7` expects exactly those red
 * and the others green (one defect at a time). Exit 2: the build does not boot.
 *
 * Reading choices worth knowing: "[role=tab]" is counted among the tab strip's
 * own tabs (`[data-tab-key]`), since the view switch of Da fare also uses
 * tabs; "the card's flow name appears once" is measured in the header, the
 * original and the history of the card (the sections above the chat), by
 * leaf elements whose whole text is the name, outside the flow panel, the
 * queue of the flow's cards and the crumbs.
 */
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./ui-app/serve.mjs";
import { POINTER } from "./ui-app/walk-runner.mjs";

const ENTRY = arg("entry") ?? "orbit";
const DIST = arg("dist") ?? "dist-ui";
const VIDEO = arg("video") ? resolve(arg("video")) : undefined;
const SHOTS = arg("shots") ? resolve(arg("shots")) : undefined;
const ONLY = arg("only")?.split(",");
const IDS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
const EXPECT_RED = arg("expect-red") === undefined ? undefined : arg("expect-red") === "all" ? IDS : arg("expect-red").split(",");
const SCRIPT = `ui-giro3-walk(${ENTRY})`;
process.on("exit", (code) => { if (code) console.error(`${SCRIPT}: esce con ${code}`); });
process.on("unhandledRejection", (e) => { console.error(`${SCRIPT}: errore non gestito: ${e?.stack ?? e}`); process.exit(3); });

/** What each entry must show in its sidebar, and what it must never show: one organization, the right one. */
const ORG = {
  orbit: { has: /ORBIT/, not: /Consorzio/i },
  consorzio: { has: /Consorzio/i, not: /ORBIT/ },
}[ENTRY];
if (!ORG) {
  console.error(`${SCRIPT}: --entry must be orbit or consorzio`);
  process.exit(2);
}

/* ---------- small helpers ---------- */

const beat = (page, ms = 60) => page.waitForTimeout(VIDEO ? Math.max(ms, 500) : ms);

/** Presses a control the way a person does: the pointer travels there first when recording. */
async function press(page, locator, opts) {
  await locator.waitFor({ state: "visible" });
  if (VIDEO) {
    const box = await locator.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
    await page.waitForTimeout(250);
  }
  await locator.click(opts);
}

const typeSlow = (page, text) => page.keyboard.type(text, { delay: VIDEO ? 90 : 0 });
const hashOf = (page) => page.evaluate(() => location.hash);
const screenOf = (page) => page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? null);

/** A clean state at `to`: the demo's own reset (state, tabs, overlays, person), then wait for the place. */
async function fresh(page, to = "/da-fare") {
  await page.evaluate((p) => window.__demo.reset(p), to);
  await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, to);
  await beat(page);
}

/** Goes to an address the way a typed one does, and waits until the place drawn is that one. */
async function goHash(page, path) {
  await page.evaluate((h) => { location.hash = h; }, path);
  await page.waitForFunction((p) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${p}`, path);
  await beat(page);
}

/** A row of the sidebar tree by its label. */
const row = (page, label) => page.locator("[role=tree] [role=treeitem]", { hasText: new RegExp(`^${label}`) }).first();
/** An entry of a section strip (`SubNav`). */
const subNav = (page, strip, label) => page.locator(`nav[aria-label="${strip}"]`).locator("button, a").filter({ hasText: new RegExp(`^${label}`) }).first();
const tabsOf = (page) => page.locator("[role=tablist] [role=tab][data-tab-key]");

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}

/** The ids of every card drawn on the kanban, in order. */
async function cardIds(page) {
  await goHash(page, "/da-fare/kanban");
  await page.waitForSelector("[data-kanban-card]");
  return page.locator("[data-kanban-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kanban-card")));
}

/** The cards the kanban marks as stopped («Ferma da…»): blocked on something, or too long in the same column. */
async function stuckIds(page) {
  await goHash(page, "/da-fare/kanban");
  await page.waitForSelector("[data-kanban-card]");
  return page.locator("[data-kanban-card]").evaluateAll((els) => els.filter((e) => /\bFerma da\b/.test(e.innerText)).map((e) => e.getAttribute("data-kanban-card")));
}

/** The names of the programs of the world, read from the rows of the Programmi page. */
async function programNames(page) {
  await goHash(page, "/programmi");
  await page.waitForSelector("[data-screen=orbit-programs] [role=row] [role=cell]");
  return page.locator("[data-screen=orbit-programs] [role=row]").evaluateAll((rows) => rows
    .filter((r) => r.querySelector("[role=cell]"))
    .map((r) => r.querySelector("[role=cell] .font-semibold")?.textContent?.trim() ?? "")
    .filter(Boolean));
}

/** A word-bounded, case-sensitive match of a program's name in a text. */
const mentions = (text, name) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text);

/* ---------- the nine checks ---------- */

/** p1: the flow of a card read in place, with the card still on screen. */
async function p1(page) {
  await fresh(page);
  const ids = await cardIds(page);
  /* Only the steps on the path of the case count (the lanes it does not take are drawn off). Pick a card in the middle of its flow: not at the first step (nothing done to show) and, when there is one, not at the last (a mutant that marks every later step as current would hide). */
  let pick = null;
  let fallback = null;
  for (const id of ids.slice(0, 40)) {
    await goHash(page, `/da-fare/card/${id}/flusso`);
    await page.waitForSelector("[data-flow-readonly] [data-flow-step]:not([data-flow-step-off])");
    const at = await page.evaluate(() => {
      const steps = [...document.querySelectorAll("[data-flow-readonly] [data-flow-step]:not([data-flow-step-off])")];
      return { index: steps.findIndex((s) => s.hasAttribute("data-flow-step-current")), total: steps.length };
    });
    if (at.index > 0 && at.index < at.total - 1) { pick = { id, ...at }; break; }
    if (at.index > 0 && !fallback) fallback = { id, ...at };
  }
  pick ??= fallback;
  if (!pick) return { problems: [`nessuna delle ${Math.min(ids.length, 40)} card provate è oltre il primo passo del suo flusso`] };

  await fresh(page);
  await goHash(page, `/da-fare/card/${pick.id}`);
  await press(page, page.locator("[data-open-flow]"));
  await page.waitForSelector("[data-flow-readonly]", { timeout: 6000 });
  await beat(page, 300);
  const problems = [];
  const here = await hashOf(page);
  if (!here.endsWith("/flusso")) problems.push(`l'indirizzo è ${here}, non finisce in /flusso`);
  const m = await page.evaluate(() => {
    const panel = document.querySelector("[data-flow-readonly]");
    const steps = [...panel.querySelectorAll("[data-flow-step]:not([data-flow-step-off])")];
    const done = [...panel.querySelectorAll("[data-flow-step-done]")];
    const title = document.querySelector("[data-card-section=header] h1");
    let titleSeen = false;
    if (title) {
      const r = title.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 12, r.top + r.height / 2);
      titleSeen = r.width > 0 && !!hit && title.contains(hit);
    }
    return {
      visible: panel.getClientRects().length > 0,
      steps: steps.length,
      current: panel.querySelectorAll("[data-flow-step-current]").length,
      currentAt: steps.findIndex((s) => s.hasAttribute("data-flow-step-current")),
      done: done.length,
      /* «Fatto da Op. call center il 04/11 alle 16:30»: a name, then the day and the hour. */
      doneWithWho: done.filter((d) => /[A-Za-zÀ-ÿ][^\n]*\d{2}\/\d{2}\D{1,8}\d{1,2}:\d{2}/.test(d.innerText)).length,
      titleSeen,
    };
  });
  if (!m.visible) problems.push("il pannello del flusso non è visibile");
  if (m.current !== 1) problems.push(`passi segnati come corrente: ${m.current}, attesi 1`);
  if (m.done < 1) problems.push("nessun passo fatto");
  else if (m.doneWithWho < 1) problems.push("nessun passo fatto dice chi e quando");
  if (m.done !== pick.index) problems.push(`passi fatti ${m.done}, ma la card è al passo ${pick.index + 1}`);
  if (!m.titleSeen) problems.push("il titolo della card non si vede accanto al pannello");
  await shot(page, "p1-flusso-in-lettura");
  await page.keyboard.press("Escape");
  await beat(page, 200);
  const closed = await page.locator("[data-flow-readonly]").count();
  const back = await hashOf(page);
  if (closed) problems.push("Esc non chiude il pannello");
  if (back !== `#/da-fare/card/${pick.id}`) problems.push(`dopo Esc l'indirizzo è ${back}, atteso #/da-fare/card/${pick.id}`);
  return { problems, measure: `card ${pick.id} al passo ${pick.index + 1} di ${pick.total}: ${m.done} fatti (${m.doneWithWho} con chi e quando), 1 corrente` };
}

/** p2: the kanban at 1440x900, wide columns, nothing cut, a strip that scrolls. */
async function p2(page) {
  await fresh(page);
  await press(page, page.locator("[data-screen=orbit-list] [role=tablist] [data-view=kanban]"));
  await page.waitForSelector("[data-screen=orbit-kanban] [data-kanban-column]");
  await beat(page, 300);
  const m = await page.evaluate(() => {
    const cols = [...document.querySelectorAll("[data-kanban-column]")];
    const strip = document.querySelector("[data-kanban-columns]");
    const cut = [];
    let cards = 0;
    let checked = 0;
    for (const card of document.querySelectorAll("[data-kanban-card]")) {
      cards++;
      for (const el of card.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        const clip = cs.getPropertyValue("-webkit-line-clamp");
        const clipped = cs.overflowX !== "visible" || cs.overflowY !== "visible" || cs.textOverflow === "ellipsis" || (clip !== "" && clip !== "none");
        if (!clipped) continue;
        checked++;
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
          cut.push(`${card.getAttribute("data-kanban-card")}: «${(el.textContent ?? "").trim().slice(0, 40)}» ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
        }
      }
    }
    const last = cols.at(-1)?.getBoundingClientRect();
    const box = strip?.getBoundingClientRect();
    /* A column the edge of the strip cuts in two (read at the start of the strip): its words are cut with it. */
    /* A sliver of border past the last whole column only says there are more; 24 px of a column already shows cut words. */
    const halved = box ? cols.filter((c) => { const r = c.getBoundingClientRect(); return r.left < box.right - 24 && r.right > box.right + 1; }).map((c) => c.getAttribute("data-kanban-column")) : [];
    let scrolled = null;
    if (strip && strip.scrollWidth > strip.clientWidth + 1) {
      strip.scrollLeft = strip.scrollWidth;
      scrolled = strip.scrollLeft;
      strip.scrollLeft = 0;
    }
    return {
      widths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
      cards,
      checked,
      cut,
      stripOverflowX: strip ? getComputedStyle(strip).overflowX : null,
      stripScroll: strip ? strip.scrollWidth : 0,
      stripClient: strip ? strip.clientWidth : 0,
      scrolled,
      lastInside: last && box ? last.right <= box.right + 1 : true,
      halved,
      pageScroll: document.scrollingElement.scrollWidth - innerWidth,
    };
  });
  const problems = [];
  if (!m.widths.length) problems.push("nessuna colonna");
  /* 264 px is the least a card of the kanban reads in without cutting a word (the floor of the column width). */
  const narrow = m.widths.filter((w) => w < 264);
  if (narrow.length) problems.push(`colonne sotto i 264 px: ${m.widths.join(", ")}`);
  if (m.halved.length) problems.push(`il bordo della striscia taglia a metà la colonna ${m.halved.join(", ")}`);
  if (m.cut.length) problems.push(`${m.cut.length} testi tagliati, per esempio ${m.cut.slice(0, 2).join(" | ")}`);
  if (m.stripScroll > m.stripClient + 1) {
    if (!/(auto|scroll)/.test(m.stripOverflowX ?? "")) problems.push(`le colonne non ci stanno (${m.stripScroll} su ${m.stripClient}) e la striscia non scorre`);
    else if (!m.scrolled) problems.push("la striscia dichiara di scorrere ma non si sposta");
  } else if (!m.lastInside) problems.push("l'ultima colonna esce dalla striscia che non scorre");
  if (m.pageScroll > 1) problems.push(`la pagina scorre di lato di ${m.pageScroll} px`);
  await shot(page, "p2-kanban");
  return { problems, measure: `${m.widths.length} colonne larghe ${Math.min(...m.widths)}-${Math.max(...m.widths)} px, ${m.cards} card, ${m.checked} elementi tagliabili senza taglio, striscia ${m.stripScroll}/${m.stripClient} px` };
}

/** p3: the card page read from the top, once. */
async function p3(page) {
  await fresh(page);
  const ids = await cardIds(page);
  let pick = null;
  for (const id of ids.slice(0, 30)) {
    await goHash(page, `/da-fare/card/${id}`);
    await page.waitForSelector("[data-card-section=header]");
    const ok = await page.evaluate(() => !!document.querySelector("[data-card-section=header] [data-token=due]") && !!document.querySelector("[data-card-next] [role=group] button"));
    if (ok) { pick = id; break; }
  }
  if (!pick) return { problems: [`nessuna delle ${Math.min(ids.length, 30)} card prime ha scadenza e prossima azione nell'intestazione`] };
  await goHash(page, `/da-fare/card/${pick}`);
  const m = await page.evaluate(() => {
    const sections = [...document.querySelectorAll("[data-screen=orbit-card] [data-card-section]")];
    const header = document.querySelector("[data-card-section=header]");
    const action = header?.querySelector("[data-card-next] [role=group] button");
    const nameEl = header?.querySelector("span.truncate");
    const name = nameEl?.textContent?.trim() ?? "";
    const above = sections.filter((s) => s.getAttribute("data-card-section") !== "chat");
    let flowNames = 0;
    for (const s of above) for (const e of s.querySelectorAll("*")) if (e.children.length === 0 && (e.textContent ?? "").trim() === name && name) flowNames++;
    return {
      order: sections.map((s) => s.getAttribute("data-card-section")),
      title: header?.querySelector("h1")?.textContent?.trim() ?? "",
      stage: !!header?.querySelector("[data-card-stage]"),
      worker: !!header?.querySelector("[data-token=worker]"),
      due: !!header?.querySelector("[data-token=due]"),
      action: action ? { label: action.textContent?.trim() ?? "", primary: /\bbg-primary\b|\bbg-emerald-700\b/.test(action.className), on: !action.disabled && action.getAttribute("aria-disabled") !== "true" } : null,
      name,
      flowNames,
      links: /Collegamenti/i.test(document.querySelector("[data-screen=orbit-card]")?.innerText ?? ""),
      why: document.querySelector("[data-action-why]")?.innerText.trim() ?? "",
    };
  });
  const problems = [];
  if (m.order.join(",") !== "header,original,history,chat") problems.push(`sezioni nell'ordine ${m.order.join(", ")}, attese header, original, history, chat`);
  if (!m.title) problems.push("l'intestazione non ha il titolo");
  if (!m.stage) problems.push("l'intestazione non dice lo stato");
  if (!m.worker) problems.push("l'intestazione non dice chi ci lavora");
  if (!m.due) problems.push("l'intestazione non dice la scadenza");
  if (!m.action) problems.push("l'intestazione non ha la prossima azione");
  /* A card that waits for someone else has its next action off (drawn as off, not as the primary): then the reason is written beside it, not only in a tooltip. */
  else if (!m.action.on) { if (!m.why) problems.push(`la prossima azione «${m.action.label}» è spenta e il motivo non è scritto a schermo`); }
  else if (!m.action.primary) problems.push(`la prossima azione «${m.action.label}» non è il bottone primario`);
  if (!m.name) problems.push("il nome del flusso non si legge nell'intestazione");
  else if (m.flowNames !== 1) problems.push(`il nome del flusso «${m.name}» compare ${m.flowNames} volte sopra la chat, atteso 1`);
  if (m.links) problems.push("c'è ancora un blocco «Collegamenti»");
  await shot(page, "p3-dettaglio-card");
  return { problems, measure: `card ${pick}: sezioni ${m.order.join(">")}, «${m.name}» ${m.flowNames} volta, azione «${m.action?.label ?? "-"}»` };
}

/** p4: two demos, each one organization, the same four rows and menus. */
async function p4(page) {
  const problems = [];
  await page.goto("about:blank");
  await page.goto(`${base}?fresh=1&speed=0.1`);
  await page.waitForFunction(() => window.__demo && document.querySelector("[data-screen]"));
  await beat(page, 300);
  const first = await page.evaluate(() => ({ screen: document.querySelector("[data-screen]")?.getAttribute("data-screen"), hash: location.hash }));
  if (first.screen !== "orbit-list" || first.hash !== "#/da-fare") problems.push(`parte da ${first.screen} (${first.hash}), non da Da fare in Elenco (#/da-fare)`);
  const side = await page.evaluate(() => {
    const tree = document.querySelector("[role=tree]");
    const groups = tree ? [...tree.querySelectorAll(":scope > [role=group]")] : [];
    const items = tree ? [...tree.querySelectorAll("[role=treeitem]")].map((r) => r.innerText.replace(/\s+/g, " ").trim()) : [];
    const org = tree?.querySelector("[role=treeitem] button[aria-haspopup=menu]")?.closest("[role=treeitem]");
    return { groups: groups.length, items, org: org?.innerText.replace(/\s+/g, " ").trim() ?? "", nav: tree?.closest("nav")?.innerText ?? "" };
  });
  if (side.groups !== 1) problems.push(`la barra laterale ha ${side.groups} organizzazioni, attesa 1`);
  if (!ORG.has.test(side.org)) problems.push(`l'organizzazione in barra è «${side.org}», non quella di ${ENTRY}`);
  if (ORG.not.test(side.nav)) problems.push(`la barra laterale nomina anche l'altra organizzazione (${ORG.not})`);
  for (const label of ["Da fare", "Flussi", "Conoscenza", "Programmi"]) {
    const n = side.items.filter((t) => t.startsWith(label)).length;
    if (n !== 1) problems.push(`la riga «${label}» compare ${n} volte nella barra laterale`);
  }
  await shot(page, "p4-da-fare");

  /* Right click on the organization's row: its menu. */
  const orgRow = page.locator("[role=tree] [role=treeitem]").filter({ has: page.locator("button[aria-haspopup=menu]") }).first();
  if (VIDEO) { const box = await orgRow.boundingBox(); if (box) await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 12 }); }
  await orgRow.click({ button: "right" });
  await page.locator("[role=menu]").first().waitFor({ state: "visible" });
  const menu = await page.locator("[role=menu] [role=menuitem]").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  for (const label of ["Impostazioni", "Squadra"]) if (!menu.some((t) => t.startsWith(label))) problems.push(`il menu dell'organizzazione non ha «${label}» (ha: ${menu.join(", ")})`);
  await shot(page, "p4-menu-organizzazione");
  await page.keyboard.press("Escape");
  await beat(page);

  /* The four rows, each with its own screen; Conoscenza with its two sections. */
  await press(page, row(page, "Flussi"));
  await page.waitForSelector("[data-screen=orbit-flows]");
  await beat(page, 200);
  await shot(page, "p4-flussi");
  await press(page, row(page, "Conoscenza"));
  await page.waitForSelector("nav[aria-label='Sezioni di Conoscenza']");
  const subs = await page.locator("nav[aria-label='Sezioni di Conoscenza']").locator("button, a").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  for (const label of ["Contratti", "Dati"]) if (!subs.some((t) => t.startsWith(label))) problems.push(`Conoscenza non ha la sezione «${label}» (ha: ${subs.join(", ")})`);
  await press(page, subNav(page, "Sezioni di Conoscenza", "Contratti"));
  await page.waitForSelector("[data-screen=orbit-contracts]");
  await beat(page, 200);
  await shot(page, "p4-contratti");
  await press(page, subNav(page, "Sezioni di Conoscenza", "Dati"));
  await page.waitForSelector("[data-screen=orbit-data]");
  await beat(page, 200);
  await shot(page, "p4-dati");
  await press(page, row(page, "Programmi"));
  await page.waitForSelector("[data-screen=orbit-programs]");
  await beat(page, 200);
  await shot(page, "p4-programmi");

  /* The person at the foot opens their own menu. */
  await press(page, page.locator("[data-sidebar-identity]"));
  await page.locator("[role=menu]").first().waitFor({ state: "visible" });
  const person = await page.locator("[role=menu] [role=menuitem], [role=menu] [role=menuitemradio]").count();
  if (person < 2) problems.push(`il menu della persona ha ${person} voci`);
  await page.keyboard.press("Escape");
  return { problems, measure: `parte da ${first.hash} (${first.screen}), 1 organizzazione «${side.org}», menu dell'organizzazione: ${menu.join(", ")}; Conoscenza: ${subs.join(", ")}; menu della persona: ${person} voci` };
}

/** p5: the AI chat, general and inside a card. */
async function p5(page) {
  await fresh(page);
  const stuck = await stuckIds(page);
  const all = await cardIds(page);
  const problems = [];
  if (!stuck.length) problems.push("la kanban non ha nessuna card ferma da cui verificare la risposta");
  const before = await page.locator("[role=tree] [role=treeitem]").evaluateAll((els) => els.map((e) => e.innerText.trim()));
  await press(page, page.locator("[data-new-chat]").first());
  const field = page.locator("[data-chat-composer]").first();
  await field.waitFor({ state: "visible" });
  await field.click();
  await typeSlow(page, "quali card sono ferme?");
  await page.keyboard.press("Enter");
  const answered = await page.waitForSelector("[data-chat-reply]", { timeout: 10000 }).then(() => true, () => false);
  if (!answered) return { problems: ["dopo 10 s nessuna risposta [data-chat-reply] nella chat"] };
  await beat(page, 300);
  const refs = await page.locator("[data-chat-reply] [data-chat-ref=card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-chat-ref-id")));
  const cited = [...new Set(refs)];
  if (!cited.length) problems.push("la risposta non ha collegamenti a card");
  else {
    const ghosts = cited.filter((id) => !all.includes(id));
    const ok = cited.filter((id) => stuck.includes(id));
    if (ghosts.length) problems.push(`la risposta cita card che non esistono: ${ghosts.join(", ")}`);
    if (!ok.length) problems.push(`nessuna card citata (${cited.join(", ")}) è ferma nella demo (ferme: ${stuck.join(", ")})`);
  }
  const after = await page.locator("[role=tree] [role=treeitem]").evaluateAll((els) => els.map((e) => e.innerText.trim()));
  const added = after.filter((t) => !before.includes(t) && /card sono ferme/i.test(t));
  if (!added.length) problems.push("la chat non compare nella barra laterale");
  await shot(page, "p5-chat");

  /* In a card: a suggested question. */
  const id = all[0];
  await goHash(page, `/da-fare/card/${id}`);
  const chat = page.locator("[data-card-section=chat]");
  await chat.waitFor();
  if ((await chat.getAttribute("data-open")) === "false") await press(page, chat.locator("h2 button"));
  const suggestion = chat.locator("[data-chat-suggestion]").first();
  await suggestion.scrollIntoViewIfNeeded();
  const asked = (await suggestion.innerText()).trim();
  const repliesBefore = await chat.locator("[data-chat-reply]").count();
  await press(page, suggestion);
  const cardAnswered = await page.waitForFunction((n) => document.querySelectorAll("[data-card-section=chat] [data-chat-reply]").length > n, repliesBefore, { timeout: 10000 }).then(() => true, () => false);
  if (!cardAnswered) return { problems: [...problems, `dopo 10 s nessuna risposta [data-chat-reply] alla domanda «${asked}» nella card ${id}`] };
  await beat(page, 300);
  const reply = await chat.locator("[data-chat-reply]").last().evaluate((e) => ({ text: e.innerText, refs: [...e.querySelectorAll("[data-chat-ref-id]")].map((r) => r.getAttribute("data-chat-ref-id")) }));
  if (!reply.text.includes(id) && !reply.refs.includes(id)) problems.push(`la risposta alla domanda «${asked}» non cita l'id ${id}`);
  await chat.scrollIntoViewIfNeeded();
  await shot(page, "p5-chat-card");
  return { problems, measure: `«quali card sono ferme?» cita ${cited.join(", ") || "nessuna"} (ferme: ${stuck.length}); in ${id} la domanda «${asked.slice(0, 40)}» risponde citando ${id}` };
}

/** p6: no pinned programs in the sidebar. */
async function p6(page) {
  await fresh(page);
  const m = await page.evaluate(() => {
    const nav = document.querySelector("[role=tree]")?.closest("nav");
    return {
      pins: document.querySelectorAll("[data-sidebar-pins]").length,
      tiles: nav ? [...nav.querySelectorAll("[class~='h-[34px]']")].filter((e) => !e.closest("[data-sidebar-identity]") && !e.hasAttribute("data-sidebar-identity")).length : -1,
      pinnedGroup: nav ? nav.querySelectorAll("[aria-label='Fissati']").length : -1,
      top: nav ? [...nav.querySelectorAll("button[aria-label]")].slice(0, 3).map((b) => b.getAttribute("aria-label")) : [],
    };
  });
  const problems = [];
  if (m.pins) problems.push(`${m.pins} riga/righe di programmi fissati (data-sidebar-pins)`);
  if (m.tiles > 0) problems.push(`${m.tiles} tessere nella barra laterale`);
  if (m.pinnedGroup > 0) problems.push("c'è un gruppo «Fissati» nella barra laterale");
  if (m.tiles < 0) problems.push("la barra laterale non c'è");
  for (const label of ["Notifiche", "Cerca", "Nuovo"]) if (!m.top.includes(label)) problems.push(`in alto manca «${label}» (c'è: ${m.top.join(", ")})`);
  await shot(page, "p6-barra");
  return { problems, measure: `0 righe di fissati, 0 tessere; in alto: ${m.top.join(", ")}` };
}

/** p7: one global search, grouped, marked, driven by the keyboard; the local filter is another field. */
async function p7(page) {
  await fresh(page);
  const names = await programNames(page);
  await fresh(page);
  const ids = await cardIds(page);
  await fresh(page);
  const problems = [];
  const id = ids[0];
  const name = names[0];
  if (!name) return { problems: ["nessun nome di programma letto dalla pagina Programmi"] };

  /* A short session before searching, as a person has one: a card and the flows, so «Recenti» has something to show. */
  await goHash(page, `/da-fare/card/${ids[1] ?? id}`);
  await goHash(page, "/flussi");
  await goHash(page, "/da-fare");
  await page.keyboard.press("Meta+k");
  await page.locator("[data-global-search]").waitFor({ state: "visible" });
  await beat(page, 300);
  const empty = await page.evaluate(() => ({ recent: document.querySelectorAll("[data-global-search] [data-search-group=recenti]").length, suggested: document.querySelectorAll("[data-global-search] [data-search-group=suggeriti]").length }));
  if (!empty.recent && !empty.suggested) problems.push("a campo vuoto non ci sono né Recenti né Suggeriti");
  await shot(page, "p7-ricerca-vuota");

  /* A place both organizations work in: the results come in several groups at once, each with the place marked. */
  await typeSlow(page, "Sarno");
  await page.waitForSelector("[data-global-search] [data-search-result]");
  await beat(page, 300);
  const groups = await page.evaluate(() => [...document.querySelectorAll("[data-global-search] [data-search-group]")].map((g) => g.getAttribute("data-search-group")).filter((g) => g !== "recenti" && g !== "suggeriti"));
  if (groups.length < 3) problems.push(`«Sarno» trova ${groups.length} gruppi (${groups.join(", ")}), attesi almeno 3`);
  await shot(page, "p7-ricerca-gruppi");
  await page.locator("[data-global-search-field]").fill("");
  await beat(page, 200);

  /* A card by its id: first in its group, the found text marked. */
  await typeSlow(page, id);
  await page.waitForSelector("[data-global-search] [data-search-group=card] [data-search-result]");
  await beat(page, 300);
  const found = await page.evaluate((cardId) => {
    const first = document.querySelector("[data-global-search] [data-search-group=card] [data-search-result]");
    return { text: first?.innerText ?? "", marks: first?.querySelectorAll("mark").length ?? 0, options: document.querySelectorAll("[data-global-search] [role=option]").length };
  }, id);
  if (!found.text.includes(id)) problems.push(`il primo risultato dei card non è ${id} (è «${found.text.replace(/\s+/g, " ").slice(0, 60)}»)`);
  if (!found.marks) problems.push(`il testo trovato non è in <mark> nel risultato di ${id}`);
  await shot(page, "p7-ricerca");
  const field = page.locator("[data-global-search-field]");
  const activeOf = () => field.getAttribute("aria-activedescendant");
  const first = await activeOf();
  await page.keyboard.press("ArrowDown");
  const moved = await activeOf();
  if (found.options > 1 && moved === first) problems.push("↓ non sposta il risultato attivo");
  await page.keyboard.press("ArrowUp");
  if ((await activeOf()) !== first) problems.push("↑ non riporta al primo risultato");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("[data-global-search]"));
  await page.waitForFunction((cardId) => location.hash === `#/da-fare/card/${cardId}`, id, { timeout: 4000 }).catch(() => {});
  const landed = await hashOf(page);
  if (landed !== `#/da-fare/card/${id}`) problems.push(`Invio sul risultato di ${id} porta a ${landed}`);

  /* A program by its name: its group, and ↓ Invio opens it. */
  await page.keyboard.press("Meta+k");
  await page.locator("[data-global-search]").waitFor({ state: "visible" });
  await typeSlow(page, name);
  await page.waitForSelector("[data-global-search] [data-search-group=programmi] [data-search-result]");
  await beat(page, 200);
  const programFirst = await page.locator("[data-global-search] [data-search-group=programmi] [data-search-result]").first().innerText();
  if (!programFirst.includes(name)) problems.push(`il primo risultato dei programmi non è «${name}» (è «${programFirst.replace(/\s+/g, " ").slice(0, 50)}»)`);
  let presses = 0;
  for (; presses < 40; presses++) {
    const inGroup = await page.evaluate(() => {
      const active = document.querySelector("[data-global-search] [role=option][aria-selected=true]");
      return !!active?.closest("[data-search-group=programmi]");
    });
    if (inGroup) break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("[data-global-search]"));
  await beat(page, 200);
  const programAt = await hashOf(page);
  if (!programAt.startsWith("#/programmi/")) problems.push(`Invio sul programma «${name}» porta a ${programAt}`);

  /* The filter of the list is another field. */
  await goHash(page, "/da-fare");
  await page.keyboard.press("Meta+k");
  await page.locator("[data-global-search]").waitFor({ state: "visible" });
  const fields = await page.evaluate(() => {
    const local = document.querySelector("[data-screen=orbit-list] [data-local-filter]");
    const global = document.querySelector("[data-global-search-field]");
    return { local: !!local, inside: !!local?.closest("[data-global-search]"), same: local === global, localHint: local?.getAttribute("placeholder") ?? "", globalHint: global?.getAttribute("placeholder") ?? "" };
  });
  if (!fields.local) problems.push("il Da fare non ha il campo [data-local-filter]");
  else if (fields.inside || fields.same) problems.push("il filtro locale è lo stesso campo della ricerca globale");
  else if (fields.localHint === fields.globalHint) problems.push(`il filtro locale e la ricerca dicono la stessa cosa («${fields.localHint}»)`);
  await page.keyboard.press("Escape");
  return { problems, measure: `${id}: primo con ${found.marks} <mark>, ↓↑ ${found.options > 1 ? "muovono" : "(un solo risultato)"}, Invio apre la card; «${name}» dopo ${presses} ↓ apre ${programAt}; filtro locale «${fields.localHint}» ≠ «${fields.globalHint}»` };
}

/** p8: nothing in the chrome names a program or offers a «Nuovo …» that leads to one. */
async function p8(page) {
  await fresh(page);
  const names = await programNames(page);
  await fresh(page);
  const problems = [];
  if (!names.length) return { problems: ["nessun nome di programma letto dalla pagina Programmi"] };
  /* «Nuovo» alone, «Nuova chat…» and «Nuova scheda» are the shell's own; any other «Nuovo <something>» is an entry to create or open something. */
  const NEW = /^Nuov[oa]\s+(?!chat\b|scheda\b)\S/i;
  /** Every text and label that sits outside the pane (the sidebar, the strip of tabs, the buttons around). */
  const outside = () => page.evaluate(() => {
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest("[data-screen]") || el.querySelector("[data-screen]")) continue;
      for (const a of ["aria-label", "data-tip", "title"]) { const v = el.getAttribute(a); if (v) out.push(v.trim()); }
      if (el.children.length === 0 && el.textContent?.trim()) out.push(el.textContent.trim());
    }
    return out;
  });
  const scan = (texts, where) => {
    for (const t of texts) {
      const hit = names.find((n) => mentions(t, n));
      if (hit) problems.push(`${where} nomina il programma «${hit}» («${t.slice(0, 40)}»)`);
      if (NEW.test(t)) problems.push(`${where} ha una voce «${t.slice(0, 40)}»`);
    }
  };
  const chrome = await outside();
  scan(chrome, "la barra laterale o la riga in alto");
  await press(page, page.locator("nav:has([role=tree]) button[aria-label='Nuovo']"));
  await page.waitForSelector("[data-screen=new-tab]");
  await beat(page, 200);
  const pane = await page.evaluate(() => {
    const screen = document.querySelector("[data-screen=new-tab]");
    return { text: screen?.innerText ?? "", labels: [...(screen?.querySelectorAll("button") ?? [])].map((b) => b.innerText.replace(/\s+/g, " ").trim()) };
  });
  scan([...pane.labels, ...pane.text.split("\n").map((l) => l.trim()).filter(Boolean)], "la pagina della nuova scheda");
  const after = await outside();
  scan(after, "la barra con la nuova scheda aperta");
  return { problems: [...new Set(problems)], measure: `${names.length} programmi (${names.slice(0, 4).join(", ")}…) cercati in ${chrome.length} testi della cornice e ${pane.labels.length} azioni della nuova scheda: nessuno` };
}

/** p9: tabs like Topics: one preview tab, replaced by navigation, kept by an interaction. */
async function p9(page) {
  await fresh(page);
  const problems = [];
  const state = async () => page.evaluate(() => ({
    tabs: document.querySelectorAll("[role=tablist] [role=tab][data-tab-key]").length,
    preview: document.querySelectorAll("[role=tablist] [role=tab][data-tab-preview]").length,
    pinned: document.querySelectorAll("[role=tablist] [role=tab][data-tab-pinned]").length,
  }));
  const log = [];
  for (const label of ["Da fare", "Flussi", "Conoscenza", "Programmi", "Da fare"]) {
    await press(page, row(page, label));
    await beat(page, 200);
  }
  const five = await state();
  log.push(`5 navigazioni: ${five.tabs} scheda`);
  if (five.tabs !== 1) problems.push(`dopo 5 navigazioni di fila ci sono ${five.tabs} schede, attesa 1`);
  if (five.preview !== 1) problems.push(`la scheda dopo 5 navigazioni non è di anteprima (${five.preview} di anteprima)`);

  /* Writing in the filter keeps the tab. */
  const filter = page.locator("[data-screen=orbit-list] [data-local-filter]");
  await press(page, filter);
  await typeSlow(page, "ma");
  await beat(page, 200);
  const typed = await state();
  log.push(`scritto nel filtro: ${typed.pinned} fissata`);
  if (typed.pinned !== 1 || typed.preview !== 0) problems.push(`scrivendo nel filtro la scheda non si fissa (${typed.pinned} fissate, ${typed.preview} di anteprima)`);
  await page.keyboard.press("Escape");

  await press(page, row(page, "Flussi"));
  await beat(page, 200);
  const flows = await state();
  log.push(`Flussi: ${flows.tabs} schede`);
  if (flows.tabs !== 2 || flows.preview !== 1) problems.push(`dopo Flussi: ${flows.tabs} schede, ${flows.preview} di anteprima (attese 2 e 1)`);
  await press(page, row(page, "Conoscenza"));
  await beat(page, 200);
  const knowledge = await state();
  log.push(`Conoscenza: ${knowledge.tabs} schede`);
  if (knowledge.tabs !== 2 || knowledge.preview !== 1) problems.push(`dopo Conoscenza: ${knowledge.tabs} schede, ${knowledge.preview} di anteprima (attese 2 e 1)`);
  /* The capture of point 9: one pinned tab beside the one in italics that the next navigation will replace. */
  await shot(page, "p9-schede");

  const previewTab = page.locator("[role=tablist] [role=tab][data-tab-preview]").first();
  const box = await previewTab.boundingBox();
  if (VIDEO && box) await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2, { steps: 12 });
  await previewTab.dblclick({ position: { x: Math.max(8, (box?.width ?? 60) / 2 - 10), y: (box?.height ?? 28) / 2 } });
  await beat(page, 200);
  const dbl = await state();
  log.push(`doppio clic: ${dbl.pinned} fissate`);
  if (dbl.preview !== 0 || dbl.pinned !== 2) problems.push(`il doppio clic non fissa la scheda di anteprima (${dbl.pinned} fissate, ${dbl.preview} di anteprima)`);
  await shot(page, "p9-schede-fissate");

  await press(page, row(page, "Da fare"));
  await page.waitForSelector("[data-screen=orbit-list] [data-card-row]");
  const before = await state();
  await press(page, page.locator("[data-screen=orbit-list] [data-card-row]").first());
  await page.waitForSelector("[data-screen=orbit-card]");
  await beat(page, 200);
  const card = await state();
  log.push(`clic su una card: ${before.tabs} → ${card.tabs} schede`);
  if (card.tabs !== before.tabs) problems.push(`il clic su una card apre una scheda (${before.tabs} → ${card.tabs})`);
  return { problems, measure: log.join("; ") };
}

const CHECKS = [
  ["p1", "flusso in lettura", p1],
  ["p2", "kanban larga", p2],
  ["p3", "dettaglio card", p3],
  ["p4", "due demo", p4],
  ["p5", "chat", p5],
  ["p6", "niente pillole", p6],
  ["p7", "ricerca", p7],
  ["p8", "niente voci senza senso", p8],
  ["p9", "schede", p9],
];

/* ---------- the run ---------- */

const { base, close } = await serveDist(SCRIPT, ENTRY, DIST);
const errors = [];
const videoDir = VIDEO ? join(tmpdir(), `ui-giro3-walk-${ENTRY}-${process.pid}`) : undefined;
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
  await page.goto(`${base}?fresh=1&speed=0.1#/da-fare`);
  booted = await page.waitForFunction(() => window.__demo && document.querySelector("[data-screen=orbit-list]"), undefined, { timeout: 15000 }).then(() => true, () => false);
  if (booted) {
    await page.evaluate(() => document.fonts.ready);
    for (const [id, name, run] of CHECKS) {
      if (ONLY && !ONLY.includes(id)) continue;
      let outcome;
      try {
        outcome = await run(page);
      } catch (e) {
        outcome = { problems: [`il controllo si è fermato: ${String(e.message).split("\n")[0]}`] };
      }
      const red = outcome.problems.length > 0;
      results.push({ id, name, red, reason: outcome.problems.join("; "), measure: outcome.measure ?? "" });
      console.log(`${red ? "ROSSO" : "ok   "} ${id}  ${name.padEnd(24)} ${red ? outcome.problems.join("; ") : outcome.measure}`);
    }
    if (VIDEO) await page.waitForTimeout(800);
  }
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
  close();
}

if (!booted) {
  console.error(`${SCRIPT}: la pagina non parte (nessun __demo o niente Da fare in Elenco): ${[...new Set(errors)].join(" | ") || "nessun errore in console"}`);
  process.exit(2);
}

const unique = [...new Set(errors)];
if (unique.length) console.error(`errori della pagina:\n  ${unique.join("\n  ")}`);

if (EXPECT_RED) {
  /* The planted-defect build: a control listed must be red, a control not listed must stay green. */
  const wanted = new Set(EXPECT_RED);
  const wrong = results.filter((r) => r.red !== wanted.has(r.id));
  const stayedGreen = results.filter((r) => wanted.has(r.id) && !r.red).map((r) => r.id);
  const wentRed = results.filter((r) => !wanted.has(r.id) && r.red).map((r) => r.id);
  console.log(`${SCRIPT}: ${results.filter((r) => r.red).length} rossi su ${results.length}`);
  if (stayedGreen.length) console.error(`rimasti VERDI sul mutante (la rottura non li tocca): ${stayedGreen.join(", ")}`);
  if (wentRed.length) console.error(`diventati rossi senza essere attesi: ${wentRed.join(", ")}`);
  if (wrong.length) process.exit(1);
  console.log(`${SCRIPT}: ok, rossi esattamente come attesi (${EXPECT_RED.join(", ")})`);
} else {
  const red = results.filter((r) => r.red);
  console.log(`${SCRIPT}: ${results.length - red.length} ok su ${results.length}, ${unique.length} errori in console`);
  if (red.length || unique.length) {
    console.error(`${SCRIPT}: FAIL${red.length ? `, rossi: ${red.map((r) => r.id).join(", ")}` : ""}${unique.length ? ", errori in console" : ""}`);
    process.exit(1);
  }
}
