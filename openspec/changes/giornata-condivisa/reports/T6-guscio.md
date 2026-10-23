# T6 - Il guscio sale a Tauri 2.12, e la release controlla le proprie firme

PR #414, branch `claude/gc-t6-guscio-f69026`, tre commit sopra `origin/main`.
Il merge non e' stato fatto: la decisione e' di Attilio (vedi in fondo).

## La barra

- **Tauri 2.12.5** (barra: 2.12.3 o piu'). Risolto in `Cargo.lock`, con
  `tauri-plugin-updater` 2.14.0, wry 0.57.1, tao 0.37.2, minisign-verify 0.3.0,
  webview2-com 0.39.1. MSRV 1.90, imposto dalle dipendenze.
  Prova: `cargo check --locked` su macOS esce 0, zero errori, zero warning.
- **`assert-sig` che morde.** Prova: `bun test scripts/assert-sig.test.ts` su Mac,
  25 pass e 0 fail, exit 0. Dentro ci sono i 7 test del CLI con un `gh` finto,
  che sul PC Windows non possono girare (la shell del finto e' POSIX): li prova
  il Mac, e la CI Linux li rigira su ogni PR.
- **Test del channel con `throw`.** Prova: 3 pass su Mac e 3 pass sul PC (via
  `offload`). Morde al confine 2.12.2 / 2.12.3, misurato in una sessione
  precedente.

Il controllo gia' in CI sui tre sistemi (`tauri` macos, ubuntu, windows) viene
dalla PR, non da questo report: qui riporto solo cio' che ho visto girare.

## Due premesse sbagliate

1. **«Il CLI di Tauri esce 0 senza `.sig`».** Falso. Con la chiave assente il CLI
   si ferma: una release senza firme e' gia' rossa oggi. `assert-sig` resta
   come guardia per il giorno in cui questo cambi (un `--no-sign`, un CLI che
   abbassa l'errore a warning).
2. **«La GHSA del Channel ci tocca».** L'avviso richiede payload grandi con piu'
   webview, e Topics non istanzia nessun `Channel`. Il test prova la classe che
   la crate porta (`bundle.global.js`), non l'uso in pagina: la garanzia copre la
   classe, e va estesa a `@tauri-apps/api` quando lo si adotta (nota in RELEASE-08).

## Cosa cambia, e cosa non e' verificato

- **Popup macOS.** wry 0.57 (#1876) non aggiunge piu' i propri script ai popup
  che condividono la configurazione della pane. Il reindirizzamento di
  `window.close()` del popup (login Google GIS / OAuth) non girava piu'. Lo script
  passa alla pane, con guardia `window.opener`, e il popup lo eredita.
  **Non verificato sul comportamento vero** (login in una pane su Mac). Il Mac
  ha `Topics.app` di Attilio in esecuzione da 22 ore con lo stesso identifier
  (`io.armonia.topics.tauri`): lanciare qui la mia build significa aprire una
  seconda istanza accanto a quella in uso, e il load era 320. Non l'ho fatto.
  `cargo check` e' verde, il comportamento no. **Rischio aperto**: la prova
  del popup va fatta su una build isolata (identifier e cartella dati propri),
  quando il Mac e' libero.
- **Release firmate.** `assert-sig` controlla che la versione firmata dai `.sig`
  coincida con il tag e con `latest.json` (il client 2.14 rifiuta il bundle se non
  coincide), che la chiave sia quella dell'app, e che l'url del manifesto punti
  alla release del tag.

## Non fatto (dalla traccia)

- Footprint dopo 50 cicli apri/chiudi pane.
- Decisione sulla pane nativa su Linux.
- Split di `lib.rs`.
- Video di maximize/restore su Windows.
- `tools/wkzprobe`: i pin sono stantii (tao =0.35.3, wry =0.55.1, windows =0.61.3).
  Non toccati: quel probe non compila su Mac.
- Commenti «verificato su tao 0.35.3 / wry 0.55.1» in `lib.rs`: non aggiornati,
  bassa priorita'.

## Deviazioni

- **Modifiche di testo fatte da me, non da Muse.** La delega era frenata dalla
  quota e accodata (`d2ca50`): le tre righe (MSRV in `Cargo.toml`, nota
  `withGlobalTauri` nel test e in RELEASE-08) le ho scritte io, e le ho verificate
  dal diff.
- **Un test riscritto:** la fixture «latest.json con un bundle senza `.sig`»
  usava un url fuori release, che il nuovo controllo sul tag segnalava in piu'.
  L'ho portata su un url di release vero, senza cambiare cio' che il test misura.

## Conseguenza del merge

Ogni merge su `main` con CI verde pubblica una release firmata, e i client che si
aggiornano da soli la ricevono. Il guscio nuovo arriva a tutti al primo merge.
Per questo il merge va deciso dopo la verifica del popup su Mac.

## Righe in produzione

- `scripts/assert-sig.ts`: +193, cancello nuovo, niente tolto.
- Branch intero: 10 file, +1008 / -244 (bump, `lib.rs`, workflow, test).

## Prove e gate

- `cargo check --locked` (macOS, con segnaposto dei sidecar rimossi a fine giro): 0.
- `bun test`: `assert-sig` 25/25 (Mac); channel 3/3 (Mac e PC).
- Gate: `check:emdash`, `check:comment-language` (exit 0, dopo che ho riscritto in
  inglese le mie righe in `lib.rs` che alzavano il conteggio), `check:identifier-language`,
  `check:spec-coverage`, `check:untraced-tests`, `typecheck:server` (0 errori).
