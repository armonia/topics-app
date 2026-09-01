# Proposal — tab-is-the-chrome

## Why

La chrome di una pane browser oggi vive in TRE componenti che dicono cose
sovrapposte:

- `BrowserToolbar` — la riga dell'indirizzo (back/forward/reload, favicon,
  campo indirizzo), condizionata a `chromeBridge.showChrome`;
- `browser-tab-menu` in `BrowserTabChrome` — un popover separato che contiene
  di nuovo l'indirizzo, piu' console, download, devtools, zoom;
- la tab stessa, che dal 2026-09-01 si espande da 200 a 300px quando e' attiva
  e porta l'indirizzo leggibile (card `dec39cd3`).

Tre superfici per la stessa domanda — «su cosa sono e cosa posso farci» — e la
prova che il taglio e' sbagliato e' il conto dei difetti: la riga
dell'indirizzo che «resta su» e' stata corretta **cinque volte**, l'ultima con
un commit intitolato «quattro cause, non una» (`42ba45429`). Ogni cura ha
tolto UNA via per cui la riga restava accesa; nessuna ha tolto la riga.

Le cause note, tutte della stessa famiglia:
1. letture campionate invece che osservate su pane ripristinata (`b9017cc59`);
2. il ramo iframe che rendeva la toolbar senza la condizione degli altri due;
3. `revealed` appiccicoso, acceso da un autofocus che scambiava una pane
   ripristinata per nuova;
4. il test che copriva meta' delle vie di idratazione;
5. (aperta) `revealed` acceso a mano — ⌘L, menu, download — e mai spento: il
   ripristino e' a fronte sul CAMBIO di indirizzo (`if (url !== seenUrl)`), e
   non esiste chiusura al blur. Su una pagina gia' caricata la riga resta su
   finche' non si naviga. Nessun test copre il ramo `browser:force-open`.

Finche' la riga esiste come superficie separata, esiste uno stato in cui puo'
restare accesa quando non serve. Il difetto non e' in nessuna delle cinque
cause: e' nella superficie di troppo.

## What Changes

La tab DIVENTA la chrome. Tre stati di una cosa sola, invece di tre componenti:

- **a riposo** — la tab dice il TITOLO della pagina, come ogni browser;
- **attiva** — la tab si espande e mostra l'INDIRIZZO leggibile (gia' fatto);
- **al focus** — la tab diventa un INPUT: l'indirizzo modificabile, la barra
  dei suggerimenti, e i comandi che oggi stanno nel popover separato
  (modifica indirizzo, console, download, devtools, zoom, torna allo spawner).

Ne consegue che:
- `BrowserToolbar` **si cancella**, non si unifica. Con essa spariscono
  `showChrome`, `revealed`, `hideChrome`, `revealAddress` e la classe di
  difetti che li accompagna: non c'e' piu' una riga che possa restare accesa,
  perche' non c'e' piu' una riga.
- `browser-tab-menu` **si cancella** come popover: il suo contenuto e' lo stato
  di focus della tab. Sparisce anche un popover portato dentro un contenitore
  che si chiude, che e' una trappola gia' pagata in questo repo.
- La pane guadagna i 40px della riga, su tutti e tre i rami (nativo, iframe,
  streaming), sempre — non «quando la riga decide di andarsene».

## Impact

- `client/src/components/Browser/BrowserToolbar.tsx` — rimosso.
- `client/src/components/Browser/useBrowserChromeBridge.ts` — rimosso o ridotto
  ai soli download/console, senza stato di rivelazione.
- `client/src/components/Browser/BrowserTabChrome.tsx` — accoglie lo stato di
  focus; `browser-tab-menu` rimosso.
- `client/src/components/Browser/RemoteBrowserPanel.tsx` — tre rami, tre
  render della toolbar in meno.
- `tests/e2e/browser-tab-chrome.spec.ts` — le prove sulla riga nascosta
  diventano prove sui tre stati della tab.

## Ordine rispetto a `dropdown-unification`

`dropdown-unification` (22 task, 0 fatti) prevede di sistemare i dropdown del
browser toolbar: Escape, focus-restore, z-index. Questa proposta li CANCELLA.
Farle in quell'ordine significa pagare due volte lo stesso componente: questa
va PRIMA, e `dropdown-unification` eredita ventisei dropdown invece di trenta.
