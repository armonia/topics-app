# Delta: kanban (pavimento-check-configurabile)

## MODIFIED Requirements

### Requirement: KANBAN-15 — Prima della review i comandi girano, e un rosso che non ha misurato niente non è un rosso

Il requisito resta quello che e'. Cambia una frase sola, quella che inchiodava il
pavimento a una costante:

> Un comando NUOVO NON SHALL partire con la memoria libera sotto il pavimento
> (`DISPATCH_MEM_FLOOR_NATIVE_GB`, 6 GB).

diventa:

**Un comando NUOVO NON SHALL partire con la memoria libera sotto il pavimento, e
il pavimento SHALL essere un'impostazione della macchina e non una costante.**
Vive sulla riga riservata `'*'` di `board_settings`, accanto a
`machine_budget_share`, perche' il freno e' montato una volta per tutto il server
e non per board: una board che ne chiedesse uno proprio chiederebbe una cosa che
il freno non sa fare. Default **3 GB**, intervallo **0-16 GB**, passo 1 GB.
**`0` SHALL spegnere il freno**: nessuna attesa per memoria, il ramo `room` non
si presenta mai. Un valore fuori intervallo o non numerico SHALL essere stretto
come lo e' gia' `machine_budget_share`, con la STESSA funzione condivisa fra
gate, route e slider, mai con tre copie della regola.

**Il valore SHALL essere riletto a ogni attesa, non catturato al boot.** Il mount
(`server.ts`) passa una funzione, non un numero: cambiarlo dalla UI ha effetto
sul giro successivo senza riavviare il server. La decisione pura
(`releaseDecision`) continua a ricevere un NUMERO, cosi' resta testabile sugli
stati sintetici che ha oggi: la funzione sta nel mount, non nella decisione.

**Il default e' 3 GB perche' e' misurato, e la misura sta qui perche' la
prossima persona possa correggerlo invece di ereditarlo.** Campionando l'albero
di processi ogni 250 ms, un comando alla volta: `bun run lint` a freddo **1,91
GB** (il piu' caro di tutta la macchina), `typecheck` a freddo 1,31 GB,
`static-rails` e `check:deadcode` 0,31-0,33 GB. A caldo costano un terzo, ma il
valore che conta e' quello a freddo: `.cache/checks` non e' tracciata, quindi la
worktree di un agente parte sempre senza cache. Lo strumento del server, che
campiona a 3 s, non ha mai letto oltre 1,1 GB in 1828 battiti. Tre gigabyte
coprono il comando piu' caro misurato con oltre un gigabyte di margine.

**Perche' 6 era sbagliato, e non e' un dettaglio storico.**
`DISPATCH_MEM_FLOOR_NATIVE_GB` e' il pavimento dell'AMMISSIONE di un agente,
tarato accanto a `GB_PER_AGENT_NATIVE = 1.5` su quanto spazio serve per ammettere
una sessione in piu'; il freno dei check se l'e' preso in prestito. Su 1828
letture `[memsig]`, `held2m` sta sotto 6 GB l'**86,2%** del tempo, quindi ogni
giro pagava fino a 3 minuti di valvola calma quasi sempre. A 3 GB le letture
trattenute scendono all'**1,0%**, e `held2m` non e' mai sceso sotto **2,7 GB** in
tutto il log.

**E la ragione scritta per tenere i 6 GB era falsa.** L'intestazione di
`review-checks-brakes.ts` sosteneva che la board `dancerooms-intq6i` dichiara
`pnpm verify:all --only typecheck,unit`, «esattamente l'albero da 4-11 GB che
questo freno esiste per tenere fuori da un Mac vuoto». In quel repo esistono solo
`verify` e `verify:product`: quel comando esce 254 in 275 ms consumando 2 MB, ed
e' rosso a ogni giro da giorni. Anche il «tsc 460 MB, vite 316 MB» dello stesso
file non ha nessuna misura dietro. **L'intestazione SHALL dire quello che e'
misurato e nient'altro**: un numero difeso da una ragione inventata a posteriori
e' un numero che nessuno correggera' quando il carico cambia.

**DUE STRADE SONO STATE CHIUSE DA UNA VERIFICA AVVERSARIA, e restano chiuse.**

*Cancellare il pavimento* e' stato refutato eseguendolo: rigiocando le 1828
letture dentro `releaseDecision`, fra `floorGB: 6` e `floorGB: 0` la decisione
cambia in **1157 casi, il 63,3%**, tutti a `swap=calm`, e quei casi hanno uno
stato macchina misurabilmente peggiore (swap usato p50 7,8 GB contro 3,4 dove il
pavimento lascia passare). Il pavimento e' l'unico freno che decide qualcosa
nei due terzi di log in cui lo swap tace: `createSwapBrake` vuole un verdetto
`sustained`, e sostenuto non lo e' quasi mai.

*Far leggere al freno swap il PICCO del run invece dell'ultimo campione* e' stato
refutato a sua volta, e conviene scriverlo perche' sembra una correzione ovvia.
Quello che un SIGKILL restituisce e' il footprint CORRENTE, non il picco di due
secondi prima: `treeFootprintKB` somma `phys_footprint`, cioe' residente piu'
compresso, ed e' esattamente cio' che l'albero tiene adesso. Un `tsc` che ha
piccato 1,31 GB e ora sta a 0,4 restituisce 0,4: scartarlo e' giusto, e leggere
il picco avrebbe ucciso giri per un guadagno inesistente, bruciando uno dei due
tentativi che una consegna ha.

Il resto del requisito — l'attesa che non consuma il tetto del comando, il
fallimento aperto a 30 minuti in totale, la valvola calma da 3 minuti, i due
orologi separati, la lettura non disponibile che non fa aspettare — **non
cambia**.

## ADDED Requirements

### Requirement: KANBAN-90 — Un numero che frena il lavoro si configura e dice su quale carico è tarato

**Il pavimento memoria dei check SHALL comparire nella sezione globale del
pannello impostazioni della board**, accanto al tetto degli agenti e alla fetta
di macchina, perche' e' dello stesso tipo: vale per tutto il server, non per la
board da cui il pannello e' aperto. SHALL essere un campo numerico in GB con
`min` 0 e `max` 16, e SHALL salvarsi come si salvano gia' gli altri due — PATCH
sulla rotta globale, adozione ottimistica con lo stesso clamp del server,
broadcast agli altri client aperti.

**SHALL dire accanto a quale carico copre, non solo il numero.** Un pavimento
nudo e' la cosa che ha prodotto i 6 GB: una cifra senza provenienza che nessuno
osa toccare. La riga di aiuto SHALL nominare il comando di check piu' caro
misurato e il suo costo, cosi' che chi alza o abbassa il numero veda subito
contro cosa lo sta mettendo.

**`0` SHALL essere leggibile come «spento», non come «zero gigabyte».** Un campo
numerico che a zero cambia natura deve dirlo: il testo accanto SHALL cambiare, e
non SHALL servire aprire il codice per sapere che cosa fa quel valore.
