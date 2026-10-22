# giornata-condivisa: Topics tenuto da tre persone su sei dispositivi, senza toccare la macchina che lo ospita

Successore di `daily-driver`, che ha chiuso il suo arco: D0-D7 hanno 45 report su
`origin/main` e D8 dichiara i sei problemi del browser chiusi in produzione dalla
2.2.507 e dalla 2.3.2. Quel piano puntava a «meglio dell'app di Claude Code per
chi lo sviluppa». Questo punta al gradino dopo: **altre persone, altri
dispositivi, e un mantainer che non deve essere in piedi.**

## Deciso dal proprietario, 22/10/2026

Le quattro risposte stanno anche in `.openspec.yaml`.

1. **Condiviso vuol dire persone vere, a scaglioni.** Le fondamenta erano quasi
   finite (`device-auth` 19/20, `sharing-orgs` 29/30, `relay` 18/24) e fermarsi
   ai dispositivi le avrebbe buttate. T7 vale cinque tracce e tocca dati di
   persone vere.
2. **Un ospite puo' scrivere in una pane viva, con il testimone.** Un solo
   scrittore per volta e passaggio esplicito. Il trasporto esiste gia': il
   lavoro e' il lucchetto sul turno.
3. **Il PC Windows prima, il cloud dopo.** `offload` sa gia' scegliere e il PC
   e' pagato; il cloud resta sotto la riserva di 50 $ per account.
4. **VirtuosoMessageList non si compra.** T9 chiude gli altri quattro buchi
   dell'istantaneita' senza toccare la lista, e le 2.490 righe di
   `MessageList.tsx` restano codice nostro.

## Perche'

Tre fonti, tutte misurate il 22/10/2026.

**1. L'audit di 71 agenti su 12 sottosistemi.** 140 reperti, 13 refutati da un
verificatore indipendente, 8 restano gravi dopo la refutazione. Due sono falle
**aperte** dell'asse d'origine, riprodotte sul server di produzione: la
descrizione sta in una nota privata del proprietario e non in questo repository,
che e' pubblico, come ha fatto `D8` finche' i suoi problemi erano aperti. Quello
che si puo' dire qui: il premio non e' una lettura, e la probabilita' cresce ogni
giorno che un agente lavora su questa macchina. Dettagli in `tracks/T1-origine.md`.

**2. Il confronto con lo stato dell'arte.** Topics e' **oltre** dove nessuno
arriva: pane vive, terminali, browser nativo e agenti sulla stessa board; link
come capacita' con chiave nel frammento, scadenza obbligatoria e revoca
immediata, piu' severo del default di Figma; sei barre di latenza in CI che
quasi nessuno nella categoria ha. E' **indietro** su tre cose che tutti hanno
risolto allo stesso modo: un solo orologio per tutti i domini, un posto dove far
girare un agente che non sia questo Mac, e uno schema che sappia che esistono
persone.

**3. Lo stato della macchina che lo ospita.** 32 GB, swap a 15.112 MB su 16.384,
121 stalli dell'event loop oltre 1 s in 4,5 giorni, load1 mediano 16 su 12 core.
Un solo Mac fa da server, da macchina di sviluppo e da flotta di agenti.

## Cosa cambia

| Traccia | In una riga |
|---|---|
| T0 trunk | un solo ramo di integrazione: il checkout primario e il land guardano `origin/main` |
| T1 origine | le due falle del cancello d'origine chiuse, ognuna con il suo test rosso prima |
| T2 backup | il DB ha uno snapshot giornaliero verificato da un restore, e una copia fuori disco |
| T3 orologio | un solo contatore autorevole: oplog nella stessa transazione, `sync:since`, seq sui chunk |
| T4 convergenza | il banco di simulazione, poi il pane-sync riscritto sopra di esso |
| T5 isolamento | un processo per file di test: il verdetto non dipende piu' dai vicini |
| T6 guscio | Tauri 2.12.3: advisory multiwebview, coda bloccata, updater che lascia senza app |
| T7 persone | invito per email, ruolo sul link, presenza delle persone, proiezione per l'ospite, audit |
| T8 runner | dove gira un agente diventa una scelta di prima classe, non sempre questo Mac |
| T9 istantaneo | markdown a blocchi, `<Activity>`, View Transitions, latenza misurata dal guscio vero |
| T10 tentativi | tre agenti sulla stessa card, i diff a confronto, la scelta diventa la consegna |
| T11 giudice | la consegna passa da uno scorer, non solo dai cancelli deterministici |
| T12 pulizia | worktree, copie del DB, radice del repo, cancelli che misurano il proprio proxy |

## Barra

`specs/acceptance.md`. Tre parti, come vuole il repo:

1. **I comandi che escono non-zero oggi e zero alla fine**, uno per traccia.
2. **Quattro scenari con video**: la giornata a tre persone su tre dispositivi;
   un invito per email dall'arrivo alla revoca; un riavvio del server a meta'
   turno su tutti e sei i dispositivi; una card corsa da tre agenti e scelta.
3. **Sei mutazioni** che devono far fallire il loro test, perche' un test verde
   su codice rotto non prova niente.

E la regola che vale su tutto: **cio' che e' verde resta verde.** Le 45 barre di
`daily-driver` e i 45 `check:*` non regrediscono.

## Il vincolo che attraversa tutto: meno codice

Deciso dal proprietario il 22/10: **meno codice possibile, cosi' c'e' meno da
manutenere, senza perdere qualita'.** Non e' un aggettivo, quindi ha una misura:
ogni traccia riporta le righe nette di produzione, e chi ne aggiunge dice cosa
cancella in cambio. La base e' 520.184 righe di produzione al 22/10.

Sette delle tredici tracce **cancellano piu' di quanto scrivono**, e non per
caso: sono le stesse dove il difetto e' una toppa che si puo' togliere.

| Traccia | Cosa sparisce |
|---|---|
| T3 | le 15 rotte di lettura periodica, sostituite da un `sync:since`; le tre toppe sul refetch |
| T4 | i 96 call site del ponte, i tre effect, i ref-mirror, il 97,5% del blob che e' storia |
| T5 | i tre cancelli che esistono solo per contenere la contaminazione fra test |
| T6 | tre backend browser dentro `cfg`, sostituiti da un trait; la pane nativa su Linux |
| T8 | cinque dei sette freni di risorsa, e le colonne morte con una migration |
| T11 | i controlli a mano che oggi stanno nelle teste e nelle schede di memoria |
| T12 | 13 `check:*` orfani, le worktree morte, i cancelli che misurano il proprio proxy |

Le altre sei aggiungono, e dicono quanto: T0 e T1 sono correzioni da decine di
righe, T2 e T7 aggiungono una superficie che non c'e', T9 scambia un parser
quadratico con uno a blocchi, T10 e' una vista nuova.

## Fuori

- Riscrivere il prodotto. 743k righe fra server, client e condiviso, 1.932 file
  di test unit e 484 e2e: tutte le 12 mappe dicono «evolvere», e nessuna dice
  «riscrivere l'area». Si riscrivono **quattro moduli** nominati nelle tracce
  (pane-sync, motore del turno in `routeChat`, `lib.rs` del guscio, esecutore
  d'input del browser), non il prodotto.
- Un CRDT. Il server e' unico e autorevole: il verificatore ha refutato
  esplicitamente la tesi del CRDT. Serve un contatore, non una struttura dati.
- Il motore nativo e le sue credenziali, come in `daily-driver`.
- Un'app mobile nativa, e account in cloud con password.
- Telemetria. Nessuna misura di usabilita' si prende dal campo senza consenso.

## Deciso da me

- **L'ordine.** T0, T1 e T2 prima di tutto e in questo ordine: senza un solo
  trunk ogni altra consegna nasce da una base stantia, senza il cancello
  d'origine chiuso ogni superficie nuova e' una superficie in piu' esposta, e
  senza un backup provato nessuna delle migration che seguono e' reversibile.
- **T3 prima di T4.** Il banco di convergenza senza un orologio unico
  misurerebbe la convergenza di un solo dominio.
- **Nessuna libreria di sync infilata di lato.** TanStack DB e simili risolvono
  il sintomo (il refetch) e lasciano il difetto (nessun ordine totale).
- **`server_seq` allocato con `SELECT MAX` si corregge subito**, dentro T3: e'
  mezza traccia ed e' il miglior rapporto valore/costo di tutto l'elenco.
- **Le change aperte non si riscrivono**, si portano a termine dentro la traccia
  che le cita, come faceva `daily-driver`.

## Non ancora specificato

Cose che non sono ancora in grado di chiedere con precisione, e che quindi non
diventano task inventati.

- **Quanti millisecondi vuol dire «istantaneo» fra due dispositivi.** Nessuno
  l'ha mai misurato: in repo non esiste un banco che scriva su A e cronometri la
  comparsa su B. Il numero della barra lo fissa T3 dopo la prima misura, non
  prima.
- **Quanto costa un processo per file di test.** Il 05/09 erano 78 s su 1.149
  file con 6 processi, oggi la suite seriale e' 1.331 s. T5 misura prima di
  scegliere la forma.
- **Se la deriva di geometria delle webview figlie su Windows e' la stessa cosa
  della segnalazione upstream.** Serve un video sul PC, non una lettura.
- **Cosa conta come «buono» per lo scorer di T11.** Le schede di memoria danno
  tre o quattro controlli certi; il resto si scrive dopo averli visti mordere.
