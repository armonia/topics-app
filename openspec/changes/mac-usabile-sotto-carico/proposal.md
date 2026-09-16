# Proposal: mac-usabile-sotto-carico

> Approvata il 2026-09-15 (vedi `.openspec.yaml`): le quattro scelte sotto sono
> le risposte del proprietario, date in chat.

## Da decidere

Il Mac resta inusabile con la board al lavoro: 4 scelte prima del codice.

1. Gli e2e degli agenti girano solo in CI, come test:unit dal 04/09 (o: in locale ma dietro slot e memoria). **Risposta: solo in CI.**
2. Un giro di check già partito con il Mac in swap lo interrompe Topics da solo, come interrotto e mai rosso (o: solo attesa del lavoro nuovo). **Risposta: «dovrebbe farlo da solo».** E il 15/09 alle 20:40, sui processi pesanti che gli agenti lanciano nelle topic: «freezza il piu pesante mostrando un effetto di congelamento figo sulla card realistico». Un comando in PRIMO PIANO di Claude Code non si congela (il suo CLI lo uccide su un orologio che durante il fermo continua a correre): si congela il più pesante in background.
3. Un pannello browser che consuma molto si segnala, resta vivo solo col fuoco e si congela con una buona UI (o: sempre vivo). **Risposta: «se è consumo elevato magari lo segnaliamo e la attiviamo solo al focus e freeziamo con buona ui».**
4. Il browser remoto degli agenti passa da Chromium a WebKit sul Mac, con una card (o: resta Chromium). **Risposta: card per WebKit.**

«ok» = tutte le consigliate.

## Why

Il 15/09/2026, con la board al lavoro, il Mac è arrivato a load 253, 12,7 GB di
swap e 9,5 GB nel compressore. Il server di Topics si è fermato fino a 146 s di
fila. Misure raccolte quel giorno (indagini multi-agente con verifica
avversaria, script nello scratchpad della sessione):

- **Il pavimento di memoria si riapre su una lettura sola.** `availableMemGB` è
  per il 90% pagine file-backed: sotto thrash resta fra 3,3 e 5,7 GB e schizza
  quando un albero di processi esce (14,5 GB con 12 GB di swap). Le tre
  riaperture del 15/09 sono state seguite da un nuovo blocco entro 19-115 s.
  L'attesa dei check si libera alla prima lettura sopra 6 GB, senza il prezzo
  del comando (gli shard unit pesano 4-11 GB).
- **Il lavoro già partito non ha freni.** Né i giri di check né i Chromium
  lanciati dal browser remoto per gli agenti (10:51 e 10:56, con il load che
  saliva da 49 a 215).
- **Gli agenti lanciano da sé il lavoro più pesante.** In 15 ore: 21
  `check:e2e-touched`, 71 `playwright test`, 27 build del client, 99 su 119 in
  background (fuori dalla portata del kill del turno). La board poi li rifà
  alla consegna.
- **Le card in coda riscrivono il proprio stato ogni 5-6,75 s.** Ogni retry di
  un resume trattenuto riscrive `dispatch_error` con la lettura di memoria del
  momento, tocca `updated_at` e trasmette `task:updated` a tutti i client:
  circa 70 frame al minuto con 7 card ferme, che nel client rifanno l'albero e
  il menu della barra.
- **Un pannello browser animato costa quasi mezzo core anche con Topics dietro.**
  La home di armonia-site su :4600 (nuvole e shader 3D): 16,9% di WebContent più
  27,5% di GPU, con Mail in primo piano.
- **Già corretto nello stesso giorno, fuori da questa change:** le statistiche
  della rubrica ricalcolate ogni minuto (35% del tempo di loop fermo, PR #62) e
  le riscritture del localStorage (WAL da 6,9 GB, PR #61).

## What Changes

1. **Coda senza tempesta.** Un resume trattenuto riscrive e trasmette lo stato
   della card solo quando il motivo cambia davvero, non a ogni lettura.
2. **E2E degli agenti in CI.** L'envelope vieta agli agenti `check:e2e-touched`,
   `playwright test` e le build del client fatte per gli e2e; la prova e2e di
   una consegna viene dalla CI del ramo, non da Chromium sul Mac.
3. **Segnale di memoria onesto e freno sul lavoro in volo.** Il pavimento si
   riapre solo se la memoria resta sopra la riga per una finestra di tempo, con
   il prezzo di ciò che si libera; al boot la finestra non ammette finché non è
   piena. Con swap sostenuto Topics interrompe da solo il giro di check più
   giovane (interrotto, mai rosso, riparte da solo) con limiti che impediscono
   di fermarlo per sempre. Sempre sotto swap sostenuto, il comando più pesante
   che un agente ha lanciato in BACKGROUND (o che il runtime nativo sta
   eseguendo per lui) viene congelato con un SIGSTOP finché non c'è memoria, al
   massimo 10 minuti e al massimo due volte per albero, e la sessione si copre
   di brina in modo che si veda dalla board. Mai il server, mai un CLI, mai un
   comando in primo piano.
4. **Pannelli browser pesanti.** Topics misura il consumo di ogni pannello
   nativo; un pannello sopra soglia si segnala, resta vivo solo col fuoco e si
   congela su un fermo immagine con una UI chiara, e torna vivo senza
   ricaricare.
5. **Browser remoto degli agenti su WebKit**: card separata.

## Non-Goals

- Le app fuori da Topics (Dia, l'app Claude, un `git gc` di un'altra sessione):
  nessuna modifica del server le toglie.
- Riscrivere il dispatcher o il modello di prezzo delle card.
- Un freno che congela i CLI degli agenti o i loro comandi in PRIMO PIANO: un
  CLI fermato a metà stream perde la connessione, e un comando in primo piano
  scade sull'orologio del suo CLI mentre è fermo (SIGSTOP non restituisce
  memoria e non ferma le scadenze altrui: provato e ritirato per la memoria,
  `shared/machine-budget.ts`). Quello che si congela è un comando in background,
  che nessun orologio sta guardando.
