# Design — dropdown-unification

## Context

Stato mappato dall'audit (file:riga nei task). Due sorgenti di verità già buone da
riusare, **non** rimpiazzare:
- `lib/popoverStyles.ts` — look canonico (`POPOVER_SURFACE/PANEL/ITEM/DIVIDER/SHEET`).
  Resta la sorgente di stile; ci aggiungiamo solo il token z-index.
- `lib/shell/browserOcclusion.ts` — `OVERLAY_SELECTOR` (`.glass-surface, .native-occlude,
  [role="dialog"], [role="menu"], [role="listbox"], …`) è il contratto che tiene i menu
  sopra i pane nativi. **Invariante**: ogni menu DEVE matchare questo selettore.

Riferimenti di qualità da generalizzare: `ProviderModelPicker` (pointerdown-outside +
frecce + scroll-into-view + portal/clamp) e `CommandPalette` (unico con
`role="listbox"/"option"`).

## Decisioni

### D1 — Due primitive, non una libreria esterna
Niente Radix/Floating-UI (il progetto non li usa; peso + CSP). Costruiamo:
- **`useDismissable({ open, onClose, refs, restoreFocus? })`** (`hooks/useDismissable.ts`)
  — `pointerdown` in **capture** su document (più robusto di `mousedown` bubble, come già
  scelto in `ProviderModelPicker:51`) + `touchstart` + `keydown` Escape (con
  `stopPropagation`), ignora i nodi in `refs`. Alla chiusura, se `restoreFocus` (default
  true), riporta `.focus()` all'elemento trigger memorizzato all'apertura.
- **`Menu` primitive** — evoluzione di `DropdownPortal` (stesso nome file o nuovo
  `components/Shared/Menu.tsx`; `DropdownPortal` diventa un thin wrapper retrocompatibile
  finché i call-site migrano). Responsabilità: portal→body, posizionamento con flip/clamp,
  `role="menu"`, roving-tabindex, focus-in/out, `aria-*`, mobile bottom-sheet (già presente),
  z-token. Usa `useDismissable` internamente.

### D2 — Posizionamento (flip/clamp) unico
Estrarre `lib/popoverPosition.ts::computeMenuPosition(anchorRect, menuSize, opts)` dalla
logica già corretta di `PaneAddMenu.computeAnchor` (clamp orizzontale + flip-above quando
sfora in basso). Il `Menu` misura il proprio contenuto (ref) e riposiziona; ricalcola su
`resize`/`scroll`. Sostituisce i clamp per-menu sparsi (ContextMenu/FileExplorer/GitChanges/
TopicTree) e colma il buco "no flip" di `DropdownPortal`.

### D3 — Keyboard & a11y nel primitive (roving-tabindex)
Il `Menu` implementa il pattern WAI-ARIA menu: all'apertura focus sul primo item (o item
attivo); ArrowUp/Down muovono il focus tra `[role="menuitem"]`, Home/End ai bordi,
Enter/Space attivano, Escape chiude e restituisce focus. Il trigger espone
`aria-haspopup="menu"` + `aria-expanded`. Un helper `useMenuTrigger()` cabla trigger↔menu
(id, aria, ref) per i call-site che non usano il componente pieno. I menu-listbox
(ProviderModelPicker, mention, slash) usano la variante `role="listbox"/"option"` +
`aria-activedescendant`.

### D4 — Token z-index
Aggiungere in `index.css`/theme una scala esplicita e in `popoverStyles.ts` le costanti:
`Z_POPOVER` (menu/dropdown), `Z_CONTEXT_MENU` (= popover; stesso piano), `Z_MODAL`
(dialoghi/palette, sopra i popover), scrim mobile appena sotto. Il `Menu` applica
`Z_POPOVER`; nessun call-site scrive più `z-[9999]`/`z-50`. Ordine garantito:
context-menu ≡ popover < modal. Risolve ContextMenu-sotto-tutto.

### D5 — Occlusione esplicita + test
Il `Menu` porta sempre `role="menu"` **e** `.glass-surface` → doppia copertura del
selettore. Estendere `browserOcclusion.test.ts`: asserire che (a) il markup del `Menu`
matcha `OVERLAY_SELECTOR`, (b) `POPOVER_SURFACE/PANEL/SHEET` contengono `glass-surface`.
Così un menu costruito con `bg-elevated` nudo (come oggi il sub-menu di `CommandMenu:106`,
salvato solo dal parent) non può più sfuggire.

### D6 — Strategia di migrazione (sicura, incrementale)
`DropdownPortal` resta esportato e retrocompatibile; il `Menu` è il nuovo core, `DropdownPortal`
lo avvolge. Si migra call-site per call-site, verificando build+tsc a ogni gruppo. Ordine:
foundation → worst offenders (browser toolbar, ContextMenu z-index) → context-menu →
listbox/mention → resto → rimozione morti. I `<select>` nativi non si toccano.

## Mappa migrazione (consumer → azione)

| Consumer | Azione |
|---|---|
| `DropdownPortal` | diventa wrapper del nuovo `Menu` (flip/clamp/role/nav/z-token) |
| BrowserToolbar nav-history / URL-history | → `Menu` (Esc, portal, flip, role, z-token) |
| BrowserDevControls DeviceSwitcher / ConsoleBadge | → `Menu`; rimuovere `useOutsideClose` locale |
| Modals/ContextMenu | portal + `Z_CONTEXT_MENU` + `useDismissable`; opz. roving-nav |
| PaneTabBar tab ctx | `useDismissable` (aggiunge Esc); tiene il suo flip |
| SpaceSwitcher, GitChanges (file ctx + branch), FileExplorer, TopicTree (desktop ctx) | → `Menu`/`useDismissable` + z-token |
| App.tsx Topics ▾ / Remote | `useDismissable` + `POPOVER_SURFACE` + z-token |
| SidebarStatusBar, VersionPopover | `useDismissable`; VersionPopover `role="dialog"` |
| CommandMenu | `useDismissable`; **dedup lista modelli** (sorgente unica) |
| ProviderModelPicker | adotta `useDismissable`; resta reference (aggiunge role=listbox + activedescendant) |
| Mention/FileMention/slash/queue popover | `useDismissable`; role=listbox dove applicabile; portal per i clip-risk |
| PaneAddMenu | invariato (già flip/clamp); opz. usa `computeMenuPosition` condiviso |
| `<select>` nativi (5 file) | invariati |

## Rischi / mitigazioni
- **Regressioni di focus** su input-in-menu (rename in ContextMenu/SpaceSwitcher): il
  focus-restore non deve rubare focus mentre un input interno è attivo → `restoreFocus`
  skippa se il focus è già fuori dal trigger/menu.
- **z-index change** può scoprire assunzioni: verificare che modali restino sopra i menu.
- **Occlusione**: nessuna regressione perché il marker resta; il test lo blinda.
- **Grande superficie**: migrazione incrementale con tsc+build verdi per gruppo; nessun
  cambio di look riduce il rischio visivo.

## Testing
- Unit (`bun:test`, moduli puri): `useDismissable` (outside/esc/restore), `computeMenuPosition`
  (flip/clamp ai 4 bordi), `browserOcclusion` marker.
- E2E (Playwright) mirati sui worst offender: apertura/chiusura, Escape, click-outside,
  flip a bordo viewport, ordine z (context-menu vs modal). Occlusione pane-nativo non è
  E2E-abile qui (richiede binario Tauri) → coperta dal test strutturale del marker.
