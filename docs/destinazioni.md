# Dove va a finire il lavoro

Le destinazioni di questo repo, dichiarate. Il documento nasce da una domanda
precisa: «alla approvazione dovremmo fare direttamente deploy, ed è da capire a
livello di UI come gestirla, perché potremmo avere locale e remoto, dev/stage
prod».

La risposta comincia da un fatto misurato, non da un'architettura desiderata.

## Quante destinazioni esistono davvero

**Due**, e non sono ambienti dello stesso sistema. Sono due prodotti diversi con
due pubblici diversi.

| destinazione | cosa ci arriva | come | chi decide |
|---|---|---|---|
| **app** | gli installer di Topics, all'auto-updater di chiunque l'abbia aperta | automatico: push su `main` → CI verde → `auto-bump` → `tauri-release` | il gesto «Pubblica», poi la CI |
| **landing** | il sito pubblico (Cloudflare) | manuale: `bun run deploy:landing` | una persona, a mano |

Non esiste `dev`, non esiste `stage`, non esiste `prod`. Non nei quattro
workflow, non negli script, non nello schema. Cercarli e non trovarli è la
misura che rende questo documento onesto: **non abbiamo tre ambienti, ne
abbiamo due destinazioni**.

## I tre punti che la card chiedeva di decidere

### 1. Ambienti o macchine?

**Due assi distinti, e oggi il secondo ha un solo valore.**

- L'asse *destinazione* dice **cosa** esce (app, landing).
- L'asse *macchina* direbbe **dove** gira, e oggi ha un valore solo: la
  macchina di chi lavora. Il server locale e quello «remoto» sono la stessa
  cosa vista da due schermi, non due ambienti: stesso codice, stesso DB, stessa
  porta.

Tenerli separati costa una riga adesso e impedisce «prod locale», che non
vuol dire niente. Fonderli produrrebbe una matrice 2×3 di caselle vuote.

### 2. Il deploy alla approvazione è automatico?

**Sì per l'app, no per la landing, e l'asimmetria è voluta.**

Per l'app la policy «main è sempre spedito» è una scelta esplicita, e il
cancello CI→release (`af8efda5`) l'ha resa più forte: un merge sano è
condizione necessaria per spedire. Chi approva e pubblica **sta pubblicando a
tutti**, e da oggi la schermata glielo dice prima del clic (`79891622`).

Per la landing no: è un sito pubblico che cambia raramente, il comando esiste
(`deploy:landing`, con la sua prova a secco) e non c'è nessuna coda di lavoro
che lo chieda. Automatizzarlo aggiungerebbe un cancello da sorvegliare per
risolvere un problema che nessuno ha.

### 3. Cosa vede chi approva

**La destinazione si dichiara prima del gesto, non si scopre dopo.**

Già fatto per l'unica destinazione automatica: il pannello di pubblicazione
dice che il push fa uscire una release e che arriva a tutti in ~15 minuti, e i
tooltip del land dicono «nessun push, quindi nessuna release». Il gesto e la
sua conseguenza stanno nella stessa schermata.

## Cosa NON si fa, e perché

**Nessun campo `environment` sulle card.** È la trappola già pagata con
`board_settings.auto_dispatch`: una colonna che sembrava una scelta e non lo
era, letta due volte come deliberata quando era un default, e infine rimossa
(`7a86b3fa`). Un campo «ambiente» che nasce con un valore plausibile e che
nessuno scrive è lo stesso errore con un altro nome.

Il campo si aggiunge il giorno in cui esiste una **seconda** destinazione per
lo stesso artefatto — cioè quando la domanda «dove va questa card?» ha più di
una risposta possibile. Oggi ne ha una sola, e una scelta con un'opzione sola
non è una scelta: è un modulo da compilare.

## Come si verifica

`tests/unit/destinazioni.test.ts` legge questo documento e lo confronta con il
repo: le destinazioni dichiarate qui devono esistere davvero negli script e nei
workflow, e le destinazioni che il repo ha devono essere dichiarate qui. Il
giorno che qualcuno aggiunge un deploy senza scriverlo, o scrive qui un
ambiente che non esiste, il cancello lo dice — che è l'unico modo perché un
documento come questo non diventi una fotografia di com'era.
