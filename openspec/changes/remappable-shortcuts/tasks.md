# Tasks — remappable-shortcuts

> Nessuna riga di codice prima dell'approvazione delle spec (CLAUDE.md).

## 1. Il registro diventa di comandi, non di didascalie

- [ ] 1.1 `shared/shortcuts.ts`: ogni voce prende un `id` stabile
      (`command.palette.open`, `chat.new`, …) accanto a `keys`/`description`.
      Gli id non cambiano mai: sono la chiave con cui un override sopravvive a
      una rinomina della descrizione.
- [ ] 1.2 `shared/shortcut-binding.ts` (nuovo, puro): normalizzazione di un
      accordo in forma canonica, uguaglianza, e `findConflict(bindings, chord)`.
      Test `bun:test` che coprono: maiuscole vs shift, layout non-US (il fix
      AZERTY/Dvorak è già stato necessario una volta), e accordi equivalenti
      scritti in ordine diverso.
- [ ] 1.3 Test: ogni id del registro è unico, e ogni comando ha un default che
      non collide con un altro default.

## 2. Il gestore chiede al registro invece di confrontare lettere

- [ ] 2.1 `useKeyboardShortcuts`: da catena di `if (e.key === 'x')` a
      `resolveCommand(chord)` → `switch (commandId)`. Un solo punto in cui un
      accordo diventa un comando.
- [ ] 2.2 I rami che NON sono rimappabili restano fuori dal registro e prima di
      esso, con il motivo scritto: Escape, ⌃Tab, il tap del ⌘ destro, e i rami
      che escono senza `preventDefault` quando il fuoco è in un campo di testo.
- [ ] 2.3 Test di regressione sul caso già visto: due comandi che condividono la
      lettera (⌘R ricarica / ⌘⇧R detta) non possono più rubarsi il turno per
      ordine di dichiarazione.

## 3. Gli override, persistiti come i Fissati

- [ ] 3.1 `client/src/hooks/useShortcutBindings.ts`: chiave `ui-state`
      dedicata, sanitizzata su una allowlist di id noti (un id ritirato non
      deve poter riemergere), stesso schema CAS di `useSidebarState`.
- [ ] 3.2 Un override che punta a un id sconosciuto viene scartato in lettura,
      non tenuto «per compatibilità».
- [ ] 3.3 Test: override vuoto ⇒ keymap identica a oggi, byte per byte.

## 4. Il pannello ⌘? diventa il posto in cui si rimappa

- [ ] 4.1 Ogni riga entra in cattura al click: il prossimo accordo premuto
      diventa la proposta, Escape annulla.
- [ ] 4.2 Il conflitto si dichiara PRIMA di applicare, nominando il comando che
      possiede l'accordo, con la scelta esplicita di rubarlo.
- [ ] 4.3 Un comando rimasto senza accordo si legge come tale — non sparisce
      dalla lista.
- [ ] 4.4 Ripristino per riga e ripristino totale; quest'ultimo raggiungibile
      anche dalle impostazioni, col mouse (CMD-REBIND-03).
- [ ] 4.5 L'accordo che apre il pannello non è riassegnabile, e il rifiuto dice
      perché.

## 5. La shell nativa

- [ ] 5.1 `scripts/gen-shortcuts.ts` continua a generare l'allowlist di base dai
      default. Verificare che `bun run gen:shortcuts` resti l'unico modo di
      scriverla (oggi lo è, e ha già evitato a mano un errore: separa
      correttamente `t` non-shift da `u` solo-shift).
- [ ] 5.2 Decidere e implementare UNA delle due, non entrambe a metà:
      (a) comando Tauri che estende l'inoltro a runtime con gli override, oppure
      (b) vincolo in UI che rifiuta gli accordi fuori allowlist con la ragione.
      La (b) è più piccola e onesta; la (a) è ciò che serve davvero.
- [ ] 5.3 Test E2E: con il fuoco dentro una pane terminale, un comando rimappato
      arriva (o è stato rifiutato in assegnazione — mai «assegnato e muto»).

## 6. Consegna

- [ ] 6.1 E2E sul giro completo: rimappa → ricarica → l'accordo nuovo funziona →
      ripristina → torna il default.
- [ ] 6.2 Video `.webm` del rimappaggio con conflitto: è un comportamento, e uno
      screenshot non prova un comportamento.
- [ ] 6.3 `openspec/specs/commands/spec.md` aggiornato con i requisiti nuovi.
