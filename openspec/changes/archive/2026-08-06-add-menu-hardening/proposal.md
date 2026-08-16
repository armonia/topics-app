# Proposal — add-menu-hardening

Seguito di [`dropdown-unification`](../dropdown-unification/proposal.md), che aveva
unificato i dropdown **verso l'alto** (un componente per tutti gli ospiti) senza
unificarli **verso il basso** (la primitiva). In quel divario sono vissuti tre
difetti, tutti riprodotti sull'app viva prima di scrivere una riga.

## Why

### 1. «Sui progetti manca l'aggiunta della chat» — mancava OVUNQUE

`ui_state.settings` conteneva `enableNewChat: false`. Il default in codice era
passato a `true` il 2026-07 (la chat gira sull'abbonamento, non su credito API),
ma il valore salvato lo scavalca per sempre: `loadSettings` fonde localStorage
sopra i default e `applyServerSettings` fonde il server sopra entrambi. Da lì
`App.tsx` spegneva la prop a monte in cinque punti e la riga spariva da tutti e
sei gli ospiti del menu.

Si notava «nei progetti» solo perché lì il `+` resta comunque visibile
(`onAddProjectPane` non era gated): il menu si apriva con otto voci su nove, e
sembrava una voce mancante invece di una feature spenta.

Il flag era un interruttore che poteva **solo** rompere: il motivo per cui
esisteva («una chat nuova è un turno a consumo») non è più vero, e nessuna UI
diceva perché la voce fosse sparita.

### 2. «Premo ⌘N e si aprono tutti i dropdown»

L'invariante «un popover alla volta» non esisteva: **sembrava** esistere.
`useDismissable` chiude su `pointerdown` fuori dai propri ref, quindi aprendo col
mouse il pointerdown sul nuovo trigger chiudeva il precedente — un effetto
collaterale del puntatore, non una regola. Ogni apertura da **tastiera** la
aggirava.

Misurato in headless su :3333 — dropdown della tab bar aperto: `menus: 1`; poi
⌘N: `menus: 2`, entrambi montati e dipinti.

### 3. E si vedevano tutti insieme perché lo z-order era invertito

La palette era `z-[60]`; ogni popover portalato vale `Z_POPOVER = 9999`. Stesso
stacking context (`document.body`): il dropdown già aperto si disegnava **nitido
sopra** la palette e sopra il suo velo. Il commento in `popoverStyles.ts` («a
popover must float over everything except a modal») affermava il contrario del
vero, ed era vero anche per ⌘K e per il pannello scorciatoie.

### Il debito che li rendeva possibili

`PaneAddMenu` non passava da `Menu.tsx` — la primitiva che il suo stesso docblock
dichiara obbligatoria. Riscriveva a mano portal, misura, flip, listener di
resize/scroll e foglio mobile (~120 righe duplicate) e nel farlo perdeva
`role="menu"`, `tabIndex`, il fuoco nel pannello e le frecce. Il gemello **touch**
degli stessi item li aveva, perché passa da `DropdownPortal → Menu`.

E la lista delle voci esisteva due volte: le righe del menu e le pill di ⌘K,
scritte a mano separatamente e già divergenti (⌘K non offriva opencode, né
Browser, né Board). I quattro agenti del terminale erano cablati in entrambe,
benché `shared/terminal-session-types.ts` dichiari di essere il registro.

## What

1. **Rimuovere `enableNewChat`** — dal tipo, dai default, dai cinque ternari, dal
   toggle in Impostazioni (e con esso la scheda «Features», che conteneva solo
   quello). `loadSettings` smette di fare una spread cieca: filtra sulle chiavi
   note, così un campo ritirato non sopravvive come fossile nel PUT.
2. **Registro popover** (`lib/popoverRegistry`): all'apertura, un popover chiude
   ogni altro popover aperto che non lo **contenga**. Il contenimento si misura
   su `refs[0]` — il trigger dichiarato — e non su `document.activeElement`, che
   quando ⌘N parte col fuoco dentro un menu farebbe passare la palette per un
   figlio di quel menu (cioè il bug). Un modale a schermo intero sgombera tutto.
3. **`Z_MODAL = 10000`** + `MODAL_LAYER`: nessuna superficie modale scrive più il
   proprio z-index a mano.
4. **`PaneAddMenu` sulla primitiva `Menu`** (dropdown e foglio mobile), con
   `testId` sul pannello per non rompere i 16 file di spec che lo cercano.
   `role="menuitem"` sulle righe, `aria-haspopup`/`aria-expanded` sul trigger, e
   la tastiera estratta in `useMenuKeyboard` così la palette — che non è ancorata
   e quindi non passa da `Menu` — smette di essere l'unica superficie senza
   frecce.
5. **Una sola lista di voci** (`addMenuItems.tsx`), consumata sia dalle righe del
   menu sia dalle pill di ⌘K, con gli agenti del terminale derivati dal registro
   condiviso.
6. **Mnemonic per riga**: chip `.kbd` a destra e attivazione col **tasto nudo** a
   menu aperto (⌘N poi `B` = nuovo browser). Le lettere stanno in un registro
   congelato, non calcolate sul sottoinsieme visibile: `availableTypes` filtra i
   singleton già presenti, e una lettera che si sposta quando nascondi Git è una
   lettera che nessuno impara.

## Non-goals

- **⌘N non diventa contestuale.** Continua ad aprire la palette standalone. È
  cambiato solo che smette di **mentire**: l'hint «⌘N» spariva… anzi, compariva
  sulle tab bar dei gruppi affermando di creare una chat *lì*. Ora si dipinge nel
  solo ospite dove è vero.
- Nessun cambiamento all'ordine delle voci né ai `data-testid`, che sono il
  contratto di venti spec.
