# Y1 — Tray di Topics: dati dal servizio e barra con le quote

**Cosa:** `desktop-tauri/src-tauri/src/lib.rs` (tray creata intorno alla riga 12008, menu in `set_app_status` ~3050) prende i dati dal servizio direttamente, non dal client web: così si aggiorna a finestra nascosta e a Topics riavviato (stessi endpoint di oggi: `overview` ogni 60 s, `live`, `gates`, `queue`, `heavy`, `mac`, `machines`, `automations/summary`, `board`). La barra con una colonna per account (mail, 5 ore e 7 giorni con percentuale, barra, reset; icone provider) è un'immagine disegnata a runtime (`TrayIconBuilder` ha solo icona e testo): è la parte difficile.
**Collegata:** card b3e19133 «Lag all'apertura della tray» (misurare prima: la tray nuova non deve peggiorare).
**Dipendenze:** nessuna (parla al vecchio `:3360` o al servizio con la stessa risposta; l'indirizzo è configurabile).
**Barra:** `tray-perf.sh` riscritto verde (apertura sotto il budget, ridisegno ogni 60 s senza crescita di memoria); `--snapshot` della tray nuova accanto a quello della Swift con `vis affianca` (stesse percentuali, hub giù → «offline»); mutazione: servizio fermo, tray «offline» e non vuota. Ok a vista di Attilio sulla barra (decisione 2).
**Fuori:** menu e azioni (Y2).
**Stima:** 4 h.
