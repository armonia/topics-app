# Hub, switchboard e tray dentro Topics: una porta, un servizio piccolo, nessuna app a parte

## Deciso da me
- 09/11: «Tutto dentro Topics»: schermate, tray e motore dell'hub dentro Topics; `:3360` rimanda a Topics.
- Ciò che deve restare acceso mentre Topics riparte (proxy degli account `:3336`, ritmo `/api/pace`, rotta della delega `/api/route`, «Ti aspetta» `/api/attesa`, i gate) diventa un piccolo servizio in Rust: meno di 60 MB contro i 204 dell'hub e i 71 di switchboard, una porta sola, nessuna app a parte.
- La tray `com.jarvis.claude-usage-tray` si unisce alla tray di Topics (Tauri). Il piano del 03-04/11 le teneva fuori: ora entrano.

## Perché
Oggi per guardare il sistema servono tre porte (`:3360` hub, `:3335` e `:3336` switchboard) e un'app Swift a parte da 33 MB, più il ponte e le schermate già in Topics. Il lavoro è a metà: dell'hub è entrato solo il ponte (`server/routes/hub.ts`, `/api/hub-live`) e le schermate di `hub-smistamento`; il motore, il proxy e la tray girano ancora per conto loro (hub 204 MB + switchboard 71 MB + tray 33 MB su un Mac che soffre di swap).

## Cosa cambia
Tredici tracce, ciascuna con il suo file in `tracce/` e la sua barra (indice e dipendenze in `tasks.md`):
- **Schermate (S1-S4):** per gruppo di pannelli, confronto vero con le schede dell'hub (e2e con hub finto, screenshot affiancato, video) e chiusura dei buchi: «Apri il dettaglio» del Calendario, interruttore «Notifiche» del proxy, comandi che prima stavano solo nella tray (freno, ferma i lavori, budget, chiudi processo).
- **Servizio (R1-R4):** nuovo processo Rust sempre acceso, una porta (`:3336`, quella già scritta in `ANTHROPIC_BASE_URL`: le sessioni non cambiano niente). R1 registra le fotografie JSON di tutto ciò che oggi risponde (hub, account, proxy) e il confronto vecchio contro nuovo; R2 porta ciò che deve restare sempre acceso; R3 le letture per tray e ponte; R4 proxy e account.
- **Scambio (C1-C2):** i chiamanti (`settings.json`, `.zshrc`, jcode, script, hook, ponte di Topics) passano al servizio nuovo con `:3360` e `:3335` come alias dello stesso processo; poi `:3360/` rimanda a Topics. Il vecchio resta pronto.
- **Tray (Y1-Y2):** la tray di Topics prende dati dal servizio (anche a finestra nascosta, anche a Topics riavviato) e mostra barra con le quote, macchine, progetti, automazioni, backup, freno, processi.
- **Spegnimento (Z1):** vecchi processi fermati a barra verde, con ritorno indietro in meno di un minuto.

## Scelte tecniche (le ho prese io)
- Porta unica `:3336`; `:3360`/`:3335` restano alias dello stesso processo finché i chiamanti non sono tutti passati (cron di chiusura a 24 ore di silenzio).
- Codice del servizio nel repo jarvis, `tools/usage-hub/rust/` (continua `hub-core`: 1.891 righe, 2,2 MB, già con le fotografie): legge stato personale e il repo di Topics è pubblico. Topics ne è cliente: ponte, tray, schermate.
- La tray vive in Topics.app (come hai detto): l'app Tauri non riparte con il server, e i dati li prende dal servizio, non dal server Bun. Se si chiude l'app, sparisce: già vero per la tray di oggi di Topics.
- Il servizio parla solo a localhost e non scrive niente che il vecchio non scrivesse; un solo scrittore dello stato del proxy.

## Barra
Dettagli in `specs/acceptance.md`: le fotografie coincidono (`golden-diff` esce 0), il footprint del servizio resta sotto 60 MB dopo il soak, `:3360` e `:3335` rimandano o rispondono dal nuovo, la tray vecchia non è caricata, e2e per gruppo di pannelli, screenshot affiancati per il tuo ok a vista, e `rollback` che riporta il vecchio con la barra ancora verde.

## Fuori
Non si rifanno le schermate di `hub-smistamento` (si verificano e si completano); il proxy delle sessioni esterne (`proxy/sessioni-esterne`, `:3350`) resta com'è; nessun nuovo disegno; «Attività Claude Code a 14 giorni» (fonte sparita); Windows e Linux (l'hub è solo Mac); il passaggio di OpenClaw (altra change).

## Da decidere
1. **Un solo sì per scambio e spegnimento (C1, C2, Z1)**: tocca `settings.json`, launchd e le porte, tutto di notte e a barra verde, con i vecchi processi pronti a tornare; il sì nomina le azioni e la condizione («fotografie uguali, soak pulito»). Consigliato: sì, un pacchetto, perché le sessioni vive passano da `:3336` e due sì a metà lasciano mezzo scambio. Alternativa: un sì per traccia.
2. **Barra dei menu**: disegnata come immagine a runtime con le colonne per account (consigliata: tiene il colpo d'occhio di oggi) o solo icona e numero con le quote nel menu (più semplice, meno fedele).

## Non ancora specificato
- Come si installa il servizio su un'altra macchina di Topics (oggi solo la tua): per ora launchd locale, nessun file nel bundle pubblico.
- Se il proxy degli account in Rust regge il refresh dei token OAuth senza un secondo scrittore: lo dice il soak di R4.
