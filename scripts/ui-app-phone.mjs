#!/usr/bin/env node
/**
 * scripts/ui-app-phone.mjs - the main walk of the organizations preview on a
 * phone (390x844, touch), failing on any horizontal page scroll.
 *
 * WHY. On a phone a page that is wider than the screen is the first thing a
 * person notices and the last thing a desktop screenshot shows. Attilio's
 * mockup m01 is a phone; the app must work there for the people who confirm
 * and read cases away from the desk.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `app.html` in headless WebKit as an iPhone-sized touch screen, and walks the
 * way a person works from the phone: today, the queue, an input, where a value
 * comes from, the record, an original with its summary, the full sheet, the
 * Board, search, a flow, the knowledge, the menu with the sidebar. On every
 * screen it checks that the right place is drawn (`data-screen`), that the page
 * does not scroll sideways (document width <= viewport), that no scroller
 * scrolls sideways unless it is a strip made for it (`overflow-x-auto`), and
 * that no element pokes out of the screen unless it sits in such a strip.
 *
 *   node scripts/ui-app-phone.mjs [--shots <dir>]
 *
 * Exit 0: every step is on its place, no sideways scroll, no page error.
 */
import { runPhone } from "./ui-app/phone-runner.mjs";

/** Each step: how to get there (an address, or a press), and the place expected. */
const STEPS = [
  { what: "oggi", go: "/oggi", screen: "x05" },
  { what: "la coda di Da fare (barra in basso)", press: (p) => p.getByRole("button", { name: "Da fare" }).last(), screen: "n12" },
  { what: "una voce della coda", press: (p) => p.locator("[data-screen=n12] li button, [data-screen=n12] [role=row]").first(), screen: "n12" },
  { what: "da dove viene la scadenza", go: "/da-fare/2418/origine/scadenza", screen: "v02" },
  { what: "la pratica", go: "/pratiche/2418", screen: "x06" },
  { what: "un originale con il riassunto", go: "/pratiche/2418/documenti/d-ricorso", screen: "v01" },
  { what: "la scheda completa", go: "/pratiche/2418/scheda", screen: "w05" },
  { what: "la Board (barra in basso)", press: (p) => p.getByRole("button", { name: "Board" }).last(), screen: "n17" },
  { what: "la ricerca (barra in basso)", press: (p) => p.getByRole("button", { name: "Cerca" }).last(), overlay: "[role=dialog]" },
  { what: "i risultati di una ricerca", go: "/cerca/2418", screen: "search" },
  { what: "i flussi", go: "/flussi", screen: "n01" },
  { what: "il flusso PEC", go: "/flussi/pec", screen: "w01" },
  { what: "la conoscenza", go: "/conoscenza", screen: "n13" },
  { what: "una legge per commi", go: "/conoscenza/doc/lr-7-2025/a9c3", screen: "x03" },
  { what: "la panoramica", go: "/panoramica", screen: "n18" },
  { what: "le impostazioni", go: "/impostazioni/generale", screen: "set-general" },
  { what: "il menu con la barra laterale", press: (p) => p.getByRole("button", { name: "Menu" }).first(), overlay: "nav" },
];

await runPhone({
  script: "ui-app-phone",
  start: "/oggi",
  steps: STEPS,
  done: (n) => `ui-app-phone: ok, ${n} passi a 390x844 senza scroll orizzontale`,
});
