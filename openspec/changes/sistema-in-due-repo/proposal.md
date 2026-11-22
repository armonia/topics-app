# Il sistema degli agenti in due repo

## Da decidere
1. **Pubblicare in `topics-app` canali, hub e muro degli ospiti.** Rovescia `hub-tutto-in-topics` (teneva il codice dell'hub fuori perché legge stato personale) e ciò che `agenti-e-sistema` lasciava a una decisione a parte. Consigliata: sì, senza storia, un modulo per volta, ognuno solo con il cancello verde (push-guard, classi di stringhe, lettura umana di fixture e testi di regole); lo stato personale resta nei dati, letto da una cartella configurata. Perché: senza è impossibile avere due repo, e la storia (nomi, telefoni, id) resta cifrata nel repo dei dati: riscrivere la storia pubblica è misurato inutile. Alternativa: un terzo repo privato per canali e hub, meno rischio di fuga, un repo in più.
2. **Un solo sì per cambiare i servizi vivi.** Consigliata: sì, un pacchetto con le azioni nominate: installare dal nuovo repo le copie che i servizi leggono (canali, hub, gateway), riavvio dei canali solo con `jc quieto --gruppo <pid>` a 0 e nessuna chiamata aperta, scambio dell'hub da script staccato con ritorno automatico, link di compatibilità tenuti finché la scansione è pulita e 24 ore di silenzio campionato; condizione: barra verde. Perché: l'hub (`:3336`) serve ogni sessione Claude, e un sì a metà lascia un servizio per repo. Alternativa: un sì per servizio.
3. **Rendere subito privato il repo pubblico `jarvis`.** Consigliata: sì, adesso, poi archiviarlo a fine ritiro: è reversibile e ferma l'esposizione di 47 file su 459 con l'handle o la home di una persona (136 con una scansione più larga). Alternativa: aspettare l'ultimo giro, che è un altro push pubblico.
4. **Dati di persone su GitHub, cifrati.** Contatti delle liste di `outreach/` dell'agente `gtm`, 59 gruppi con i telefoni nella configurazione dei canali, circa 660 cartelle di memoria di progetto (alcune di clienti) nel repo dei dati. Consigliata: sì per i primi due, solo dopo `git check-attr` = git-crypt su ogni file e prima del primo push; le memorie dei progetti dei clienti restano fuori. Alternativa: niente di tutto ciò fuori dal Mac (resta il solo backup cifrato).
5. **Archiviazioni, cancellazioni e prodotti, un sì per l'elenco** (`inventario.md`, G). Consigliata: archiviare 9 repo dopo il bundle; cancellare i 3 cloni di terzi (activitywatch 620 MB con 7 file modificati da guardare prima, linkedin-mcp-server, Branchlight); ritirare `memoria.git` (perde per sempre la storia a ogni modifica: 589 commit automatici); lasciare fuori come prodotti ai-memory, winfleet (da ripulire di 20 occorrenze), devbridge, live-translate, claude-discord-presence, voce-app, i benchmark, shopping-mcp, viaggi-mcp. Alternativa: shopping-mcp e viaggi-mcp in `topics-app` come esempi (scrapano Booking e Kayak: termini da leggere).

ok / ok ma 2 no

## Perché
Il sistema non è in due repo: oltre a `topics-app` e `jarvis-private` restano una ventina di repo git legati agli agenti (6 senza alcun remoto, 2 con il remoto archiviato). Misurato il 22/11:
- Il codice dei canali (25.105 righe di Rust, circa 680 test) e dell'hub (14,7 mila) vive solo in un checkout locale da 1.485 commit: il repo pubblico non li contiene (0 file sotto `tools/` su `origin/main`) e il ramo di backup nel repo dei dati è fermo al 1/11, con l'hub e senza i canali. La storia dei canali ha una sola copia.
- Ciò che gira parte da copie solo in parte: il binario dei canali e quello dell'hub sì, ma il gateway è un link al sorgente, 22 plist lanciano script dal sorgente, 2 hook (`quota-reserve-hook`, `recall.py`) e l'hub (cartella di lavoro, `--state`, `hub-read.mjs`) dipendono dalla cartella.
- Il repo dei dati non cattura: configurazione e circa 150 lavori dei canali, 53 plist su 63, la casa `gtm` (4,4 GB, 126 voci non committate = 2.386 file), la configurazione in `~/.topics`, i nomi delle voci del Keychain. Le cartelle nuove che il piano vi aggiunge oggi non hanno la regola git-crypt: sarebbero in chiaro.
- Il cancello che c'è non vede abbastanza: sui canali `.personal-terms` (7 termini) trova 2 righe, `push-guard --scan` (49 termini) 199 righe in 18 file, con 64 righe di telefoni o id WhatsApp.
- `topics-app` stesso viola la regola zero: 16 file non di test col percorso del proprietario (14 in cinque cartelle di codice, 2 in `deploy/`), almeno 19 con id di agenti.

## Cosa cambia
- **`topics-app`:** `services/channels`, `services/hub`, `services/mcp-gateway`, `services/mcp`, `scripts/ops`, `harness/`. Niente nomi, percorsi o id: ciò che varia sta nelle impostazioni o nei dati, con un default vuoto che funziona.
- **`jarvis-private`:** `claude/`, `agent-home/<id>/`, `channels/`, `hub/`, `launchd/` (`@HOME@`), `topics-config/`, `keychain-names.md`, `scripts/`, `history/` (bundle), `ops/`. Ogni cartella nuova nasce con la sua regola git-crypt, prima del primo commit.
- **Fuori dal conto:** prodotti e cloni di terzi (G).
- **Cinque fasi** (`tasks.md`): rete e cancello (subito) → generico sul posto → import senza storia → scambio dei servizi → ritiro. Il dettaglio per cartella è in `inventario.md`.

## Barra
`acceptance.md`: cancello a cricchetto con `push-guard --scan` e classi anche nel pre-push, `git check-attr` git-crypt su ogni file nuovo del repo dei dati, `cargo test` per modulo in CI, `verifica-due-repo` sulla macchina, mutazioni che fanno rosso.

## Fuori
Questa change non sposta, non pusha e non archivia niente. Non rifà le altre sette in corso, da cui dipende: `agents-in-topics-home`, `lavori-programmati-in-topics` (comprese le aggiunte che chiede ai canali), `agenti-e-sistema` (T2 va emendata con i parametri ospite/proprietario), `hub-tutto-in-topics`, `chiamate-vocali` (decide la voce: il suo T6), `nodo-principale-a-mano` (il canale su Linux: l'installatore conserva `pack`/`unpack`), `limiti-consumo-progetto` (usa il nome del binario). Non tocca DB, media e cache di Topics.

## Deciso dall'agente
- **Dove la copia in esecuzione c'è già, il percorso non cambia; dove non c'è (gateway, script, 2 hook, lavoro dell'hub) prima si crea la copia installata**, poi si ripulisce. Si ripulisce su una copia, o con la configurazione d'istanza nello stesso commit e una prova di parità: un default vuoto non deve spegnere un backup.
- **Case degli agenti: solo specchio per allowlist** nel repo dei dati, nessun commit nel git di `gtm`, nessun git dentro le case.
- **Direzione dello specchio: dal vivo al repo dei dati**, dichiarata per cartella in `ops/direzione.txt`; il repo dei dati diventa sorgente di una cartella solo dopo il ritiro.
- **Il cancello gira nel pre-push, non solo in CI**, e legge gli id degli agenti dalle impostazioni, non da un test pubblico.

## Non ancora specificato
- Perimetro del cancello: `openspec/` ha già 23 file con `.claude/jarvis`; o ha una soglia sua o resta fuori.
- Nomi: il crate e il binario `jarvis-channels`, le etichette `com.jarvis.*`, l'identità di firma che conserva il permesso Promemoria (rinominarla lo fa richiedere di nuovo), 29 file di `topics-app` che citano il binario.
- Come un secondo utente installa i servizi; quanto dura a freddo la build CI dei canali (405 crate); se `topics-board` duplica gli strumenti nativi; l'id di modello del backend Muse usato da 3 lavori.
- Il destino di `~/.claude/jarvis` dopo il ritiro: proposta, resta come cartella di esecuzione dell'istanza (script, stato, log), non più un repo.
