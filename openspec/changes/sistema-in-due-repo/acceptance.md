# Accettazione: il sistema degli agenti in due repo

T0 è fatta (22/11); il resto è un piano, una card per traccia. La barra è quella che le tracce di `tasks.md` devono far uscire verde, scritta una volta e rigirata sempre uguale. Ogni riga è un comando che esce non-zero se fallisce, o una misura con la sua soglia. I comandi che non esistono ancora sono creati dalla traccia indicata.

## Barra in `topics-app` (CI più pre-push)

1. **Cancello a cricchetto (T1).** `bun test tests/unit/no-instance-strings.test.ts` esce 0: `~/bin/push-guard --scan` sulle cartelle di codice (sulla macchina che ha la lista dei nomi; in CI la lista manca e valgono le classi) e le classi (home di una persona, `.claude/jarvis`, account, telefoni di 10-13 cifre, id di 17-19 cifre, IP). Il numero per percorso non sale. Partenza del 22/11, ricalcolata dal test alla prima esecuzione: 16 file non di test con `.claude/jarvis` (14 in cinque cartelle, 2 in `deploy/`), 19 o 27 file con id di agenti secondo l'espressione. `services/**`, `scripts/ops/**`, `harness/**` nascono con soglia 0. Lo stesso script gira nel pre-push.
2. **Zero occorrenze nel modulo importato (T7).** Per ogni modulo `M`, il cancello del punto 1 su `services/M` stampa 0, e `bun run scripts/check-push-clean.ts --range HEAD --not origin/main` esce 0 prima del push (senza `--range` legge uno stdin vuoto: non vale). In più, prima del sì 1, una lettura di fixture e testi di regole: i nomi di terzi non stanno in nessuna lista.
3. **Un job di CI per modulo.** `cargo test --manifest-path services/channels/Cargo.toml` e `services/hub/Cargo.toml` escono 0 (circa 680 test dei canali; la durata a freddo si scrive qui dopo la prima esecuzione). Un test sul flusso di rilascio prova che nessun modulo di `services/` viene ricompilato da un `ff` di `main`.
4. **Le altre change restano verdi:** `bun test` dei file toccati e di chi li importa (la suite intera la dà la CI della PR).

## Barra sulla macchina (`ops/verifica-due-repo`, nel repo dei dati: legge una macchina sola)

Esce 0 quando:
- **Regola git-crypt presente.** `git check-attr filter` = git-crypt per ogni file di `history/`, `channels/`, `agent-home/`, `hub/`, `launchd/`, `topics-config/`, `keychain-names.md`, `ops/` (i link simbolici restano fuori dal conto: git-crypt non li cifra, salva solo il percorso del bersaglio; 49 al 22/11, nessuno con un segreto); nessun gitlink; nessun file con nome tipo token, cookie, `.key`, `.env`, `.sqlite`, `media/`, `node_modules` nel repo dei dati; `git bundle verify` esce 0 per ogni bundle, nessuno oltre 100 MB nel push.
- **Tutto ciò che va catturato è catturato.** Ogni voce di `ops/catturato.txt` (canali, 63 plist, configurazione di `~/.topics`, nomi del Keychain, case di `jarvis` e `gtm`, memorie dei progetti propri) è nel repo dei dati dopo `sync.sh --commit`; `sync.sh --dry-run` non cambia nulla (`bash sync-test.sh` nel repo dei dati, verde dal 22/11).
- **Nessun git di sistema fuori dall'elenco.** `find` sulle radici di `ops/radici.txt` (non l'intera home: in `~/Projects` ci sono decine di repo di clienti) trova solo `topics-app`, `jarvis-private` e i prodotti di `ops/prodotti.txt`; il repo pubblico `jarvis` è privato e poi archiviato.
- **Servizi sani.** Ogni plist caricato ha il programma su disco; `jc health` esce 0 e un turno locale risponde; `curl` su `:3336` risponde e una chiamata vera passa dal proxy; `gateway_list` risponde; ogni hook di `settings.json` risolve; il server di Topics risponde.
- **Nessun riferimento ai percorsi vecchi** (elencati in `ops/vecchi-percorsi.txt`) in plist, `jobs.json`, `config.json`, hook, `~/bin` e prompt letti dagli agenti; un campionatore launchd con un suo log lo conferma per 24 ore (nessun processo li ha in `argv`, `cwd` o file aperti): la verifica legge quel log e fallisce se è più corto di 24 ore.
- **Nessun link di compatibilità** e `jarvis-private` è un clone autonomo.

## Mutazioni (devono fare rosso)

- **Cancello:** reinserire sotto `services/` un nome di `push-guard`, un telefono, un IP → rosso, 3 su 3 sulla macchina; le due classi senza lista (percorso di casa, id lungo) 2 su 2 in CI.
- **Regola git-crypt:** creare un file in una cartella nuova del repo dei dati senza regola → `verifica-due-repo` esce non-zero.
- **Specchio:** togliere una voce da `catturato.txt` con il file corrispondente → rosso; un `*.sqlite` sotto `agent-home/` → rosso.
- **Hook:** far mancare il bersaglio di un hook → il test scrive l'esito e fallisce se diverge da quello dichiarato.
- **Servizio:** un plist di prova su un percorso mancante → la sezione «servizi sani» esce non-zero.
- **Persona:** far arrivare SOUL a un ospite murato → il confronto del contesto prima/dopo non è vuoto.

## Scenario (comportamento, senza interfaccia)

Dati i canali scambiati sul binario compilato da `topics-app`, quando il proprietario scrive in chat privata e un ospite scrive in un gruppo murato, allora il proprietario riceve lo stesso contesto di prima (diff vuoto), l'ospite non riceve SOUL, AGENTS, memoria né blocchi centrali, il lavoro a orario che girava alle 9 gira alle 9 dal motore di Topics, e la chiamata di prova viene risposta. Prova: il log dei turni e della chiamata, non un video.

## Ciò che è verde resta verde

I test delle altre change; i test oggi verdi dei canali (circa 680) e dell'hub (`golden-diff`); `agents-doctor`; il backup del Mac e il passo delle 2:30 (`private-backup` esce 0 entro i suoi 30 minuti).
