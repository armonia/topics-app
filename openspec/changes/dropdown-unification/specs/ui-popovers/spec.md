## ADDED Requirements

### Requirement: UI-POPOVER-01 — Dismissal unificato (outside-click, Escape, focus-restore)

Ogni menu/dropdown/popover custom SHALL chiudersi (a) al pointer-down **fuori** dal
trigger e dal pannello, e (b) alla pressione di **Escape**. Alla chiusura il focus SHALL
tornare all'elemento trigger, salvo quando il focus è già stato spostato altrove
dall'utente. Questa logica SHALL vivere in un unico hook condiviso
(`useDismissable`) — nessun call-site reimplementa il listener.

#### Scenario: Escape chiude ogni menu
- **GIVEN** un qualunque menu custom aperto (browser toolbar, tab context, model picker, …)
- **WHEN** l'utente preme Escape
- **THEN** il menu si chiude e il focus torna al trigger

#### Scenario: click esterno chiude
- **GIVEN** un menu aperto
- **WHEN** l'utente fa pointer-down su un punto fuori dal menu e dal trigger
- **THEN** il menu si chiude; il click su un elemento interno NON lo chiude

### Requirement: UI-POPOVER-02 — Posizionamento viewport-aware (portal, flip, clamp)

Un menu ancorato SHALL essere renderizzato in un portal su `document.body` (per sfuggire a
`overflow`/stacking-context del parent) e posizionato in modo da **non uscire dal
viewport**: clamp orizzontale ai bordi e **flip verso l'alto** quando l'apertura verso il
basso verrebbe tagliata. Il calcolo SHALL provenire da un'unica funzione condivisa
(`computeMenuPosition`).

#### Scenario: flip al bordo inferiore
- **GIVEN** un trigger vicino al bordo inferiore del viewport
- **WHEN** il menu si apre e non c'è spazio sotto
- **THEN** il menu si apre verso l'alto e resta interamente visibile

#### Scenario: clamp al bordo laterale
- **GIVEN** un trigger vicino al bordo destro/sinistro
- **WHEN** il menu si apre
- **THEN** il menu è traslato per restare dentro il viewport, senza clipping

### Requirement: UI-POPOVER-03 — Navigazione da tastiera e ruoli ARIA

Il primitive menu SHALL esporre `role="menu"` (o `role="listbox"` per i picker) con item
`role="menuitem"`/`role="option"`, e il trigger SHALL esporre `aria-haspopup` e
`aria-expanded`. All'apertura il focus SHALL entrare nel menu; ArrowUp/ArrowDown SHALL
spostare l'item attivo, Home/End ai bordi, Enter/Space attivare, Escape chiudere. I picker
a lista SHALL riflettere l'item attivo via `aria-activedescendant`.

#### Scenario: navigazione con frecce
- **GIVEN** un menu aperto via tastiera
- **WHEN** l'utente preme ArrowDown/ArrowUp
- **THEN** il focus si sposta tra gli item; Enter attiva quello focalizzato

### Requirement: UI-POPOVER-04 — Invariante di occlusione sui pane nativi

Ogni menu che può aprirsi sopra un pane browser nativo SHALL portare un marker che
`browserOcclusion.OVERLAY_SELECTOR` intercetta (`role="menu"`/`"listbox"`/`"dialog"` **e**
`.glass-surface`), così il pane sottostante si congela e il menu resta visibile. Il
primitive condiviso SHALL garantire il marker per costruzione, e un test SHALL fallire se
il marker o i token di stile non matchano più il selettore.

#### Scenario: menu visibile sopra il pane nativo
- **GIVEN** un pane browser nativo che compone sopra il DOM
- **WHEN** un menu si apre intersecando lo slot del pane
- **THEN** il pane si congela (freeze) e il menu è visibile sopra, non nascosto dietro

#### Scenario: guardrail sul marker
- **GIVEN** il markup del primitive menu e i token `POPOVER_*`
- **WHEN** gira il test strutturale di occlusione
- **THEN** entrambi matchano `OVERLAY_SELECTOR`; un menu senza marker fa fallire il test

### Requirement: UI-POPOVER-05 — Layering z-index tokenizzato

I livelli di stacking dei popover SHALL usare token condivisi (`Z_POPOVER`,
`Z_CONTEXT_MENU`, `Z_MODAL`) invece di numeri ad-hoc. I context-menu e i dropdown SHALL
stare sullo stesso piano; i modali/palette SHALL stare sopra i popover. Nessun call-site
SHALL scrivere un valore z-index letterale per un popover.

#### Scenario: nessun menu finisce sotto un pari-livello
- **GIVEN** il context-menu di un topic e un altro dropdown aperti in sequenza
- **WHEN** entrambi sono renderizzati
- **THEN** stanno sullo stesso piano di stacking (nessuno sparisce sotto l'altro), e un
  modale aperto sopra li copre entrambi

### Requirement: UI-POPOVER-06 — Rimozione del path overlay-menu morto

Il path degli overlay-menu nativi Electron SHALL essere rimosso: `lib/overlayMenu.ts`,
`overlayThemeColors()` e ogni branch `overlayMenusAvailable()`/`showOverlayMenu()` nei
call-site. I menu del browser SHALL usare il primitive React condiviso.

#### Scenario: nessun riferimento residuo
- **GIVEN** il codebase dopo il change
- **WHEN** si cerca `overlayMenu`/`overlayMenusAvailable`/`overlayThemeColors`
- **THEN** non esiste più alcun riferimento e la build resta verde
