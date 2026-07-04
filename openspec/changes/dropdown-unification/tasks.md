# Tasks — dropdown-unification

Convenzione: ogni gruppo chiude con `cd client && tsc -b` + `bun run build:client` verdi.
Nessun cambio di look. `[ ]` = da fare.

## Phase 0 — Foundation (nuovo core, zero migrazioni)
- [ ] 0.1 `hooks/useDismissable.ts` — pointerdown(capture)+touch+Escape, ignora `refs`,
  focus-restore al trigger (skip se focus già interno a un input del menu). + unit test.
- [ ] 0.2 `lib/popoverPosition.ts::computeMenuPosition(anchorRect, menuSize, opts)` —
  clamp orizzontale + flip-above, estratto da `PaneAddMenu.computeAnchor`. + unit test 4 bordi.
- [ ] 0.3 Token z-index: costanti `Z_POPOVER/Z_CONTEXT_MENU/Z_MODAL` in `popoverStyles.ts`
  (+ eventuali var CSS in `index.css`); bake `Z_POPOVER` nel surface dove sensato.
- [ ] 0.4 `components/Shared/Menu.tsx` — primitive: portal, `computeMenuPosition`,
  `role="menu"`, roving-tabindex (Arrow/Home/End/Enter/Esc), focus-in/restore,
  `aria-haspopup/expanded` sul trigger, mobile sheet, `useDismissable`. `DropdownPortal`
  reimplementato come thin wrapper su `Menu` (API invariata → i 4 call-site esistenti
  ereditano flip/nav/role senza modifiche).
- [ ] 0.5 `browserOcclusion.test.ts` esteso: `Menu` markup + `POPOVER_*` matchano `OVERLAY_SELECTOR`.

## Phase 1 — Worst offenders
- [ ] 1.1 BrowserToolbar nav-history (`:271`) + URL-history (`:473`) → `Menu` (Esc, portal,
  flip, role, z-token); rimuovere branch `overlayMenu`.
- [ ] 1.2 BrowserDevControls DeviceSwitcher (`:97`) + ConsoleBadge (`:190`) → `Menu`;
  eliminare `useOutsideClose` locale (`:15`).
- [ ] 1.3 Modals/ContextMenu → portal + `Z_CONTEXT_MENU` + `useDismissable` (fix stacking
  sotto menu progetto/portaled); mantiene sub-panel rename.
- [ ] 1.4 PaneTabBar tab-ctx (`:931`) → `useDismissable` (aggiunge Escape).

## Phase 2 — Context menus & sidebar
- [ ] 2.1 SpaceSwitcher chip menu → `Menu`/`useDismissable` + z-token.
- [ ] 2.2 GitChanges file-ctx (`:439`) + branch dropdown (`:788/:1111`) → `Menu`/`useDismissable`.
- [ ] 2.3 FileExplorer ctx (`:1178`) → `Menu`/`useDismissable` (già `role=menu`).
- [ ] 2.4 TopicTree desktop terminal-ctx + project-ctx → `useDismissable` + z-token unico.
- [ ] 2.5 App.tsx Topics ▾ (`:1038`) + Remote (`:1139`) → `useDismissable` + `POPOVER_SURFACE` + z-token.
- [ ] 2.6 SidebarStatusBar status dropdown + VersionPopover → `useDismissable`; VersionPopover `role="dialog"`.

## Phase 3 — Chat listbox/mention & dedup
- [ ] 3.1 ProviderModelPicker → adotta `useDismissable`; aggiunge `role="listbox"/"option"` + `aria-activedescendant` (reference completo).
- [ ] 3.2 MentionAutocomplete + FileMentionMenu + slash menu (ChatInput) + queue popover →
  `useDismissable`, portal per i clip-risk, role=listbox dove applicabile.
- [ ] 3.3 CommandMenu → `useDismissable` + **dedup lista modelli** (sorgente unica con ProviderModelPicker).

## Phase 4 — Cleanup & guardrail
- [ ] 4.1 Rimuovere `lib/overlayMenu.ts` + `overlayThemeColors()` (popoverStyles) + tutti i
  branch `overlayMenusAvailable()`/`showOverlayMenu` residui.
- [ ] 4.2 Grep di verifica: nessun `z-[9999]`/`z-50` hard-coded su popover; nessun
  `mousedown` outside-click residuo fuori da `useDismissable`; nessun import `overlayMenu`.
- [ ] 4.3 `tsc -b` + `build:client` + `bun run test:unit` verdi; E2E mirati (open/close/esc/
  outside/flip/z-order) sui worst offender.

## Phase 5 — Verifica
- [ ] 5.1 Runtime sanity nella debug build (hot-reload): aprire browser toolbar menu, tab ctx,
  ContextMenu topic, model picker — Esc/outside/flip/keyboard OK, nessun menu sotto altro,
  nessun menu nascosto dietro pane nativo.
