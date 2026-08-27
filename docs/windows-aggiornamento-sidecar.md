# Windows: verificare che l'aggiornamento sia arrivato TUTTO

## Il difetto

Osservato il 27/08/2026 su una macchina Windows vera, aggiornando dalla 2.2.173
alla 2.2.176 con l'app aperta e un terminale in uso (installer NSIS silenzioso,
uscita 0). In `%LOCALAPPDATA%\Topics`:

    app.exe            08-27 01:41   sostituito
    topics-server.exe  08-27 01:33   sostituito
    webrtc-bridge.exe  08-27 01:33   sostituito
    pty-bridge.exe     08-26 17:32   NON sostituito

Registro e `app.exe` dichiaravano 2.2.176: l'aggiornamento si presentava come
riuscito. L'unico file rimasto indietro era l'unico che stava GIRANDO (il ponte
PTY tiene aperta una named pipe per i terminali).

## Perche' succede

Il template NSIS di Tauri (`tauri-bundler`, `nsis/utils.nsh`) chiude UN solo
processo prima di sovrascrivere la cartella: `CheckIfAppIsRunning` cerca e
uccide `${MAINBINARYNAME}.exe`, e nient'altro. I sidecar dichiarati in
`bundle.externalBin` restano vivi. Windows tiene bloccato il file immagine di un
processo vivo, quindi il `File /a` del template non riesce a sovrascriverlo; in
modalita' silenziosa NSIS salta il file ed esce comunque 0.

Stanotte non ha fatto danno per un caso fortunato: il binario vecchio conteneva
gia' tutti i fix del ponte. La prossima release che corregge il ponte, pero',
non arriverebbe proprio a chi aggiorna sopra l'app aperta, cioe' a tutti quelli
che passano dall'auto-updater.

## Cosa fa adesso l'installer

`desktop-tauri/src-tauri/installer-hooks.nsh` (agganciato da
`bundle.windows.nsis.installerHooks`):

1. **prima** della copia, e prima della disinstallazione che il percorso di
   aggiornamento esegue, chiude i sidecar per nome e aspetta che il lock del
   file si liberi (fino a 5 s ciascuno);
2. **dopo** la copia ricontrolla ogni sidecar: se uno e' ancora bloccato o
   manca, scrive la riga nel log dell'installer, imposta un exit code diverso da
   zero e, in installazione interattiva, lo dice con un avviso.

## Come si verifica, sul PC vero

Serve una macchina dove il ponte STIA GIRANDO davvero: apri Topics e lascia
aperto un terminale.

Prima e dopo l'aggiornamento, in PowerShell:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Topics\*.exe" |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
```

La prova e' la lista delle date prima e dopo: **tutte e quattro** devono
spostarsi. Se `pty-bridge.exe` resta indietro, l'installer ora esce con un
codice diverso da zero invece di dichiarare successo.

Per l'installer silenzioso, il codice di uscita:

```powershell
$p = Start-Process -FilePath .\Topics_x.y.z_x64-setup.exe -ArgumentList '/S' -Wait -PassThru
$p.ExitCode   # 0 = tutto sostituito, 5 = un sidecar era in uso
```

## Il controllo che resta acceso

L'installer puo' sempre fallire in un modo che non abbiamo previsto, quindi il
guscio non si fida e verifica dal lato opposto: la build registra l'impronta di
ogni binario di `externalBin` (`build.rs`), e all'avvio l'app confronta i file
che ha accanto con quelle impronte
(`desktop-tauri/src-tauri/src/sidecar_integrity.rs`).

Dove si vede:

* nel log del guscio, riga `[integrity] ...` a ogni avvio;
* nel popover della versione, l'avviso «Installazione incompleta» con il nome
  dei componenti rimasti indietro. E' il posto giusto perche' e' l'unico dove si
  legge «sei sulla 2.2.176»: e' li' che quel numero deve poter ammettere di
  essere vero solo in parte.

Il confronto e' byte a byte e vale solo su Windows, dove i byte impacchettati
sono esattamente quelli costruiti. Su macOS lo stesso sidecar viene lipo-ato in
un binario universale (ed eventualmente firmato), quindi i suoi byte sono
legittimamente diversi; e li' il bundle viene sostituito tutto insieme, che e'
il motivo per cui questo guasto non esiste. Chi un giorno aggiungera' la firma
del codice su Windows deve ripassare di qui: firmare riscrive il file firmato.
