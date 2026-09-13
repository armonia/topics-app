# Proposal: browser-della-topic

> Bozza del 2026-09-13, scritta sulle scelte consigliate del prototipo
> (<https://claude.ai/code/artifact/615183e6-5ff9-499f-bedb-3ba3374b6b9b>).
> Le cinque decisioni aperte sono in fondo al design, ognuna con la risposta
> presa qui: se ne cambi una, cambia il paragrafo indicato e basta.

## Why

Aprire un sito da una topic oggi ha un solo esito: una pane nel layout. Che la
pagina serva all'utente o solo all'agente, lo split si prende metà dello
schermo, sposta quello che c'era e resta lì finché qualcuno lo chiude. Il
13/09, sulla chat `ae217a6b`, sono emersi quattro sintomi della stessa forma:

1. **La chrome della tab è divisa in tre.** Indirizzo nella tab, comandi in
   un menu a tendina (`browser-tab-menu-panel`, `BrowserTabChrome.tsx:238`),
   modifica dell'indirizzo in un secondo portale (`browser-address-dropdown`),
   e la riga `BrowserToolbar` ancora montata nei tre rami di
   `RemoteBrowserPanel` (`:577`, `:1109`, `:1200`), accesa da console e
   download. È il disegno che `tab-is-the-chrome` voleva cancellare e che non è
   mai partito (0/16).
2. **Pillole DOM sopra la pagina.** Nel ramo streaming `BrowserPaneChip` mette
   sopra il contenuto il commutatore di motore «Nativo» (che è Playwright, non
   la WKWebView: il nome inganna), il commutatore DOM/Video e lo stato di
   connessione (`RemoteBrowserPanel.tsx:1237-1288`). Su desktop compaiono
   appena la pane passa in modalità condivisa.
3. **La pagina «da telefono».** In condivisione il viewport è uno per contesto e
   vince l'ultimo `resize` (`useRemoteBrowser.ts:399-429`,
   `browser-service.ts:1752`): un secondo dispositivo stretto rimpicciolisce la
   pagina per tutti, e `DomCoBrowse` la adatta in alto a sinistra su bianco
   (`DomCoBrowse.tsx:138-156`) ignorando gli eventi ViewportResize di rrweb.
4. **Nessun posto leggero per il browser.** Non esiste una finestra flottante,
   un pannello agganciato alla topic o un browser piccolo in chat
   (`agent-inline-browser`, 0/25, prevedeva un fotogramma fermo in un messaggio).

## What Changes

**Il browser di una topic è un oggetto solo, con tre stati:**

- **Minimizzato.** Una finestra flottante sopra la chat, trascinabile, con in
  alto le schede della topic e la pagina attiva viva. La chat resta larga e ci
  scorre sotto. La posizione resta per topic.
- **Espanso.** La stessa finestra agganciata al lato destro della topic; la chat
  le cede lo spazio. Larghezza regolabile dal bordo sinistro, ricordata per
  topic.
- **Come tab.** La scheda diventa una pane vera nel layout, con la stessa
  sessione (pagina, cronologia, agente che la guida). Dal suo menu «Riporta
  nella chat» la rimette nella finestra.

**La tab è la chrome.** Un clic sulla tab attiva o sui tre puntini apre la tab
in un foglio che contiene l'indirizzo già selezionato, la navigazione, i
suggerimenti e tutti i comandi disposti in chiaro: niente menu a tendina, niente
portale separato per l'indirizzo, niente `BrowserToolbar`. Mentre il foglio è
aperto la pagina sotto è un fermo immagine; si chiude con Invio, Esc o un clic
fuori.

**Niente sopra la pagina.** Le pillole DOM spariscono: il tipo di motore e lo
stato di condivisione diventano un'icona dentro la tab, i commutatori passano
nella sezione «Sessione» del foglio.

**Un viewport conteso ha un arbitro.** In condivisione dimensiona la pagina chi
la sta usando; chi guarda da uno schermo diverso la vede in scala e centrata.

**Da dove arriva un sito aperto senza chiedere.** Link della chat e aperture
dell'agente arrivano nella finestra della topic, minimizzata, senza toccare il
layout. Se la finestra è espansa arrivano lì, se la scheda è già una tab
naviga quella.

## Non-Goals

- **Mobile sotto 768 px.** Lì la finestra non esiste: le schede si aprono come
  tab, come oggi.
- **Ridimensionare la finestra minimizzata.** Ha una dimensione predefinita; si
  sposta, non si allarga. Chi vuole più spazio la espande.
- **Il contesto headless dell'agente** (`surface: "inline"` di
  `agent-inline-browser`, fasi 1-3 e 5, 7). Resta in quella change. Questa
  sostituisce solo la sua superficie per l'umano (fase 4, card in chat, e fase
  6, righe in sidebar): l'oggetto da guardare è la finestra.
- **Pane browser aperte fuori da una topic** (finestre di progetto, terminale,
  task). Il loro posizionamento (`LINK-TAB-02` per quelle origini,
  `useProjectBrowserPanes`, `taskBrowserLayout`) non cambia.

## Impact

- `client/src/components/Browser/`: nuovo `TopicBrowserWindow` (i due stati
  flottante e agganciato), `BrowserTabChrome` riceve il foglio,
  `BrowserToolbar.tsx` e `browser-tab-menu` si cancellano, `BrowserPaneChip`
  esce da `RemoteBrowserPanel`, `useBrowserChromeBridge` perde
  `showChrome`/`revealed`.
- `client/src/components/Browser/NativeBrowserPlaceholder.tsx` e `client/src/hooks/useTauriBrowser.ts`:
  la vista nativa segue un elemento `position: fixed` che
  si sposta senza cambiare dimensione.
- `client/src/state/`: nuovo stato puro della finestra per topic (stato,
  posizione, larghezza, schede), persistito in ui-state con lo stesso schema LWW
  di `taskBrowserTabs`. Non entra in `pane-store-v2` finché una scheda non
  diventa tab.
- `client/src/components/Layout/ChatPanel.tsx`: la chat cede spazio in stato
  espanso.
- Instradamento delle aperture da topic (`usePanelLifecycle.ts:817`,
  `usePaneOrdering.ts:520-660`, porta unica dei link).
- Condivisione: `useRemoteBrowser.ts` (chi manda `resize`), `server.ts:4090`,
  `browser-service.ts:1752`, `DomCoBrowse.tsx` (ViewportResize).
- Spec: `remote-browser` ADDED `TOPIC-BROWSER-01..05`, MODIFIED `LINK-TAB-02`.
- Change assorbite: **`tab-is-the-chrome`** per intero (si archivia senza
  implementarla quando questa è approvata); **`agent-inline-browser`** fasi 4 e
  6. `dropdown-unification` eredita un menu in meno.
- Nessuna migration.
