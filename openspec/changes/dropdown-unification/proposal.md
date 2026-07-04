## Why

Audit ultracode (2 agenti, read-only) su **~30 dropdown/menu/popover** del client. La
correttezza di occlusione (i menu restano sopra i pane nativi WKWebView) oggi **regge
per tutti** — ogni menu porta `.glass-surface` o un `role` che `browserOcclusion.ts`
intercetta — ma è **implicita e fragile** e tutto il resto è frammentato:

- **Nessun hook di dismissal condiviso**: **21 effetti outside-click hand-rolled in 16
  file** + un secondo hook privato `useOutsideClose` dentro `BrowserDevControls`.
- **Escape incoerente**: ~7 menu non chiudono con Escape (i 4 dropdown del browser
  toolbar, il menu contestuale delle tab, ecc.).
- **Focus-restore: 0 su 24** — nessun menu riporta il focus al trigger alla chiusura;
  nessun focus entra nel menu all'apertura; nessun focus-trap.
- **z-index caos**: `z-50, z-[60], z-100, z-[9998], z-[9999], z-[10000]` per popover di
  pari livello → **bug reali di stacking** (il ContextMenu del topic a `z-50` finisce
  SOTTO il menu progetto `z-100` e SOTTO i menu portaled `z-9999`).
- **4 pattern in competizione**: `DropdownPortal` (portal), `PaneAddMenu` (portal
  bespoke con flip/clamp), portal-a-mano + effetto inline (8 menu), `absolute`
  non-portaled + effetto inline (7 menu, inclusi TUTTI quelli del browser toolbar → clip
  a bordo viewport, niente flip).
- **a11y quasi assente**: `role=menu/listbox` su 3 menu su ~20, `aria-haspopup/expanded`
  su 4 trigger, `aria-activedescendant` **mai**, keyboard-nav (frecce/Home/End) solo in
  `ProviderModelPicker`. `DropdownPortal` stesso non fa flip né keyboard-nav né role.
- **Codice morto**: `lib/overlayMenu.ts` + `overlayThemeColors()` (overlay nativo
  Electron, archiviato v2.0.0) e i branch `overlayMenusAvailable()` mai presi in
  `BrowserToolbar`/`BrowserDevControls`.
- **Duplicazione dati**: `CommandMenu` porta una lista modelli hardcoded **stale**
  (Sonnet 4 / Opus 4 / GPT-4o / o3-mini), parallela a `ProviderModelPicker`.

Peggiori offender: i **4 dropdown del browser toolbar** (nav-history, URL-history,
DeviceSwitcher, ConsoleBadge) — i menu più usati, aperti proprio sopra un pane nativo,
senza Escape, non-portaled, `z-50`, senza role né keyboard-nav; e il **ContextMenu del
topic** (il menu più ricco dell'app, non-portaled a `z-50`, sotto tutto).

## What Changes

Convergenza su **UNA** fondazione solida, con migrazione di tutti i menu custom. Nessun
cambiamento visivo (il look `popoverStyles` resta identico) — solo comportamento,
posizionamento, a11y, z-index e pulizia.

1. **`useDismissable({ open, onClose, refs })`** — un solo hook: pointerdown-outside
   (capture) + touch + Escape + **focus-restore al trigger**. Sostituisce i 21 effetti
   hand-rolled e il duplicato `useOutsideClose`.
2. **Promuovere `DropdownPortal` a primitive menu completo** (`Menu`): portal a body,
   **flip/clamp al viewport** (algoritmo da `PaneAddMenu.computeAnchor`), `role="menu"` +
   **roving-tabindex** (ArrowUp/Down/Home/End/Enter/Esc), focus nel menu all'apertura +
   restore alla chiusura, `aria-haspopup`/`aria-expanded` sul trigger.
3. **Token z-index** (`--z-popover`, `--z-context-menu`, `--z-modal`) baked in
   `popoverStyles`/primitive → nessun call-site sceglie più un numero; risolve i bug di
   stacking.
4. **Migrazione** di tutti i menu custom (~24) sul primitive + `useDismissable`; i
   `<select>` nativi restano invariati (OS-composited, già ok).
5. **Rimozione codice morto**: `overlayMenu.ts`, `overlayThemeColors()`, i branch
   `overlayMenusAvailable()`, il `useOutsideClose` duplicato.
6. **Dedup** della lista modelli di `CommandMenu` (sorgente unica con `ProviderModelPicker`).
7. **Invariante di occlusione reso esplicito**: il primitive porta sempre il marker
   (`role="menu"` + `.glass-surface`) e un test estende `browserOcclusion.test.ts` così
   un menu futuro non può più dimenticare il marker.

Non-goal: ridisegnare i pattern-modale (`CommandPalette`, palette di `PaneAddMenu`) o i
`<select>` nativi; nessun cambio di look.
