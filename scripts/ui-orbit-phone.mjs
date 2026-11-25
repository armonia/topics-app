#!/usr/bin/env node
/**
 * scripts/ui-orbit-phone.mjs - an edition (`orbit.html`, or `consorzio.html`
 * with `--entry consorzio`) on a phone (390x844, touch), failing on any
 * horizontal page scroll.
 *
 * WHY. The kanban has five columns and the compare of two contract versions
 * two texts side by side: on a phone both must become a strip that scrolls on
 * its own (the columns) or a single column (the compare), never a page wider
 * than the screen.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `orbit.html` as an iPhone-sized touch screen and walks through every
 * section, with the shared engine (`scripts/ui-app/phone-runner.mjs`): the list,
 * the kanban (its columns must sit in a sideways strip), the cards per stage, a flow kept by a filter,
 * a card and its original, the contracts, a contract, the compare,
 * the signatures, the deadlines, flows, data, knowledge, programs, team,
 * settings, the menu with the sidebar.
 *
 *   node scripts/ui-orbit-phone.mjs [--entry orbit|consorzio] [--shots <dir>]
 *
 * Exit 0: every step is on its place, no sideways scroll, no page error.
 */
import { runPhone } from "./ui-app/phone-runner.mjs";
import { arg } from "./ui-app/serve.mjs";

/** The kanban's columns must stand in a strip that scrolls sideways, not in the page. */
const columnsInStrip = (p) => p.evaluate(() => {
  const cols = [...document.querySelectorAll("[data-screen=orbit-kanban] [data-stage]")];
  if (cols.length < 2) return `colonne della kanban: ${cols.length}`;
  const strip = cols[0].parentElement?.closest(".overflow-x-auto, [class*='overflow-x-auto']");
  if (!strip) return "le colonne della kanban non stanno in una striscia che scorre di lato";
  return strip.scrollWidth > strip.clientWidth ? null : "la striscia delle colonne non scorre: le colonne sono schiacciate";
});

/* The pages of a contract (contracts area). The base page opens from the top; every other page opens with the strip of pages at the top of the screen, so its content is on show. */
/* Every box that scrolls, from the contract's own up to the page: on a phone it is the shell around the page that scrolls, not the contract's box. */
const contractAtTop = (p) => p.evaluate(() => {
  const box = document.querySelector("[data-screen=orbit-contract] [data-contract-scroll]");
  if (!box) return "la pagina del contratto non c'è";
  for (let n = box; n; n = n.parentElement) {
    if (n.scrollTop > 0) return `la pagina del contratto parte scorsa di ${Math.round(n.scrollTop)}px: il titolo non si vede`;
  }
  return null;
});
const stripAtTop = (screen) => (p) => p.evaluate((name) => {
  const strip = document.querySelector(`[data-screen=${name}] nav[aria-label="Pagine del contratto"]`);
  if (!strip) return "la striscia delle pagine del contratto non c'è";
  const top = strip.getBoundingClientRect().top;
  return top >= 0 && top < 260 ? null : `la striscia delle pagine sta a ${Math.round(top)}px dall'alto: il contenuto è sotto la piega`;
}, screen);
/** The reason under a button that is off is written once, not twice (the button's own line on a touch screen, and the page's line for a mouse). `strict`: the button must be off (ORBIT's Castellabate has a variant open); an organization whose first contract has none shows no reason at all. */
const reasonOnce = (strict) => (p) => p.evaluate((mustHave) => {
  const found = [...document.querySelectorAll("[data-screen=orbit-contract] span")].filter((e) => /va chiusa prima di aprirne un'altra/.test(e.textContent ?? "") && !e.querySelector("span") && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none");
  if (!found.length && !mustHave) return null;
  return found.length === 1 ? null : `il motivo sotto «Nuova variante» compare ${found.length} volte`;
}, strict);
/** The reason of a button that is off in the action box of a card is written once, under the button (touch) or in its tip (mouse), never both. `strict`: the card must have such a button (ORBIT's SG-4128 does). */
const cardActionReasonOnce = (strict) => (p) => p.evaluate((mustHave) => {
  const box = document.querySelector("[data-screen=orbit-card] [data-card-next]");
  if (!box) return "il riquadro della prossima azione della card non c'è";
  box.scrollIntoView({ block: "end" });
  const off = [...box.querySelectorAll("button[aria-disabled=true]")].map((b) => b.getAttribute("data-tip") ?? "").filter(Boolean);
  if (!off.length) return mustHave ? "nella prossima azione della card nessun pulsante spento col suo motivo" : null;
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== "none";
  for (const why of new Set(off)) {
    const found = [...box.querySelectorAll("span, p")].filter((e) => !e.querySelector("span, p") && (e.textContent ?? "").includes(why) && visible(e));
    if (found.length !== 1) return `il motivo «${why}» nella prossima azione della card compare ${found.length} volte`;
  }
  return null;
}, strict);
/** The permissions table of the signatures page: in view, one block per team, nothing wider than the screen. */
const permissionsInView = (p) => p.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-screen=orbit-signatures] tr[data-team]")];
  if (rows.length < 8) return `la tabella dei permessi ha ${rows.length} team su 8`;
  const table = rows[0].closest("table");
  table.scrollIntoView({ block: "start" });
  const box = table.parentElement;
  return box.scrollWidth > box.clientWidth + 1 ? "la tabella dei permessi scorre di lato" : null;
});

/** The page after signing out stands alone: no bottom bar, no menu button, no bell. */
const signedOutBare = (p) => p.evaluate(() => {
  const outside = [...document.querySelectorAll("button, nav")].filter((e) => !e.closest("[data-screen]"));
  return outside.length ? `da uscito restano ${outside.length} controlli fuori dalla pagina` : null;
});

const STEPS = [
  { what: "l'elenco di Da fare, raggruppato per flusso", go: "/da-fare", screen: "orbit-list" },
  { what: "la kanban di Da fare", go: "/da-fare/kanban", screen: "orbit-kanban", check: columnsInStrip },
  { what: "un flusso (vecchio indirizzo)", go: "/da-fare/fatture", screen: "orbit-kanban", check: columnsInStrip },
  { what: "le card per stato", go: "/da-fare/per-stato", screen: "orbit-stages" },
  { what: "uno stato (vecchio indirizzo)", go: "/da-fare/fatture/fase/verifica", screen: "orbit-kanban" },
  { what: "le regole", go: "/conoscenza/regole", screen: "orbit-rules" },
  { what: "una card in mano a un agente", go: "/da-fare/card/SG-4128", screen: "orbit-card", check: cardActionReasonOnce(true) },
  { what: "il suo originale", go: "/da-fare/card/SG-4129/originale/mail", screen: "orbit-card-original" },
  { what: "i contratti", go: "/conoscenza/contratti", screen: "orbit-contracts" },
  { what: "un contratto", go: "/conoscenza/contratti/c-castellabate", screen: "orbit-contract", check: async (p) => (await contractAtTop(p)) ?? (await reasonOnce(true)(p)) },
  { what: "una clausola", go: "/conoscenza/contratti/c-castellabate/clausola/art-9", screen: "orbit-contract" },
  { what: "le versioni", go: "/conoscenza/contratti/c-castellabate/versioni", screen: "orbit-versions", check: stripAtTop("orbit-versions") },
  { what: "il confronto delle versioni", go: "/conoscenza/contratti/c-castellabate/confronto/2/3", screen: "orbit-compare", check: stripAtTop("orbit-compare") },
  { what: "le firme, con la tabella di chi può fare cosa", go: "/conoscenza/contratti/c-castellabate/firme", screen: "orbit-signatures", check: async (p) => (await stripAtTop("orbit-signatures")(p)) ?? (await permissionsInView(p)) },
  { what: "le scadenze dei contratti", go: "/conoscenza/contratti/scadenze", screen: "orbit-contract-deadlines" },
  { what: "i flussi", go: "/flussi", screen: "orbit-flows" },
  { what: "un flusso", go: "/flussi/orbit-varianti", screen: "orbit-flow" },
  { what: "i dati", go: "/conoscenza/dati/contratti", screen: "orbit-data" },
  { what: "lo scadenzario", go: "/conoscenza/dati/scadenzario", screen: "orbit-deadlines" },
  { what: "la conoscenza", go: "/conoscenza/documenti", screen: "orbit-knowledge" },
  { what: "i programmi", go: "/programmi/sap", screen: "orbit-program" },
  { what: "la squadra per team", go: "/squadra", screen: "orbit-team" },
  { what: "un team", go: "/squadra/team/legale", screen: "orbit-team-of" },
  { what: "i permessi per team", go: "/squadra/permessi", screen: "orbit-permissions" },
  { what: "le impostazioni", go: "/impostazioni/organizzazione", screen: "orbit-settings" },
  { what: "le preferenze della persona", go: "/preferenze/aspetto", screen: "orbit-settings" },
  { what: "il menu con la barra laterale", press: (p) => p.getByRole("button", { name: "Menu" }).first(), overlay: "nav" },
  /* After signing out the phone has no bottom bar, no menu button, no bell: only the page and its «Rientra». */
  { what: "da uscito: solo la pagina", go: "/uscito", screen: "orbit-signed-out", check: signedOutBare },
];

/**
 * The same journey for another entry: its addresses are the first example of
 * each screen of the world, read from the page (`window.__demo.places()`), so
 * no id of one organization is written here. A screen the world has no
 * example of is left out.
 */
const forEntry = (entry) => async (page) => {
  const places = await page.evaluate(() => window.__demo.places());
  const sample = (screen) => places.find((x) => x.id === screen)?.samples[0];
  const seen = new Set();
  const out = [];
  for (const step of STEPS) {
    if (!step.go) { out.push(step); continue; }
    const go = sample(step.screen);
    if (!go || seen.has(go)) continue;
    seen.add(go);
    out.push({ ...step, go, check: step.screen === "orbit-card" ? cardActionReasonOnce(false) : step.screen === "orbit-contract" ? async (p) => (await contractAtTop(p)) ?? (await reasonOnce(false)(p)) : step.check });
  }
  return out;
};

const entry = arg("entry") ?? "orbit";
await runPhone({
  script: `ui-orbit-phone(${entry})`,
  entry,
  start: "/da-fare",
  steps: entry === "orbit" ? STEPS : forEntry(entry),
  done: (n) => `ui-orbit-phone(${entry}): ok, ${n} passi a 390x844 senza scroll orizzontale`,
});
