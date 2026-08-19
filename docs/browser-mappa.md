# Mappa del browser di Topics

Sintesi della serie «Browser: cosa ci manca davvero» (card padre `a68393f4`).
Misura del 19/08/2026, fatta sul codice, non sui README.

**Fonti.** `~/Downloads/browser-main` (Pippo, browser WebKit/SwiftUI nativo per
macOS 15+: 175 file Swift, 25.593 righe, 13 aree in `pippo/Features`), il codice
di Topics (`client/src/components/Browser/*`, `server/browser-*.ts`,
`desktop-tauri/src-tauri/src/lib.rs`), e la valutazione del 04/08 in
`docs/chrome-devtools-mcp-vs-topics-browser.md`.

## In tre righe

Il divario con un browser vero non è sul motore: è sull'**ingresso** e sulla
**memoria**. Topics apre benissimo una pagina che gli hai già dato, ma non ti
aiuta a trovarla, e domani non se la ricorda. Il lato agente, che ad agosto era
il buco (rete, dialoghi), nel frattempo si è chiuso: quel confronto oggi lo
vinciamo.

> **Una mappa sola.** Il 19/08 questa serie ne aveva prodotte DUE: questa e
> `browser-gap-map.md`, scritta dalla card padre mentre il suo passo 4 scriveva
> questa. Si contraddicevano sulle priorita' — una metteva per prime `target=_blank`
> e lo zoom nativo, l'altra le identita' salvate e il motore di ricerca — e una
> serie con due mappe che dicono cose diverse non e' una serie: e' il posto dove
> si smette di guardarla. Sono state fuse qui, e sotto le priorita' ci sono
> entrambe le liste, non una scelta fra le due.

## Il metro: due aspettative, non una

Si confondono sempre, e vanno tenute separate perche' il metro e' diverso.

| Superficie | Aspettativa | Chi la delude |
|---|---|---|
| **Pane browser** dentro un progetto o un task | «una scheda che funziona»: se il sito chiede la webcam deve chiederla, se premo zoom deve zoomare, se un link apre una scheda nuova deve aprirla | i buchi tecnici del motore |
| **Nuova scheda** (pane aperta senza URL) | «una pagina d'ingresso curata»: qualcosa da cui ripartire | il vuoto: oggi e' una pane bianca con il cursore messo nella barra |

Una pane che apre `about:blank` mette il fuoco nella barra dell'indirizzo
(`RemoteBrowserPanel.tsx`, effetto `urlBarAutoFocusedRef`) e non disegna nient'altro.
Pippo, al posto suo, disegna `HomeView`: sfondo sfocato, logo, una riga di testo e
il Launcher con i suggerimenti. Anche lui non ha i «siti piu' visitati»: la
differenza non e' la ricchezza, e' che una pagina c'e'.

## 1. Elenco spuntato: Pippo contro Topics

Legenda: **si'** = c'e' e regge il confronto, **meta'** = c'e' ma con un limite
che si vede all'uso, **no** = non c'e'.

### Navigazione e motore

| Funzione di Pippo | Topics | Nota |
|---|---|---|
| Motore WebKit nativo | si' | WKWebView via wry su macOS, WebView2 e WebKitGTK altrove |
| Barra indirizzo, avanti, indietro, ricarica | si' | `BrowserToolbar.tsx` |
| Cronologia della scheda (lista avanti/indietro, menu a pressione lunga) | si' | `browser_nav_entries` + `browser_go_to_index` |
| Pagina di errore di rete | si' | `navErrorMessage.ts` traduce i codici Cocoa, la strip offre «Riprova» e un secondo rigo di spiegazione. Qui Topics sta MEGLIO di Pippo: `StatusPageView` mostra il `localizedDescription` grezzo |
| Favicon | si' | letta dal DOM col fallback `/favicon.ico` (`browserPagePoll.ts`), segnaposto a monogramma quando manca (`faviconPlaceholder.ts`) |
| `target=_blank` e `window.open` | **no** | il gestore `on_new_window` in `lib.rs` NAVIGA LA STESSA PANE e nega la finestra. Un link «apri in una scheda nuova» dirotta la pagina che stavi leggendo |
| Zoom in / out / reset | meta' | fatto iniettando `document.body.style.zoom`. Non e' il page zoom: non scala gli elementi `fixed`, va riaffermato a ogni giro di poll, e su un layout rigido rompe la pagina |
| Trova nella pagina, con n/m | meta' | `window.find()` piu' un conteggio camminato a mano (`findInPageModel.ts`). Nessuna evidenziazione di tutti i risultati, nessun `_findString` nativo |
| Stampa | **no** | nessun percorso, ne' scorciatoia ne' comando |
| Dialoghi della pagina (`alert`, `confirm`, `prompt`) | **da misurare** | la sessione condivisa li chiude e li riporta (`browser-service.ts`, `lastDialog`); nella pane nativa non c'e' un nostro delegato. Prova da fare: una pagina che chiama `alert()` dentro una pane |

### Schede, finestre, spazi

| Funzione di Pippo | Topics | Nota |
|---|---|---|
| Schede, riordino, fissaggio | si' | ma sono le pane di Topics, non schede del browser: una pane = una pagina |
| Schede verticali, sidebar | si' | la sidebar di Topics fa lo stesso lavoro |
| Split view | si' | e in Topics vale per ogni tipo di pane, non solo per il web |
| Spaces / Containers (profili scelti dall'utente) | meta' | l'isolamento per `contextId` c'e' (data store separato, `browser_purge_data_store`), ma non e' un gesto dell'utente: non si sceglie «apri questo in un altro profilo» |
| Navigazione privata come gesto | **no** | tecnicamente possibile, non esposta |
| Ripristino della sessione | meta' | si ripristina l'URL della pane (`browserOriginStore.ts`), non la lista avanti/indietro ne' la posizione dello scorrimento |
| Launcher / cambio scheda al volo (⌘T con suggerimenti) | **no** | c'e' la palette dell'app, che pero' non cerca fra le schede web aperte |
| Anteprima del link al passaggio del mouse | **no** | non c'e' nemmeno la riga di stato in basso con la URL di destinazione |

### Dati dell'utente

| Funzione di Pippo | Topics | Nota |
|---|---|---|
| Cronologia globale, con titolo e data | **no** | esiste solo `useBrowserHistory`: 50 URL per topic in `localStorage`, stringhe nude, senza titolo, senza data, senza ricerca. Non e' una cronologia, e' un menu «recenti» |
| Preferiti / segnalibri | **no** | il fissaggio in Topics e' della pane, non dell'indirizzo |
| Download: elenco, avanzamento, apri, mostra nel Finder | si' | `downloadsModel.ts` + `DownloadsMenu.tsx`, con percentuale reale dal Rust |
| Download: annulla, riprendi, storico che sopravvive | **no** | la lista e' in memoria e si taglia a 20 voci; gli stati `cancelled`/`interrupted` esistono ma nessun comando li produce |
| Autofill password (portachiavi iCloud) | **no** | in Topics esiste solo una proposta OpenSpec di credential store |
| Importazione dati da un altro browser | **no** | e per Topics non ha molto senso |
| Motore di ricerca configurabile | **no** | Google e' cablato in `normalizeUrl` (`browserNavUrl.ts`). Pippo ne offre quindici, comprese le capsule verso i modelli |
| Suggerimenti mentre si scrive nella barra | meta' | c'e' un menu «Recent URLs» che pesca dallo storico locale; nessun completamento in linea, nessun suggerimento dal motore |

### Privacy e permessi

| Funzione di Pippo | Topics | Nota |
|---|---|---|
| Blocco contenuti (`WKContentRuleList`, cataloghi di filtri, aggiornamento liste) | **no** | tre servizi in Pippo: catalogo, compilazione, archivio degli artefatti |
| Difese anti tracciamento iniettate | **no** | `BrowserPrivacyService` in Pippo copre anche il ramo `permissions.query` |
| Permessi del sito (camera, microfono, posizione, notifiche) | **no** | Pippo ha il `requestMediaCapturePermissionFor`; Topics non ha nessun percorso: un sito che chiede la webcam fallisce in silenzio |
| Passkey | **no** | in nessuno dei due (roadmap di Pippo) |
| Notifiche web | **no** | in nessuno dei due (roadmap di Pippo) |
| Dimentica questo sito | **si', solo Topics** | `browser_forget_site` piu' il dialogo che elenca cosa cancella PRIMA di cancellarlo. Pippo non ce l'ha |

### Il resto

| Funzione di Pippo | Topics | Nota |
|---|---|---|
| DevTools | si' | ⌥⌘I, piu' una console a tendina con livelli e filtro (`consoleLogModel.ts`) |
| Menu contestuale nella pagina | si' | `PaneContextMenu.tsx` |
| Scorciatoie da tastiera | meta' | quelle del browser sono fisse (registro condiviso TS/Rust); Pippo le fa ridefinire |
| Tema e aspetto | si' | card `63c3332a` in review per lo sfondo coerente di scheda e toolbar |
| Picture in picture, controller media globale | **no** | |
| Registrarsi come browser di sistema | **no** | Topics registra l'apertura di file e cartelle, non il protocollo `http` |
| Estensioni | **no** | in nessuno dei due (beta nella roadmap di Pippo) |
| Aggiornamento dell'app | si' | a livello di app |
| Guida dell'agente: screenshot, eval, cookie, user agent, co-browse, upload | **si', solo Topics** | non esiste in nessun browser di consumo, ed e' il motivo per cui questo browser sta qui dentro |

## 2. Il taglio: cosa manca alla pane, cosa manca alla nuova scheda

**Alla pane** (aspettativa: una scheda che funziona) mancano cose tecniche, e
sono quasi tutte nel guscio Rust:

- `target=_blank` che dirotta la pagina corrente invece di aprire una scheda
- zoom e ricerca fatti iniettando JavaScript invece dei comandi nativi
- nessun percorso per i permessi del sito
- niente stampa
- dialoghi della pagina non verificati

**Alla nuova scheda** (aspettativa: una pagina d'ingresso curata) manca tutto:
oggi e' bianca. E il pezzo che la rende possibile non e' grafico, e' il dato:
senza una cronologia vera non c'e' niente da mettere in quella pagina. La card
`3bf61316` la sta costruendo e ha gia' un passo chiuso sul modello di frecency:
e' li' che va il primo colpo, non nel disegno.

## 3. Le cose che valgono la pena

Due letture, tenute separate perche' ordinano con criteri diversi e la
differenza e' informativa: la prima ordina per **quanto duole**, la seconda
per **ritorno contro costo**. Dove concordano (storico globale, scheda nuova
che ricorda) non c'e' piu' niente da decidere: e' il primo colpo.

### Per quanto duole

1. **Cronologia vera, globale, cercabile** (titolo, data, conteggio visite).
   Perche' e' il prerequisito di tre cose diverse: la nuova scheda, il
   completamento nella barra e il «riapri quello che avevo». Oggi al suo posto
   c'e' un array di 50 stringhe per topic in `localStorage`.
2. **La nuova scheda diventa una pagina** (card `3bf61316` gia' aperta).
   Perche' e' l'unica superficie che ogni apertura di pane attraversa, ed e'
   l'unico punto dove Topics puo' mostrare cio' che gli altri browser non hanno:
   le anteprime dei task, le sessioni, i progetti.
3. **Zoom e ricerca nativi al posto del JavaScript iniettato.**
   Perche' sono i due comandi che l'utente prova per primo per capire se «e' un
   browser vero», e sono anche gli unici due dove la nostra imitazione si vede a
   occhio nudo (elementi fissi che non scalano, risultati non evidenziati).
4. **`target=_blank` apre una scheda.**
   Perche' e' il gesto piu' comune del web, e oggi non fallisce: fa una cosa
   diversa, che e' peggio. Il menu contestuale promette gia' «apri il link in una
   nuova scheda» e quel comando finisce fuori dall'app.
5. **Permessi del sito, con una riga che dice chi chiede cosa.**
   Perche' un sito che chiede microfono o webcam oggi fallisce in silenzio, e una
   pane che non risponde sembra rotta, non sembra severa.

Subito sotto la soglia, e vale la pena dirlo: motore di ricerca configurabile
(una riga di impostazione, oggi Google e' cablato) e download che si annullano.

### Per ritorno contro costo

**1. La barra che suggerisce, e la scheda nuova che ricorda.** Storico globale
dei siti con frecency, suggerimenti mentre scrivi, e la pagina iniziale che
mostra i soliti quattro posti. Oggi una pane vuota è un campo cieco: se non hai
l'URL in memoria, non parte niente.
Ritorno **alto**, costo **basso**. Già in corso sulla card `3bf61316`.

**2. La cronologia della pane sopravvive alla pane.** Riaprire dove si era
rimasti quando un topic si riapre, e poter rispondere a «dove ero finito ieri».
Oggi gli URL recenti vivono nella toolbar della pane e muoiono con lei, quindi
il lavoro di navigazione fatto per un task non è né riprendibile né
ispezionabile.
Ritorno **alto**, costo **medio** (persistenza per topic, non un archivio globale).

**3. Le identità salvate diventano una voce visibile.** `browser_save_state` e
`browser_import_chrome` esistono già e li usa solo l'agente. Portarli nella
toolbar («entra come…», «questa scheda usa il profilo X») risolve a mano il caso
più frequente e più fastidioso: la pagina dietro un login.
Ritorno **medio-alto**, costo **medio**: il motore c'è, manca la superficie.

**4. Il motore di ricerca e la pagina iniziale si scelgono.** Google cablato in
una costante è un difetto, non una scelta di prodotto, e costa mezza giornata
levarlo.
Ritorno **medio**, costo **basso**. Da fare insieme al punto 1, è la stessa
schermata di impostazioni.

Una quinta, minore, se avanza tempo: il **tasto ferma** accanto a ricarica, che
oggi manca e su una pagina che non finisce di caricare lascia senza uscita.

## 4. Cosa non copiare, e perche'

- **Preferiti e spaces.** Nemmeno Pippo ha i preferiti: usa le tab fissate. Noi
  le abbiamo già, e sono a livello di guscio, dove servono.
- **Blocco contenuti.** Liste filtro da aggiornare, regole da compilare, siti che
  si rompono: manutenzione a vita per un problema che qui non abbiamo (le pane
  vivono su pagine di lavoro, non su portali pieni di pubblicità).
- **Gestore di password e passkey.** Custodire segreti è un mestiere serio; il
  nostro modo è il profilo di sessione, che non conserva password.
- **Browser predefinito del sistema, lettore, traduzione.** Sono il mestiere di
  chi *abita* il browser.
- **Il ramo performance/audit di chrome-devtools.** Già escluso il 04/08:
  appartiene al livello QA, non al browser dell'agente.

## Gia' fatto, da non riscoprire

Card `9a4e8f64`: modello dei log di console (`consoleLogModel.ts`), segnaposto
delle favicon (`faviconPlaceholder.ts`), https prima nella barra
(`browserNavUrl.ts`). Card `63c3332a`: sfondo di scheda e toolbar coerenti col
tema, in review. Card `3bf61316`: pagina della nuova scheda, in corso.
