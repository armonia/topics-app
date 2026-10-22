# T8 - Un runner che non e' sempre questo Mac

**GOAL.** Dove gira un agente e' una scelta di prima classe del dispatcher:
locale, PC Windows, cloud. La macchina che ospita Topics resta usabile.

## Perche' ora

E' il fallimento piu' documentato del progetto, e non e' ipotetico. Dalle schede
di memoria: «Mac inusabile, Attilio ha fermato a mano», «un heavy in volo ferma
OGNI board, in silenzio», «carico guardato sulla CPU, la macchina muore di RAM».
Misurato ora: 32 GB, swap **15.112 su 16.384 MB**, 121 stalli dell'event loop
oltre 1 s in 4,5 giorni, load1 mediano 16 su 12 core.

I freni esistono e sono sette, su unita' diverse
(`task-dispatcher.ts:4990-5050`): drain, pavimento disco 12 GB, pavimento RAM 12
GB per CLI e 6 GB nativo su finestra di 2 minuti di `vm_stat`, tetto di spesa
24h (nasce spento), pressione «per risorse» in core-unita', tetto a numero
(`cores/3` clamp 2..6), gate peso HEAVY. La RAM guarda **solo l'ammissione**: il
pavimento di 12 GB coincide col punto di lavoro di questa macchina, quindi o
blocca tutto o non blocca niente.

`offload` sa gia' scegliere fra Mac e PC, ma vive **fuori dall'app**: il
dispatcher non lo conosce.

## Cosa cambia

1. `runner` come concetto del dispatcher: `locale | pc | cloud`, scelto per card
   o per policy di board. L'ACP provider e' gia' un processo con N sessioni
   persistite su disco: e' la base giusta per il trasporto.
   **Ordine deciso il 22/10: prima `pc`, poi `cloud`.** `offload` sa gia'
   scegliere fra Mac e PC e il PC e' pagato; il cloud ha un costo per giro e
   oggi il credito resta sotto la riserva di 50 $ per account. Il trasporto si
   scrive una volta per entrambi, ma si prova sul PC.
2. I sette freni si riducono a due leggibili: un budget unico in core-unita' e
   GB con il costo **misurato** per card, e un pavimento di sicurezza calcolato
   da `totale meno la RAM del lavoro umano misurata`, non come costante.
3. La RAM si misura in volo per sessione, e quando la compressione cresce si
   ferma l'ammissione **e** si sospende la prossima ripresa.
4. Le colonne morte (`max_load_ratio`) si eliminano con una migration.

## Barra

- Con 5 card in volo per 30 minuti su una board di prova, `sysctl vm.swapusage`
  resta sotto 1 GB e `memhog --why` non mostra Topics oltre `budget x RAM`.
- `/usr/bin/grep -rn max_load_ratio server shared client/src` fuori dalle
  migration da' 0 usi.
- `bun scripts/runner-parity.ts`: la stessa card gira su locale e su PC con lo
  stesso esito.

## Fuori

Il tetto «per numero». Il proprietario l'ha rifiutato due volte: la forma giusta
e' un budget in percentuale di risorse.
