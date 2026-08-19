# Il browser di Topics vs i browser veri: le aspettative utente

> Passo 3 della serie «Browser: cosa ci manca davvero» (card `a68393f4`, questo passo `d336efa7`).
> Confronto con Arc, Chrome, Safari e Dia sull'asse delle aspettative di chi usa la pane,
> non su una checklist di feature. Alimenta il passo 4 (la mappa con le 3-5 cose che valgono la pena).

## 1. Premessa e metodo

Il browser di Topics non è un browser primario: è una pane dentro un topic, co-pilotata
da umano e agente. La domanda giusta quindi non è «ha tutte le feature di Chrome?» ma:
**quali aspettative porta con sé chi apre una pagina web, e quali di queste valgono nel
contesto Topics** (dev server, login a servizi, lettura di documentazione, co-browsing
con l'agente).

Le aspettative sono divise in tre fasce:

| Fascia | Definizione | Esempio |
|---|---|---|
| **T0: invisibili** | Si notano solo quando MANCANO. Se una fallisce, l'utente non pensa «manca una feature», pensa «questo browser è rotto» e apre Chrome. | Il back che torna davvero indietro; un download che arriva. |
| **T1: comfort** | Differenziano un browser vero da una webview incorniciata. La loro assenza si perdona, ma erode la fiducia a ogni uso. | Swipe per tornare indietro; suggerimenti mentre digiti. |
| **T2: distintive** | Quello che ognuno dei quattro fa di suo. Non vanno copiate: vanno lette come segnale di dove si è spostata l'aspettativa. | Lo «chiedi ai tuoi tab» di Dia. |

## 2. Dove sta Topics oggi (misurato nel codice, non a memoria)

Stato al momento della scrittura, con il punto del codice che lo prova:

| Capacità | Stato | Dove |
|---|---|---|
| Barra URL unica (URL + ricerca, upgrade https-first) | ✅ | `client/src/lib/browserNavUrl.ts` |
| Back/forward con stato reale + menu cronologia | ✅ | `BrowserToolbar.tsx` (`browser-nav-history-menu`) |
| Barra di avanzamento caricamento | ✅ | `BrowserToolbar.tsx` (`browser-toolbar-progress`) |
| Trova nella pagina con indice n/m | ✅ | `client/src/components/Browser/findInPageModel.ts` |
| Download funzionanti, con percentuale, in un menu dell'header | ✅ | `DownloadsMenu.tsx`, `downloadsModel.ts` |
| Favicon con placeholder (globo/lettera) | ✅ | `faviconPlaceholder.ts` |
| Menu contestuale (nav, copia, link, immagine, ispeziona) | ✅ | `PaneContextMenu.tsx` |
| Zoom | ✅ | `BrowserToolbar.tsx` (`onZoom`) |
| Errori di navigazione leggibili | ✅ | `navErrorMessage.ts` |
| Console completa (timestamp, livelli, filtro, copia) | ✅ | `consoleLogModel.ts`, `BrowserDevControls.tsx` |
| Sessioni che restano: cassetto cookie unico nativa↔condivisa, isolamento per pane | ✅ | card `78332f1a`, `5e491ca6` |
| «Dimentica questo sito» che elenca prima di cancellare | ✅ | `browserForgetSite.ts`, card `88254819` |
| Import cookie da Chrome / Arc / Dia / Chromium | ✅ | `server/integrations/chrome-cookies.ts` |
| Engine switch: WKWebView nativa ↔ Chromium sidecar (via estensioni) | ✅ | card `d9b635b6` |
| Co-browsing e guida dall'agente (observe/act/console/network/screenshot) | ✅ | oltre ogni browser reale |
| Nuova scheda utile (frecency) | 🟡 in corso | card `3bf61316` (modello frecency landato) |
| `window.open` / `target=_blank` | ⚠️ naviga la stessa pane, l'opener è nullo | `lib.rs` `on_new_window` (limite accettato esplicitamente) |
| Prompt permessi (camera/mic/geolocalizzazione/notifiche) | ❌ fallisce in silenzio | nessun handler |
| Autofill password / passkey | ❌ | mitigato solo per gli agenti (`browser_save_state`) |
| Suggerimenti nell'omnibox mentre digiti | ❌ | la frecency oggi alimenta solo la nuova scheda |
| Gesti trackpad (swipe back/forward, pinch) | ❌ | `allowsBackForwardNavigationGestures` mai attivato |
| Adblock / anti-tracker | ❌ | nessuna `WKContentRuleList` |
| Reader mode, traduzione, PiP, stampa/salva PDF | ❌ | assenti |

## 3. La matrice delle aspettative

Legenda: ✅ c'è, ⚠️ parziale, ❌ manca, ∅ non applicabile al contesto.

| Aspettativa | Fascia | Chrome | Safari | Arc | Dia | Topics |
|---|---|---|---|---|---|---|
| Barra unica URL+ricerca | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Suggerimenti da cronologia mentre digiti | T0 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Back/forward affidabili + cronologia | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Trova nella pagina | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Download visibili e affidabili | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Login che restano tra sessioni | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Popup OAuth (`window.open` + opener/postMessage) | T0 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Prompt permessi (cam/mic/geo/notifiche) | T0 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Autofill password/passkey | T0 | ✅ | ✅ (Keychain) | ✅ | ✅ | ❌ |
| PDF con viewer decente | T0 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Errori di rete leggibili | T0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zoom (anche pinch) | T1 | ✅ | ✅ | ✅ | ✅ | ⚠️ solo bottoni |
| Swipe back/forward | T1 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Nuova scheda utile (siti frequenti) | T1 | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Adblock/anti-tracker di serie | T1 | ❌ (store) | ⚠️ (ITP) | ✅ | ✅ | ❌ |
| Reader mode | T1 | ⚠️ | ✅ | ✅ | ⚠️ | ❌ |
| Traduzione pagina | T1 | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| PiP video | T1 | ✅ | ✅ | ✅ (auto) | ✅ | ❌ |
| Stampa / salva PDF | T1 | ✅ | ✅ | ✅ | ✅ | ❌ |
| DevTools completi | T1 | ✅ | ✅ | ✅ | ✅ | ⚠️ console sì, inspector nativo |
| Estensioni | T2 | ✅ | ⚠️ | ✅ | ✅ | ∅ (mitigato dal sidecar Chromium) |
| Profili / spazi | T2 | ✅ | ✅ | ✅ | ✅ | ∅ (progetti, org, incognito sono di Topics) |
| Sync cross-device | T2 | ✅ | ✅ | ✅ | ✅ | ∅ (il server di Topics È lo stato) |
| Organizzazione tab come workspace | T2 | ⚠️ gruppi | ⚠️ gruppi | ✅ (tesi) | ✅ | ✅ (tesi identica: topic/gruppi/pinnate) |
| AI accanto alla pagina, per l'utente | T2 | ⚠️ Gemini | ⚠️ | ❌ | ✅ (tesi) | ⚠️ c'è l'agente, manca il gesto |
| AI che GUIDA il browser | T2 | ❌ | ❌ | ❌ | ⚠️ skill | ✅ unico |
| Screenshot / clip della pagina | extra | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |

Lettura della matrice: **Topics è già sopra la linea su quasi tutta la T0 «meccanica»**
(nav, find, download, sessioni, errori) grazie al lavoro delle card citate in §2. I buchi
T0 rimasti sono concentrati in un punto solo: **il momento del login e dei permessi**
(popup con opener nullo, nessun prompt permessi, nessun autofill). È esattamente il
momento in cui oggi un utente abbandona la pane e apre Chrome, e ogni abbandono insegna
a non riprovare.

## 4. Cosa insegna ciascuno dei quattro

### Chrome: la baseline e la memoria muscolare
Chrome non insegna feature: fissa il default mentale. L'utente non confronta Topics con
la spec del web, lo confronta con la propria memoria muscolare di Chrome: ⌘L va alla
barra, ⌘F trova, il popup OAuth si apre e si chiude da solo, il PDF si legge inline.
La lezione è di parità, non di innovazione: **ogni divergenza dalla meccanica di Chrome
va o colmata o dichiarata**, mai lasciata fallire in silenzio (il caso dei permessi).

### Safari: l'integrazione OS, e il motore che già usiamo
La pane nativa di Topics È WebKit, lo stesso motore di Safari: l'efficienza (RAM,
batteria) è già in casa ed è un vantaggio competitivo reale rispetto a ogni concorrente
Electron/Chromium. Quello che Safari aggiunge sopra il motore e Topics no: i gesti
(swipe back/forward è una property della WKWebView, `allowsBackForwardNavigationGestures`),
il Keychain/passkey, il reader. La lezione: **stiamo pagando il prezzo del motore nativo
senza incassarne tutti i dividendi di piattaforma**.

### Arc: il chrome del browser come workspace (una tesi che Topics ha già)
Arc ha dimostrato che la cornice del browser può essere il workspace: spaces, sidebar,
command bar, split view, auto-archivio delle tab stantie, Little Arc per i link esterni.
Topics ha la stessa tesi, realizzata a livello app: spaces≈progetti/topic, command
bar≈⌘K, split view≈gruppi di pane, Little Arc≈la pane effimera aperta dall'agente.
Due note: (a) Arc è oggi in manutenzione, il vendor ha spostato la scommessa su Dia,
segno che il «browser-workspace» da solo non bastava come prodotto, ma come UX resta il
riferimento; (b) l'unica idea di Arc non ancora coperta è **l'auto-archivio**: le pane
browser di Topics si accumulano finché qualcuno le chiude.

### Dia: l'AI accanto alla pagina, PER L'UTENTE
Dia (stesso vendor di Arc) fissa l'aspettativa nuova: chatti coi tuoi tab, sintesi
multi-tab, memoria personale, skill, Morning Brief, connettori (GSuite, Slack, Notion),
adblock e anti-tracker di serie con i toggle in vista. Sul lato «AI che guida il
browser» Topics è già oltre Dia: l'agente naviga, compila, legge console e network,
salva login. Ma sul lato UTENTE Dia è avanti: in Dia «chiedi di questa pagina» è un
gesto a un click nella cornice, in Topics è un giro (aprire la chat, formulare la
domanda, sperare che l'agente guardi la pane giusta). La lezione: **il plumbing c'è
tutto (`browser_get_text`, observe, screenshot), manca l'affordance umana**.

## 5. Aspettative pertinenti vs fuori scope

Il caso d'uso della pane è: dev server del progetto, login a servizi di lavoro, lettura
di documentazione, co-browsing col proprio agente. Da qui il taglio:

**Pertinenti** (l'utente le incontra DENTRO quel caso d'uso):
login-grade compat (popup, permessi, autofill), suggerimenti omnibox, nuova scheda,
gesti, adblock (le doc dei vendor sono piene di tracker e cookie banner), console/devtools,
PDF, screenshot, zoom.

**Fuori scope dichiarato** (aspettative da browser primario, non da pane di lavoro):
ecosistema estensioni (mitigato dall'engine switch sul sidecar Chromium quando serve
davvero), sync cross-device (lo stato vive nel server di Topics), casting, shopping/wallet,
profili consumer (Topics ha già progetti, organizzazioni e incognito come primitive sue).
Dichiararle fuori scope è parte della consegna: evita di rincorrere Chrome dove non
serve a nessuno dei nostri utenti.

## 6. I gap che pesano (input per il passo 4 della serie)

In ordine di danno per aspettativa tradita, non di costo:

1. **Compat da login** (T0): gestire `window.open` con un vero opener quando il flusso
   lo richiede (o almeno un popup modale figlio), prompt espliciti per i permessi,
   autofill/passkey. È l'unico punto dove oggi la pane «è rotta» agli occhi dell'utente.
2. **Omnibox che suggerisce** (T0/T1): la frecency c'è già per la nuova scheda
   (card `3bf61316`), va portata dentro la barra URL mentre si digita. Costo basso,
   percezione alta: è la feature che si usa a ogni singola navigazione.
3. **Content blocking** (T1): una `WKContentRuleList` con le liste standard. Arc e Dia
   l'hanno resa un'aspettativa di serie; su WebKit è un'API di piattaforma, non un motore
   da scrivere.
4. **«Chiedi alla pagina»** (T2, la nostra): un gesto a un click sulla toolbar che porta
   il contenuto del tab corrente alla chat del topic. È la risposta di Topics a Dia,
   con plumbing già esistente: è quasi solo UI.
5. **Dividendi WebKit** (T1): swipe back/forward e pinch zoom (property native),
   reader e PiP come stretch. Poche righe per sembrare «un browser vero» al tatto.

Auto-archivio delle pane stantie (lezione di Arc) resta candidato per la mappa del
passo 4, ma sotto i cinque sopra: tocca il workspace, non la pane.
