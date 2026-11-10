#!/usr/bin/env node
/**
 * scripts/ui-sarim-walk.mjs - the whole tour of the SARIM edition
 * (`sarim.html`), the way a person goes through it, failing on the first step
 * that lands wrong.
 *
 * WHY. The crawler proves that every control does something; this walk proves
 * that the edition holds together as a journey. Attilio (08/11) asked for an
 * app that starts at «Da fare» as a list grouped by flow, with one filter
 * component (search that suggests, filters as tokens), the kanban second,
 * «Contratti» and «Dati» under «Conoscenza», «Impostazioni» and «Squadra» in
 * the menu of SARIM, the person's own menu at the bottom left, and every old
 * address landing on its new place. This walk goes through exactly that, plus
 * the contract path (compare, approve, sign: the card of the variant reaches
 * «Fatto»), a permission changed for a team that shows up in the log, the
 * search, a notification, a switch of person that takes the approval away,
 * and signing out and back in.
 *
 * WHAT. Serves `client/dist-ui/` (run `bun run build:ui` first), opens
 * `sarim.html` in headless WebKit at 1440x900 with a fresh state and runs
 * STEPS through the shared engine (`scripts/ui-app/walk-runner.mjs`).
 *
 *   node scripts/ui-sarim-walk.mjs [--theme dark] [--video <file.webm>] [--shots <dir>]
 *
 * Exit 0: every step landed where it should, no page error.
 * Exit 1: the first step that went wrong, and why.
 */
import { runWalk, video } from "./ui-app/walk-runner.mjs";

/** A sidebar row by its label. */
const nav = (label) => (p) => p.locator("nav [role=treeitem]", { hasText: new RegExp(`^${label}`) }).first();
/** An entry of a section strip (`SubNav`), by the strip's name and the entry's label. */
const sub = (strip, label) => (p) => p.locator(`nav[aria-label="${strip}"]`).locator("button, a").filter({ hasText: new RegExp(`^${label}`) }).first();
/** A view of the switch in a header (Elenco, Kanban, Per stato; Tabella, Bacheca...). */
const view = (screen, id) => (p) => p.locator(`[data-screen=${screen}] [role=tablist] [data-view=${id}]`).first();
/** The column a card stands in on the kanban drawn now. */
const columnOf = (p, card) => p.locator(`[data-card="${card}"]`).first().evaluate((e) => e.closest("[data-stage]")?.getAttribute("data-stage") ?? null);
/** Every card drawn on the kanban, with its column. */
const drawnCards = (p) => p.locator("[data-screen=sarim-kanban] [data-card]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-card"), stage: e.closest("[data-stage]")?.getAttribute("data-stage") ?? null, visible: e.getBoundingClientRect().width > 0 })));
/** The rows of the list, with their text. */
const rows = (p) => p.locator("[data-screen=sarim-list] [data-card-row]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-card-row"), text: e.innerText })));
/** The filter tokens set in the bar of a screen (the saved filters are a group of their own). */
const tokens = (p, screen) => p.locator(`[data-screen=${screen}] [role=search] [role=group]:not([aria-label="Filtri salvati"])`).count();

/** An address typed in the bar: the hash changes, the container answers a moved one with its new place. */
const goTo = (path) => async (p) => { await p.evaluate((to) => { location.hash = to; }, path); };
/** The row of SARIM in the sidebar, and its menu (right click or the ⋯ button). */
const orgRow = (p) => p.locator("nav [role=treeitem]").filter({ has: p.locator("button[aria-label='Menu di SARIM']") }).first();
const orgMenu = async (p, item, how = "button") => {
  if (how === "right") await orgRow(p).click({ button: "right" });
  else { await orgRow(p).hover(); await p.getByRole("button", { name: "Menu di SARIM" }).first().click(); }
  await p.locator("[role=menu] [role=menuitem]", { hasText: new RegExp(`^${item}`) }).first().click();
};
/** The person's menu at the bottom left. */
const userMenu = async (p, item, role = "menuitem") => {
  await p.click("[data-sidebar-identity]");
  await p.locator(`[role=menu] [role=${role}]`, { hasText: new RegExp(`^${item}`) }).first().click();
};
const isDark = (p) => p.evaluate(() => document.documentElement.classList.contains("dark"));

const STEPS = [
  /* «Da fare»: the list grouped by flow, a group folded and opened again. */
  {
    what: "chiudo il primo gruppo dell'elenco",
    before: async (p, memo) => { memo.flow = await p.locator("[data-screen=sarim-list] button[data-flow][aria-expanded=true]").first().getAttribute("data-flow"); },
    click: (p) => p.locator("[data-screen=sarim-list] button[data-flow][aria-expanded=true]").first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p, memo) => {
      const open = await p.locator(`[data-screen=sarim-list] button[data-flow="${memo.flow}"]`).getAttribute("aria-expanded");
      const left = await p.locator(`[data-flow-group="${memo.flow}"] [data-card-row]`).count();
      return open === "false" && left === 0 ? null : `il gruppo ${memo.flow} resta aperto (${left} righe)`;
    },
  },
  {
    what: "lo riapro",
    click: (p) => p.locator("[data-screen=sarim-list] button[data-flow][aria-expanded=false]").first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p, memo) => ((await p.locator(`[data-flow-group="${memo.flow}"] [data-card-row]`).count()) ? null : `il gruppo ${memo.flow} riaperto è vuoto`),
    shot: "da-fare-elenco",
  },

  /* One filter component: search that suggests, a suggestion as a token, a token built step by step. */
  {
    what: "scrivo «Roma» nella ricerca: i suggerimenti",
    keys: async (p) => {
      await p.locator("[data-screen=sarim-list] [role=search] [role=combobox]").first().click();
      await p.keyboard.type("Roma", { delay: video ? 110 : 0 });
    },
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => {
      const list = p.locator("[data-screen=sarim-list] [role=listbox]").first();
      const shown = await list.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
      if (!shown) return "nessun elenco di suggerimenti";
      const n = await list.locator("[role=option]").count();
      return n ? null : "elenco dei suggerimenti vuoto";
    },
    shot: "filtri-autocompletamento",
  },
  {
    what: "scelgo un suggerimento: diventa un filtro",
    before: async (p, memo) => { memo.rows = (await rows(p)).length; },
    click: (p) => p.locator("[data-screen=sarim-list] [role=listbox] [role=option]", { hasText: /Roma/ }).first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p, memo) => {
      const n = await tokens(p, "sarim-list");
      const now = (await rows(p)).length;
      if (!n) return "nessun filtro dopo la scelta";
      return now && now < memo.rows ? null : `righe ${memo.rows} prima, ${now} dopo`;
    },
  },
  {
    what: "lo tolgo con la ×",
    click: (p) => p.locator("[data-screen=sarim-list] [role=search] button[aria-label^='Togli il filtro']").first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => ((await tokens(p, "sarim-list")) ? "il filtro è rimasto" : null),
  },
  {
    what: "+ Filtro: Stato, è, Da verificare",
    keys: async (p) => {
      await p.locator("[data-screen=sarim-list] [role=search] button[aria-label='Aggiungi un filtro']").click();
      const dialog = p.locator("[role=dialog][aria-label='Aggiungi un filtro']").first();
      await dialog.locator("[role=option]", { hasText: /^Stato/ }).first().click();
      const op = dialog.locator("[role=listbox][aria-label=Condizione] [role=option]", { hasText: /^è$/ }).first();
      if (await op.isVisible().catch(() => false)) await op.click();
      await dialog.locator("[role=option]", { hasText: /^Da verificare/ }).first().click();
    },
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => {
      const list = await rows(p);
      if (!list.length) return "nessuna card Da verificare";
      const other = list.filter((r) => !/Da verificare/.test(r.text));
      return other.length ? `${other.length} righe non sono Da verificare (${other[0].id})` : null;
    },
    shot: "filtri-gettone",
  },
  {
    what: "il filtro salvato «Aspettano te»",
    click: (p) => p.locator("[data-screen=sarim-list] [role=search] [role=group][aria-label='Filtri salvati'] button", { hasText: /^Aspettano te/ }).first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => ((await p.locator("[data-screen=sarim-list] [role=group][aria-label='Filtri salvati'] button[aria-pressed=true]").count()) ? null : "il filtro salvato non risulta acceso"),
  },
  {
    what: "Azzera",
    click: (p) => p.locator("[data-screen=sarim-list] [role=search] button", { hasText: /^Azzera$/ }).first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => ((await tokens(p, "sarim-list")) ? "restano filtri dopo Azzera" : null),
  },

  /* Kanban second, «Per stato», a cell that filters, a card in the hands of an agent. */
  { what: "la vista Kanban", click: view("sarim-list", "kanban"), screen: "sarim-kanban", hash: "#/da-fare/kanban", shot: "da-fare-kanban" },
  { what: "la vista Per stato", click: view("sarim-kanban", "stages"), screen: "sarim-stages", hash: "#/da-fare/per-stato", shot: "da-fare-per-stato" },
  {
    what: "un clic su Segnalazioni · In lavorazione: l'elenco con due filtri",
    click: (p) => p.locator("[data-screen=sarim-stages] button[data-flow-cell=sarim-segnalazioni][data-stage=lavorazione]").first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => {
      const n = await tokens(p, "sarim-list");
      const list = await rows(p);
      if (n < 2) return `filtri: ${n}, attesi flusso e stato`;
      const other = list.filter((r) => !/^SG-/.test(r.id));
      return list.length && !other.length ? null : `${list.length} righe, ${other.length} non sono segnalazioni`;
    },
  },
  {
    what: "gli stessi filtri sulla Kanban",
    click: view("sarim-list", "kanban"),
    screen: "sarim-kanban", hash: "#/da-fare/kanban",
    check: async (p) => {
      const cards = (await drawnCards(p)).filter((c) => c.visible);
      const wrong = cards.filter((c) => c.stage !== "lavorazione" || !/^SG-/.test(c.id));
      if (!cards.length) return "nessuna card visibile";
      return wrong.length ? `${wrong.length} card fuori dai filtri (${wrong[0].id} in ${wrong[0].stage})` : null;
    },
  },
  {
    what: "una card in lavorazione da un agente",
    click: (p) => p.locator("[data-screen=sarim-kanban] [data-stage=lavorazione] [data-card=SG-4128]").first(),
    screen: "sarim-card", hash: "#/da-fare/card/SG-4128",
    check: async (p) => ((await p.locator("[data-screen=sarim-card] [data-worker=agent]").count()) ? null : "la card non dice che la lavora un agente"),
    shot: "da-fare-card",
  },
  { what: "il suo originale, grande", click: (p) => p.locator("[data-screen=sarim-card]").getByRole("button", { name: /^Apri grande/ }).first(), screen: "sarim-card-original", prefix: "#/da-fare/card/SG-4128/originale/" },
  { what: "indietro alla card", back: true, screen: "sarim-card", hash: "#/da-fare/card/SG-4128" },
  {
    what: "«Prendo io»: ora la lavora una persona",
    click: (p) => p.locator("[data-screen=sarim-card]").getByRole("button", { name: /^Prendo io/ }).first(),
    screen: "sarim-card", hash: "#/da-fare/card/SG-4128",
    check: async (p) => ((await p.locator("[data-screen=sarim-card] [data-worker=person]").count()) ? null : "la card risulta ancora in mano all'agente"),
  },

  /* «Conoscenza»: Documenti, Contratti, Dati, Regole, each with its address. */
  { what: "Conoscenza, dalla barra laterale", click: nav("Conoscenza"), screen: "sarim-knowledge", hash: "#/conoscenza/documenti", shot: "conoscenza-documenti" },
  { what: "Conoscenza › Regole", click: sub("Sezioni di Conoscenza", "Regole"), screen: "sarim-rules", hash: "#/conoscenza/regole", shot: "conoscenza-regole" },
  { what: "Conoscenza › Dati", click: sub("Sezioni di Conoscenza", "Dati"), screen: "sarim-data", hash: "#/conoscenza/dati", shot: "conoscenza-dati" },
  { what: "Conoscenza › Contratti", click: sub("Sezioni di Conoscenza", "Contratti"), screen: "sarim-contracts", hash: "#/conoscenza/contratti", shot: "conoscenza-contratti" },

  /* A contract: compare, approve, sign; its card reaches «Fatto». */
  { what: "il contratto di Castellabate", click: (p) => p.locator("[data-screen=sarim-contracts] [data-contract=c-castellabate]").first(), screen: "sarim-contract", hash: "#/conoscenza/contratti/c-castellabate", shot: "contratto" },
  {
    what: "confronto delle versioni, parola per parola",
    click: (p) => p.locator("[data-screen=sarim-contract]").getByRole("button", { name: /^Confronta/ }).first(),
    screen: "sarim-compare", prefix: "#/conoscenza/contratti/c-castellabate/confronto/",
    check: async (p) => {
      const scope = p.locator("[data-screen=sarim-compare]");
      const [added, removed, changed] = await Promise.all([scope.locator("[data-diff=add]").count(), scope.locator("[data-diff=del]").count(), scope.locator("[data-changed=true]").count()]);
      if (!changed) return "nessuna clausola segnata come cambiata";
      return added && removed ? null : `differenze: ${added} aggiunte, ${removed} tolte`;
    },
  },
  { what: "indietro al contratto", back: true, screen: "sarim-contract", hash: "#/conoscenza/contratti/c-castellabate" },
  {
    what: "la pagina Firme del contratto, con il livello di ogni team su Contratti",
    click: sub("Pagine del contratto", "Firme"),
    screen: "sarim-signatures", hash: "#/conoscenza/contratti/c-castellabate/firme",
    check: async (p) => {
      /* The same levels as Squadra › Permessi: the direction manages, the board of auditors only sees. */
      const level = (team) => p.locator(`[data-screen=sarim-signatures] tr[data-team=${team}]`).first().innerText().then((t) => (/Gestisce|Lavora|Vede|Niente/.exec(t) ?? [""])[0]);
      const [direction, auditors] = [await level("direzione"), await level("sindaci")];
      return direction === "Gestisce" && auditors === "Vede" ? null : `livelli su Contratti: Direzione «${direction}», Collegio sindacale «${auditors}»`;
    },
  },
  {
    what: "la direzione approva la variante: tocca alla firma",
    click: (p) => p.locator("[data-screen=sarim-signatures]").getByRole("button", { name: /^Approva$/ }).first(),
    screen: "sarim-signatures", hash: "#/conoscenza/contratti/c-castellabate/firme",
    check: async (p) => {
      const sign = await p.locator("[data-screen=sarim-signatures]").getByRole("button", { name: /^Firma digitalmente/ }).first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      return sign ? null : "dopo l'approvazione non tocca alla firma";
    },
  },
  {
    what: "firma digitale: ricevuta",
    click: (p) => p.locator("[data-screen=sarim-signatures]").getByRole("button", { name: /^Firma digitalmente/ }).first(),
    screen: "sarim-signatures", hash: "#/conoscenza/contratti/c-castellabate/firme",
    check: async (p) => {
      const receipt = await p.getByText(/repertorio/i).first().waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
      return receipt ? null : "nessuna ricevuta con il numero di repertorio";
    },
    shot: "contratto-firmato",
  },
  {
    what: "il vecchio indirizzo delle varianti: la Kanban col flusso, CT-V07 aspetta la controfirma, non è in Fatto",
    keys: async (p) => { await p.keyboard.press("Escape"); await goTo("/da-fare/contratti")(p); },
    screen: "sarim-kanban", hash: "#/da-fare/kanban",
    check: async (p) => {
      const stage = await columnOf(p, "CT-V07");
      if (!stage) return "CT-V07 non è sulla kanban";
      /* After the signature one step is left, the countersignature of the Comune: the card stays open until it is done. */
      return stage === "lavorazione" ? null : `CT-V07 è in ${stage}: dopo la firma resta aperta, in lavorazione, fino alla controfirma`;
    },
  },

  /* The other sections of the sidebar. */
  { what: "Flussi, dalla barra laterale", click: nav("Flussi"), screen: "sarim-flows", hash: "#/flussi", shot: "flussi" },
  { what: "il flusso delle varianti", click: (p) => p.locator("[data-screen=sarim-flows]").getByText(/^Variante di contratto/).first(), screen: "sarim-flow", hash: "#/flussi/sarim-varianti" },
  {
    what: "«Apri in Da fare»: l'elenco con il filtro del flusso",
    click: (p) => p.locator("[data-screen=sarim-flow]").getByRole("button", { name: /^Apri in Da fare/ }).first(),
    screen: "sarim-list", hash: "#/da-fare",
    check: async (p) => {
      const list = await rows(p);
      const n = await tokens(p, "sarim-list");
      return n === 1 && list.length && list.every((r) => /^CT-/.test(r.id)) ? null : `${n} filtri, ${list.length} righe (${list.map((r) => r.id).slice(0, 3).join(", ")})`;
    },
  },
  { what: "Programmi, dalla barra laterale", click: nav("Programmi"), screen: "sarim-programs", hash: "#/programmi", shot: "programmi" },

  /* The menu of SARIM: right click and the ⋯ button. */
  {
    what: "tasto destro su SARIM: il suo menu",
    keys: (p) => orgRow(p).click({ button: "right" }),
    expandOnly: true,
    check: async (p) => ((await p.locator("[role=menu] [role=menuitem]", { hasText: /^Impostazioni/ }).first().isVisible()) ? null : "il menu di SARIM non si apre"),
    shot: "menu-sarim",
  },
  {
    what: "› Impostazioni",
    click: (p) => p.locator("[role=menu] [role=menuitem]", { hasText: /^Impostazioni/ }).first(),
    screen: "sarim-settings", hash: "#/impostazioni/organizzazione", shot: "impostazioni",
  },
  { what: "Impostazioni › Agenti", click: sub("Impostazioni", "Agenti"), screen: "sarim-settings", hash: "#/impostazioni/agenti" },
  {
    what: "⋯ su SARIM › Squadra: i team, ognuno col responsabile",
    keys: (p) => orgMenu(p, "Squadra"),
    screen: "sarim-team", hash: "#/squadra",
    check: async (p) => {
      const teams = await p.locator("[data-screen=sarim-team] section[data-team]").count();
      const leads = await p.locator("[data-screen=sarim-team] [data-lead]").count();
      return teams >= 9 && leads >= 8 ? null : `${teams} team, ${leads} responsabili`;
    },
    shot: "squadra-team",
  },
  { what: "il team Gare e Legale", keys: goTo("/squadra/team/legale"), screen: "sarim-team-of", hash: "#/squadra/team/legale" },
  {
    what: "⋯ su SARIM › Permessi: Flotta passa a Vede su Contratti",
    keys: async (p) => {
      await orgMenu(p, "Permessi");
      await p.waitForSelector("[data-screen=sarim-permissions]", { timeout: 6000 });
      await p.locator("[data-screen=sarim-permissions] [role=cell][data-team=flotta][data-row='section:contracts'] button").first().click();
      await p.locator("[role=listbox] [role=option]", { hasText: /^Vede/ }).first().click();
    },
    screen: "sarim-permissions", hash: "#/squadra/permessi",
    check: async (p) => {
      const v = await p.locator("[data-screen=sarim-permissions] [role=cell][data-team=flotta][data-row='section:contracts']").first().getAttribute("data-value");
      return v === "view" ? null : `la cella dice ${v}`;
    },
    shot: "permessi-team",
  },
  {
    what: "il cambio è nel Registro",
    keys: (p) => orgMenu(p, "Registro"),
    screen: "sarim-settings", hash: "#/impostazioni/registro",
    check: async (p) => ((await p.locator("[data-screen=sarim-settings]").getByText(/Ha dato al team Flotta/).count()) ? null : "nel registro non c'è il cambio di Flotta"),
  },

  /* The person's menu: preferences, theme, enter as, sign out. */
  {
    what: "il menu della persona, in basso a sinistra",
    keys: (p) => p.click("[data-sidebar-identity]"),
    expandOnly: true,
    check: async (p) => ((await p.locator("[role=menu] [role=menuitem]", { hasText: /^Aspetto/ }).first().isVisible()) ? null : "il menu della persona non si apre"),
    shot: "menu-persona",
  },
  {
    what: "› Aspetto",
    click: (p) => p.locator("[role=menu] [role=menuitem]", { hasText: /^Aspetto/ }).first(),
    screen: "sarim-settings", hash: "#/preferenze/aspetto", shot: "preferenze-aspetto",
  },
  {
    what: "tema scuro dal menu della persona",
    keys: (p) => userMenu(p, "Scuro", "menuitemradio"),
    screen: "sarim-settings", hash: "#/preferenze/aspetto",
    check: async (p) => ((await isDark(p)) ? null : "il tema non è diventato scuro"),
    shot: "tema-scuro",
  },
  {
    what: "di nuovo chiaro",
    keys: (p) => userMenu(p, "Chiaro", "menuitemradio"),
    screen: "sarim-settings", hash: "#/preferenze/aspetto",
    check: async (p) => ((await isDark(p)) ? "il tema è rimasto scuro" : null),
  },

  /* Search and a notification. */
  {
    what: "la ricerca (Cmd+K): «Castellabate», Invio apre il primo risultato",
    keys: async (p) => { await p.keyboard.press("Meta+k"); await p.keyboard.type("Castellabate", { delay: video ? 90 : 0 }); await p.waitForSelector("[data-global-search] [role=option]"); await p.waitForTimeout(250); await p.keyboard.press("Enter"); },
    prefix: "#/",
    /* The palette ranks by kind (cards first): the first result is a card, a clause or a contract about Castellabate, so the place that opens must say so. */
    check: async (p) => {
      await p.waitForFunction(() => !document.querySelector("[data-global-search]"), undefined, { timeout: 4000 }).catch(() => {});
      if (await p.locator("[data-global-search]").count()) return "la ricerca non si chiude con Invio";
      const about = await p.evaluate(() => /castellabate/i.test(decodeURIComponent(location.hash)) || /castellabate/i.test(document.querySelector("[data-screen]")?.textContent ?? ""));
      return about ? null : "il primo risultato della ricerca non parla di Castellabate";
    },
  },
  {
    what: "una notifica: l'obbligo in ritardo con AMA",
    keys: async (p) => { await p.click("button[aria-label^='Notifiche']"); await p.waitForTimeout(250); await p.locator("[role=dialog] button", { hasText: "AMA S.p.A." }).first().click(); },
    screen: "sarim-contract", hash: "#/conoscenza/contratti/c-smart-leaf/clausola/art-8",
  },

  /* Old addresses land on the new places. */
  { what: "vecchio /oggi", keys: goTo("/oggi"), screen: "sarim-list", hash: "#/da-fare" },
  {
    what: "vecchio /da-fare/segnalazioni: la Kanban col flusso",
    keys: goTo("/da-fare/segnalazioni"),
    screen: "sarim-kanban", hash: "#/da-fare/kanban",
    check: async (p) => {
      const cards = (await drawnCards(p)).filter((c) => c.visible);
      return cards.length && cards.every((c) => /^SG-/.test(c.id)) ? null : `${cards.length} card, non tutte segnalazioni`;
    },
  },
  { what: "vecchio /contratti", keys: goTo("/contratti"), screen: "sarim-contracts", hash: "#/conoscenza/contratti" },
  { what: "vecchio /dati/scadenzario", keys: goTo("/dati/scadenzario"), screen: "sarim-deadlines", hash: "#/conoscenza/dati/scadenzario" },
  { what: "vecchio /conoscenza", keys: goTo("/conoscenza"), screen: "sarim-knowledge", hash: "#/conoscenza/documenti" },
  { what: "vecchio /impostazioni/aspetto", keys: goTo("/impostazioni/aspetto"), screen: "sarim-settings", hash: "#/preferenze/aspetto" },

  /* Enter as the auditors: they read, they do not approve. */
  {
    what: "entra come Collegio sindacale: legge, non approva",
    before: async (p, memo) => { memo.who = await p.locator("[data-sidebar-identity]").innerText(); },
    keys: async (p) => {
      await userMenu(p, "Entra come");
      await p.locator("[role=menu] [role=menuitemradio]", { hasText: "Collegio sindacale" }).first().click();
      await goTo("/conoscenza/contratti/c-castellabate/firme")(p);
    },
    screen: "sarim-signatures", hash: "#/conoscenza/contratti/c-castellabate/firme",
    check: async (p, memo) => {
      const who = await p.locator("[data-sidebar-identity]").innerText();
      if (who === memo.who) return `in basso c'è ancora «${who.replace(/\s+/g, " ")}»`;
      /* A button turned off with a reason is `aria-disabled`, not `disabled` (it keeps its tooltip): both count as off. */
      const enabled = await p.locator("[data-screen=sarim-signatures] button:not([disabled]):not([aria-disabled=true])", { hasText: /^(Approva|Firma digitalmente|Invia alla controparte)$/ }).count();
      return enabled ? "il Collegio sindacale può ancora approvare o firmare" : null;
    },
    shot: "entra-come-sindaci",
  },

  /* Sign out and back in. */
  {
    what: "Esci, con conferma",
    keys: async (p) => {
      await userMenu(p, "Esci");
      await p.locator("[role=dialog] button, [role=alertdialog] button", { hasText: /^Esci$/ }).first().click();
    },
    screen: "sarim-signed-out", hash: "#/uscito",
    /* Nothing of the signed-in chrome is left around the page: no sidebar, no tab strip, no button but «Rientra» (inside the page). */
    check: async (p) => {
      const left = await p.evaluate(() => ({
        sidebar: document.querySelectorAll("[data-sidebar-identity], nav[aria-label=Topics]").length,
        tabs: document.querySelectorAll("[role=tablist]").length,
        outside: [...document.querySelectorAll("button")].filter((b) => !b.closest("[data-screen]")).map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()),
      }));
      if (left.sidebar) return "da uscito la barra laterale è ancora lì";
      if (left.tabs) return "da uscito la barra delle linguette è ancora lì";
      return left.outside.length ? `da uscito restano pulsanti fuori dalla pagina: ${left.outside.join(", ")}` : null;
    },
    shot: "sessione-chiusa",
  },
  {
    what: "Rientra",
    click: (p) => p.locator("[data-screen=sarim-signed-out]").getByRole("button", { name: /^Rientra/ }).first(),
    screen: "sarim-list", hash: "#/da-fare",
    /* The tab of the page after signing out does not stay behind. */
    check: async (p) => ((await p.locator("[role=tab]", { hasText: /Sessione chiusa/ }).count()) ? "la linguetta «Sessione chiusa» è rimasta" : null),
  },
];

await runWalk({
  script: "ui-sarim-walk",
  entry: "sarim",
  start: "/da-fare",
  startScreen: "sarim-list",
  startWhat: "Da fare, in Elenco",
  steps: STEPS,
  done: (n) => `ui-sarim-walk: ok, ${n} passi in tutte le sezioni di SARIM, zero errori`,
});
