# T6 - Il guscio sale di versione

**GOAL.** Il guscio gira su Tauri 2.12.3 o superiore, l'advisory multiwebview e'
applicato, e un aggiornamento che fallisce non lascia l'utente senza app.

## Perche' ora

Il guscio e' su versioni di cinque mesi fa. Tre difetti con un fallimento
nominabile, piu' uno di rilascio.

1. **GHSA-w28w-mhc8-qvjv**, corretto in 2.12.0: i channel non sono per-webview e
   le voci in coda si scopano fra webview. Topics usa `unstable` piu'
   multiwebview per le pane browser native e i channel per lo streaming: su
   2.11.3 un payload destinato a una pane puo' finire in un'altra.
2. **Un handler `onmessage` che lancia blocca la coda del channel**, corretto in
   2.12.3. Si vede come un turno che si ferma a meta' senza errore.
3. **L'updater puo' lasciare senza app su macOS**: un aggiornamento che fallisce
   a meta', disco pieno, rete caduta o Gatekeeper che rifiuta, cancella l'app
   installata e non la ripristina.
4. **Nessun cancello sui `.sig`**: se `TAURI_SIGNING_PRIVATE_KEY` non e'
   nell'ambiente, `tauri build` esce 0 senza emettere le firme. La release si
   pubblica, sembra sana, e ogni client rifiuta l'aggiornamento in silenzio.

Due difetti di piattaforma che il bump non copre:

- **Linux**: `set_bounds` e' un no-op su wry 0.55.1, quindi le webview figlie non
  si posizionano, mentre `bundle.targets: "all"` costruisce gli installer Linux.
- **Windows**: la pane figlia deriva dopo maximize/restore e l'Alt-Tab perde il
  fuoco. Il bump copre il fuoco; la deriva richiede una prova sul PC.

Contesto: `lib.rs` e' 13.878 righe, il 66% del crate, con 188 `unsafe` e tre
backend browser dentro `cfg`. E il ciclo di rilascio e' 6,4 release al giorno
con 101 MB interi a ogni aggiornamento.

## Cosa cambia

1. Bump a `tauri` 2.12.3 e `tauri-plugin-updater` 2.13.3. La coda e' il costo
   vero: MSRV 1.90, edition 2024, `windows` 0.62, `webview2-com` 0.39 (Windows 7
   cade), `minisign-verify` 0.3 che rifiuta firme Ed25519 non canoniche.
2. Un passo `assert-sig` in `tauri-release.yml`: i `.sig` attesi per ogni target
   esistono e combaciano con `latest.json`, altrimenti esce non-zero.
3. Un test che inietti un `throw` in un handler di channel e verifichi che il
   messaggio dopo arriva comunque. Vale piu' del bump: resta verde al prossimo
   salto di versione.
4. Misura: footprint dopo 50 cicli apri/chiudi pane, prima e dopo il bump.
5. Linux: scelta fra dichiarare la pane nativa non supportata e degradare a
   iframe sotto `cfg(target_os = "linux")`, oppure vendorizzare wry con la PR
   #1745. Decido io sulla prima: meno debito.
6. `lib.rs` si spezza per area e per motore con un trait.

## Barra

- `cargo tree -p tauri | head -1` da' 2.12.3 o piu'.
- `assert-sig` esce non-zero su una release senza firme.
- Il test del channel con `throw` e' verde.
- Un video del ciclo maximize/restore sul PC Windows, prima e dopo.

## Fuori

Cambiare guscio. Tauri e' l'architettura che il mercato 2026 ha scelto, Verso e'
archiviato, e la pane browser multiwebview di Topics e' avanti a quasi tutto.
