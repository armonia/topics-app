#!/usr/bin/env node
/**
 * scripts/ui-app-walk.mjs - the whole tour of the organizations preview, the
 * way a person goes through it, failing on the first step that lands wrong.
 *
 * WHY. The crawler (`ui-app-crawl.mjs`) proves that every control does
 * something; it does not prove that the app holds together as a journey. This
 * walk does: every surface of the sidebar, the deep places behind them (a case,
 * its originals, where a value comes from, a flow, its test run, a law by
 * commas, a map check, a program), a case confirmed from the queue with the
 * queue count going down, the dark theme switched on and off, the search
 * (Cmd+K), a notification, the second organization, the Board, the browser's
 * back button, and a switch of person that changes what the sidebar shows.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `app.html` in headless WebKit at 1440x900 with a fresh state, and runs STEPS.
 * After each step it waits for the expected place (`data-screen`) and checks
 * the address; some steps also check a fact (a count, the theme, a menu item).
 *
 *   node scripts/ui-app-walk.mjs [--theme dark] [--video <file.webm>] [--shots <dir>]
 *
 * `--video` records the tour (a pointer is drawn into the page, since a
 * headless browser has none), slowed down to be watched and kept under 90 s.
 * `--shots` saves the moments marked `shot`. One browser, closed at the end.
 *
 * Exit 0: every step landed where it should, no page error.
 * Exit 1: the first step that went wrong, and why.
 */
import { runWalk, theme, video } from "./ui-app/walk-runner.mjs";

/** A sidebar row of the first organization (Consorzio di Nocera) by its label. */
const nav = (label) => (p) => p.locator("nav [role=treeitem]", { hasText: new RegExp(`^${label}`) }).first();
/** How many cases the sidebar says are waiting in «Da fare». */
const queueCount = (p) => p.locator("nav [role=treeitem]", { hasText: /^Da fare/ }).first().innerText().then((t) => Number(t.replace(/\D/g, "") || 0));

/**
 * Each step: what to press (`click`), or a key (`keys`), or the browser's back
 * button (`back`); then the place expected (`screen`, `hash` exact or
 * `prefix`) and an optional `check` that returns an error line or null.
 */
const STEPS = [
  { what: "Oggi, dalla barra laterale", click: nav("Oggi"), screen: "x05", hash: "#/oggi", shot: "giro-01-oggi" },
  { what: "Da fare, dalla barra laterale", click: nav("Da fare"), screen: "n12", prefix: "#/da-fare" },
  { what: "una voce della coda: lo sgravio", click: (p) => p.locator("[data-screen=n12] button", { hasText: "Sgravio 2026" }).first(), screen: "n12", hash: "#/da-fare/2416" },
  { what: "da dove viene un valore", click: (p) => p.locator("[data-screen=n12] button[aria-label^='Perché']").first(), screen: "v02", prefix: "#/da-fare/2416/origine/", shot: "giro-02-origine" },
  { what: "indietro alla voce", back: true, screen: "n12", hash: "#/da-fare/2416" },
  {
    what: "conferma e protocolla: la coda scende di uno",
    before: async (p, memo) => { memo.queue = await queueCount(p); },
    click: (p) => p.getByRole("button", { name: "Conferma e protocolla" }).first(),
    screen: "n12", prefix: "#/da-fare/",
    check: async (p, memo) => {
      const now = await queueCount(p);
      if (await p.evaluate(() => location.hash === "#/da-fare/2416")) return "è rimasta sulla voce confermata";
      return now === memo.queue - 1 ? null : `la coda era ${memo.queue}, ora ${now}`;
    },
  },
  { what: "dall'avviso, la pratica confermata", click: (p) => p.getByRole("button", { name: "Apri la pratica" }).last(), screen: "x06", hash: "#/pratiche/2416", shot: "giro-03-pratica" },
  { what: "un originale della pratica", click: (p) => p.locator("[data-screen=x06]").getByText(/\.pdf/).first(), screen: "v01", prefix: "#/pratiche/2416/documenti/" },
  { what: "Flussi, dalla barra laterale", click: nav("Flussi"), screen: "n01", hash: "#/flussi" },
  { what: "il flusso delle PEC", click: (p) => p.locator("[data-screen=n01] [role=row]").getByText("PEC in arrivo → protocollo").first(), screen: "w01", hash: "#/flussi/pec", shot: "giro-04-flusso" },
  { what: "il suo collaudo", click: (p) => p.getByRole("radio", { name: "Collaudo" }).first(), screen: "c01", hash: "#/flussi/pec/collaudo" },
  {
    what: "rigioca il collaudo: parte e finisce",
    before: async (p, memo) => { memo.testText = await p.locator("[data-screen=c01]").innerText(); },
    click: (p) => p.getByRole("button", { name: "Rigioca il collaudo" }).first(),
    screen: "c01", hash: "#/flussi/pec/collaudo",
    check: async (p, memo) => {
      /* It must visibly start (progress or new text), then end (no progress left). */
      const started = await p.waitForFunction((t) => !!document.querySelector("[role=progressbar]") || document.querySelector("[data-screen=c01]")?.innerText !== t, memo.testText, { timeout: 5000 }).then(() => true, () => false);
      if (!started) return "il collaudo non parte: niente cambia";
      const done = await p.waitForFunction(() => !document.querySelector("[role=progressbar]"), null, { timeout: 20000 }).then(() => true, () => false);
      return done ? null : "il collaudo non finisce";
    },
  },
  { what: "Dati, dalla barra laterale", click: nav("Dati"), screen: "x01", prefix: "#/dati" },
  { what: "Conoscenza, dalla barra laterale", click: nav("Conoscenza"), screen: "n13", hash: "#/conoscenza" },
  { what: "una legge, per commi", click: (p) => p.locator("[data-screen=n13] button", { hasText: "L.R. Campania 7/2025" }).first(), screen: "x03", prefix: "#/conoscenza/doc/lr-7-2025", shot: "giro-05-legge" },
  { what: "Viste, dalla barra laterale", click: nav("Viste"), screen: "a01", hash: "#/viste" },
  { what: "la verifica della particella", click: (p) => p.locator("[data-screen=a01] button", { hasText: /^Apri$/ }).first(), screen: "a02", prefix: "#/viste/particella/", shot: "giro-06-mappa" },
  { what: "Canali, dalla barra laterale", click: nav("Canali"), screen: "ch01", prefix: "#/canali" },
  { what: "Programmi, dalla barra laterale", click: nav("Programmi"), screen: "w06", hash: "#/programmi" },
  { what: "un programma: Halley", click: (p) => p.locator("[data-screen=w06] [role=row]").getByText("Halley", { exact: true }).first(), prefix: "#/programmi/app/halley" },
  { what: "Panoramica, dalla barra laterale", click: nav("Panoramica"), screen: "n18", hash: "#/panoramica", shot: "giro-07-panoramica" },
  { what: "Impostazioni, dalla barra laterale", click: nav("Impostazioni"), screen: "set-general", prefix: "#/impostazioni" },
  { what: "Aspetto", click: (p) => p.locator("[data-screen] button", { hasText: /^Aspetto$/ }).first(), screen: "d02", hash: "#/impostazioni/aspetto" },
  {
    what: "tema scuro",
    click: (p) => p.locator("[data-screen=d02] [role=radio], [data-screen=d02] button", { hasText: /^Scuro/ }).first(),
    screen: "d02", hash: "#/impostazioni/aspetto",
    check: async (p) => ((await p.evaluate(() => document.documentElement.classList.contains("dark"))) ? null : "il tema non è diventato scuro"),
    shot: "giro-08-scuro",
  },
  {
    what: "di nuovo chiaro",
    click: (p) => p.locator("[data-screen=d02] [role=radio], [data-screen=d02] button", { hasText: /^Chiaro/ }).first(),
    screen: "d02", hash: "#/impostazioni/aspetto",
    check: async (p) => ((await p.evaluate(() => document.documentElement.classList.contains("dark"))) ? "il tema è rimasto scuro" : null),
  },
  { what: "la ricerca (Cmd+K): «2418», Invio", keys: async (p) => { await p.keyboard.press("Meta+k"); await p.keyboard.type("2418", { delay: video ? 90 : 0 }); await p.waitForTimeout(250); await p.keyboard.press("Enter"); }, screen: "x06", hash: "#/pratiche/2418", shot: "giro-09-ricerca" },
  {
    what: "una notifica: l'esecuzione ferma",
    keys: async (p) => { await p.click("button[aria-label^='Notifiche']"); await p.waitForTimeout(250); await p.locator("[role=dialog] button", { hasText: "Esecuzione ferma" }).first().click(); },
    screen: "n11", hash: "#/flussi/pec/esecuzioni/e-0412",
  },
  { what: "la seconda organizzazione: ORBIT", click: (p) => p.locator("nav [role=treeitem]", { hasText: /^SA\s*ORBIT/ }).first(), expandOnly: true },
  { what: "il call center di ORBIT", click: (p) => p.locator("nav [role=treeitem]", { hasText: /^Call center/ }).first(), screen: "s03", prefix: "#/orbit/call-center", shot: "giro-10-orbit" },
  { what: "la Board", click: (p) => p.locator("nav [role=treeitem]", { hasText: /^Board/ }).first(), screen: "n17", prefix: "#/board" },
  { what: "indietro: il call center", back: true, screen: "s03", prefix: "#/orbit/call-center" },
  { what: "indietro: l'esecuzione ferma", back: true, screen: "n11", hash: "#/flussi/pec/esecuzioni/e-0412" },
  { what: "indietro: la pratica 2418", back: true, screen: "x06", hash: "#/pratiche/2418" },
  {
    what: "entra come revisore dei conti (sola lettura)",
    keys: async (p) => { await p.click("nav button[aria-expanded]"); await p.waitForTimeout(250); await p.locator("[role=menu] [role=menuitem], [role=menu] [role=menuitemradio], [role=dialog] button", { hasText: "Revisore dei conti" }).first().click(); },
    check: async (p) => {
      const settings = await p.locator("nav [role=treeitem]", { hasText: /^Impostazioni/ }).count();
      const who = await p.locator("nav button[aria-expanded]").innerText();
      if (!/Revisore/.test(who)) return `in basso c'è ancora «${who.replace(/\s+/g, " ")}»`;
      return settings === 0 ? null : "il revisore vede ancora Impostazioni";
    },
    shot: "giro-11-revisore",
  },
];

await runWalk({
  script: "ui-app-walk",
  start: "/panoramica",
  startScreen: "n18",
  startWhat: "Panoramica",
  steps: STEPS,
  done: (n) => `ui-app-walk: ok, ${n} passi in tutte le sezioni, zero errori (${theme})`,
});
