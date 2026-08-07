# Change: task-sharing-guests

## Why

Condividere un task con un'altra persona ha due metà, e vanno separate perché una
è pronta e l'altra richiede una decisione che non è tecnica.

**Il PERMESSO** — chi può vedere cosa. Oggi non esiste: l'identità costruita con
`device-auth` distingue *quale dispositivo*, ma tutti i dispositivi sono del
proprietario e vedono tutto. Non c'è modo di dire «questo task sì, il resto no».
Questa metà si costruisce sopra ciò che c'è, senza niente di nuovo sotto.

**La RAGGIUNGIBILITÀ** — come fa l'altra persona ad arrivare al tuo server. Sulla
LAN significa che è in casa tua. Fuori serve un relay, ed è ciò che il task di
backlog chiama per nome: *«identità utente + relay condiviso … hosting: Hetzner»*.
È una decisione di infrastruttura e di spesa, non un'implementazione.

Questa change fa la prima e **non** la seconda. Il motivo di separarle è che la
prima è utile anche da sola — un collega seduto alla tua scrivania, un secondo
computer di casa, una persona sulla stessa rete dell'ufficio — mentre la seconda
senza la prima sarebbe esattamente il tunnel che abbiamo appena rimosso: esposizione
senza permessi granulari.

## What changes

**I dispositivi acquistano un ruolo.** `owner` (i tuoi: vedono tutto, come oggi) e
`guest` (vedono **solo** ciò che gli è stato condiviso). Il ruolo si sceglie al
momento dell'approvazione: la stessa schermata che oggi chiede «Autorizza / Nega»
chiede anche «come tuo dispositivo» o «come ospite». Default `owner`, perché il
caso normale è il tuo secondo telefono.

**Un task si condivide con un ospite.** Una tabella `task_shares` lega un task a un
dispositivo ospite. Nessun concetto di «utente»: l'ospite È il dispositivo, il che
è coerente con `device-auth` e non introduce un secondo modello di identità che
poi va tenuto in sincrono col primo.

**Il filtro sta nel server, non nella UI.** Le rotte che elencano task filtrano per
ruolo prima di rispondere. Nascondere lato client sarebbe una tenda davanti a una
porta aperta: un ospite che apre gli strumenti di sviluppo vedrebbe tutto.

**L'ospite vede un'app ridotta.** Niente board globale, niente progetti, niente
terminali: solo i task condivisi, in sola lettura, col loro thread e le loro
anteprime. È il minimo che rende la condivisione utile senza consegnare la
macchina.

## Out of scope — e perché

- **Il relay / hosting.** Un ospite deve poter *raggiungere* il server. Oggi:
  stessa rete. Fuori serve un relay, che è la decisione che il backlog attribuisce
  a Hetzner. Finché non c'è, questa change è utile in casa e in ufficio.
- **Account e login.** L'ospite è un dispositivo, non una persona. Quando arriverà
  l'identità del proprietario (il login del computer, vedi `device-auth` §6.3)
  potrà firmare *chi* ha condiviso, ma non cambia questo modello.
- **Permesso di SCRIVERE.** Il backlog lo prevede («owner può promuovere un amico a
  può-scrivere»), e va tenuto fuori di proposito: un ospite che scrive in un thread
  o in un terminale è una superficie completamente diversa, e va progettata quando
  il caso esisterà davvero. Qui si legge e basta.
- **Presence cross-device e flag incognito**: due voci separate dello stesso task di
  backlog, indipendenti da questa.

## Risks

1. **Un ruolo sbagliato al momento dell'approvazione è un accesso pieno.** La
   schermata deve rendere la differenza impossibile da fraintendere, e il default
   (`owner`) è il caso normale ma anche il più permissivo. Mitigazione: la scelta è
   esplicita nel cartello di approvazione, e il pannello Dispositivi mostra il ruolo
   di ogni riga così un errore si vede e si corregge.
2. **Il filtro va messo in OGNI rotta che serve dati di task**, non solo
   nell'elenco: il thread, le anteprime, gli allegati. Una dimenticata è il buco.
   Mitigazione: il filtro entra in un punto unico che le rotte attraversano, non
   copiato in ognuna — è la stessa lezione di `resolveProjectPath`, il cui commento
   dice «il fix sta QUI e non sui 47 chiamanti: metterlo lì significherebbe
   dimenticarne uno, e quello dimenticato sarebbe il buco».
3. **Un ospite resta un dispositivo autorizzato.** Se il filtro ha una falla, ha
   accesso a un server che esegue comandi. Il perimetro vero resta la revoca, che
   c'è ed è immediata.


## Stato al 2026-08-06 — consegnato

**Il modello è uno**: `grants(subject_type, subject_id, resource_type,
resource_id, level, via)`, migration `083`, righe di `task_shares` travasate.
Soggetto `device` oggi; `person` e `org` si aggiungono con un valore nell'enum e
una tabella di risoluzione, non un secondo sistema d'accessi.

**Condivisibili**: `task` e `topic`. **Non** Spazi e tab, e un test lo fissa: non
hanno una riga a cui appendere il permesso — vivono in un blob JSON da 56 KB in
una riga sola di `ui_state`, riscritta tutta intera con un CAS. Promuoverli a
righe è lavoro di fondamenta, non una voce in un enum.

**Il gesto c'è**: `ShareControl` accanto allo stato del task, generico sul tipo di
risorsa, con la provenienza mostrata e il caso «nessun ospite» che dice dove
crearne uno.

**Tre errori miei, trovati e chiusi costruendo** — valgono più del resto perché
sono la stessa forma sbagliata ripetuta:
1. il filtro ospite messo nel **router dei task**: un ospite leggeva `/api/topics`
   per intero. Il posto era il gate.
2. `/api/topics` (la LISTA) messa in allowlist: un endpoint che restituisce un
   INSIEME non è filtrabile da un gate, che vede il percorso e non il corpo.
   Sostituita da `/api/auth/shared`, che parte dalle concessioni e quindi non ha
   niente da perdere.
3. l'allowlist dei frame WS scritta a memoria: `task:comment` e `stream:delta`
   non esistono. Un tipo inventato non è un errore rumoroso, è un aggiornamento
   che non arriva mai. Ora un test confronta ogni voce col registro.

**La vitalità è tornata**: `/ws` era stato chiuso per confinare l'ospite, e il
prezzo era che ogni cosa condivisa diventava una fotografia. Ora il socket è
aperto e il contenuto filtrato — prima per tipo (10 frame su 91: solo 39 portano
un id di entità, quindi affidarsi all'id lascerebbe passare gli altri 52), poi
per entità.

### Resta aperto

- **Organizzazioni e persone.** ~~Richiedono l'identità del proprietario…~~
  **Ripreso dalla change `sharing-orgs`.** La premessa qui sotto — «con un
  proprietario solo, persona e dispositivo sono la stessa informazione» — era
  vera finché il prodotto era di uno. Da quando si vende a singoli **e a team**
  smette di esserlo: un collega ha due dispositivi, e condividere con il portatile
  ma non col telefono non è una cosa che qualcuno voglia dire. La persona diventa
  il soggetto, e il dispositivo resta la credenziale d'accesso.
- **La raggiungibilità**: un ospite deve poter arrivare al server. Sulla LAN vuol
  dire che è in casa. Fuori serve il relay — decisione di infrastruttura, non
  implementazione. **Aggiornamento**: la forma è stata decisa — piano di controllo
  centrale (account, org, licenze, coordinamento), piano dati locale. Resta da
  scegliere dove termina il TLS.
- [x] **La vista dell'ospite.** Fatta: `SessionRoot` decide alla RADICE cosa si
  monta — cancello, vista ospite o app — e `GuestView` dispone schede e chat da
  `/api/auth/shared`, col caso vuoto che dice che è normale. La forma sbagliata
  era stata provata: montare la vista ospite SOPRA l'app la copre ma non la
  spegne, e ogni pezzo sotto continuava a chiedere al server cose che il gate
  nega — una schermata piena di errori, che un ospite legge come «è rotto».
- **Contenitori**: condividere un progetto e vederne i task arrivare in blocco.
  Il campo `via` esiste apposta, ma «progetto» oggi vuol dire quattro cose
  diverse (7 righe in `projects`, 19 slug nei task, 385 percorsi nei topic, 38
  aperti davvero): va unificato prima.
