# Il pavimento dei check smette di essere una costante

## Da decidere

> Blocco incollato in chat il 17/09/2026 alle 19:12 e risposto alle 19:30.
> La risposta esatta e' registrata in `.openspec.yaml`.

```
1. (consigliata) Pavimento 6 → 3 GB: copre il comando piu' caro misurato
   (lint a freddo, 1,91 GB) con margine, e smette di essere una tassa fissa.
2. Alternativa: resta 6 GB, e ogni giro continua a pagare fino a 3 minuti
   per una soglia tarata su un albero unit che oggi non esiste piu'.
3. La riga `gate` di dancerooms lancia `pnpm verify:all`, che in quel repo
   NON esiste (solo `verify` e `verify:product`): rossa a ogni giro da giorni,
   ed e' la ragione scritta per tenere i 6 GB. La correggo a `pnpm verify`
   (consigliata) o la tolgo?
4. Niente cancellazione del pavimento, niente picco al posto dell'ultimo
   campione nel freno swap: refutate, chiudo le due strade.
```

Risposta: **1**, con una richiesta in piu' — «configuriamolo allora bene in
termini di ui». Il punto **3 non e' stato risposto e resta fuori da questa
change**: la riga di `dancerooms-intq6i` non si tocca qui.

## Perche'

Il freno davanti a un comando di check confronta la memoria libera con un
pavimento e, sotto quel numero, trattiene il comando prima di lanciarlo. Il
numero e' `DISPATCH_MEM_FLOOR_NATIVE_GB` = 6 GB, una costante, montata una volta
per tutto il server (`server.ts:2578`).

**Quei 6 GB non sono stati scelti per i check.** La costante e' il pavimento
dell'AMMISSIONE di un agente (`dispatch-capacity.ts:329`, accanto a
`GB_PER_AGENT_NATIVE = 1.5`), tarata su quanto spazio serve per ammettere una
sessione in piu'. Il freno dei check se l'e' presa in prestito, e la stessa cifra
significa oggi due cose diverse.

**Quanto costa davvero un comando di check, misurato.** Campionando l'albero di
processi ogni 250 ms (somma di `phys_footprint` via `proc_pid_rusage`, lo stesso
primitivo di `fleet-usage.ts:173`), un comando alla volta con `nice -n 10`:

| comando | picco a freddo | picco a caldo |
| --- | --- | --- |
| `bun run lint` | **1,91 GB** | 0,53 GB |
| `bun run typecheck` | 1,31 GB | 0,77 GB |
| `static-rails` (11 check in catena) | 0,31 GB | — |
| `bun run check:deadcode` | 0,33 GB | — |

Il valore che conta e' quello a FREDDO: `.cache/checks` non e' tracciata, quindi
la worktree di un agente parte sempre senza cache. Lo strumento del server, che
campiona a 3 s, non ha mai letto oltre **1,1 GB** in 1828 battiti.

**Quindi il pavimento e' tre volte il peso che governa**, e il conto sul log lo
mostra: su 1828 letture `[memsig]`, `held2m` sta sotto i 6 GB l'**86,2%** del
tempo e non e' MAI sceso sotto **2,7 GB**. Ogni giro di check paga fino a 3
minuti di valvola per una condizione che su questa macchina non ha mai descritto
una vera penuria.

**Due strade sono state chiuse da una verifica avversaria, e vanno dette qui
perche' non tornino.** *Cancellare il pavimento* e' stato refutato: rigiocando le
1828 letture dentro `releaseDecision`, fra `floorGB: 6` e `floorGB: 0` la
decisione cambia in **1157 casi (63,3%)**, tutti a `swap=calm`, e quei casi hanno
uno stato macchina misurabilmente peggiore (swap p50 7,8 GB contro 3,4 dove il
pavimento lascia passare). Il pavimento e' l'unico freno vivo dove lo swap tace.
*Far leggere al freno swap il PICCO invece dell'ultimo campione* e' stato
refutato a sua volta: quello che un SIGKILL restituisce e' il footprint corrente,
non il picco di due secondi prima, quindi la «correzione» avrebbe ucciso giri per
un guadagno inesistente.

**E il numero non torna a essere una costante.** L'audit ha trovato che la
giustificazione scritta nell'intestazione del freno — la board
`dancerooms-intq6i` dichiarerebbe `pnpm verify:all --only typecheck,unit`,
«esattamente l'albero da 4-11 GB che questo freno esiste per tenere fuori» — e'
falsa: in quel repo esistono solo `verify` e `verify:product`, e quel comando
esce 254 in 275 ms consumando 2 MB. Un numero difeso da una ragione inventata a
posteriori e' un numero che nessuno puo' correggere quando cambia il carico. Per
questo diventa un'impostazione visibile, con accanto il carico misurato che la
giustifica.

## Cosa cambia

- Il pavimento dei check e' un'impostazione della MACCHINA sulla riga `'*'` di
  `board_settings`, accanto a `machine_budget_share`, con default **3 GB**.
- `0` spegne il freno: nessun comando aspetta piu' per memoria.
- Si configura nella sezione globale del pannello impostazioni della board, dove
  gia' stanno il tetto e la fetta di macchina.
- Il mount la rilegge a ogni attesa: cambiarla ha effetto senza riavviare.
- L'intestazione del freno perde le due affermazioni false (il gate di
  dancerooms, e il «tsc 460 MB / vite 316 MB» che non ha nessuna misura dietro).

## Fuori

- La riga `gate` di `dancerooms-intq6i` (punto 3, non risposto).
- Il freno swap: nessuna modifica, refutata.
- Il prezzo per comando (listino appreso, `peakGB` in `checks_json`): il costo
  massimo che un prezzo esatto puo' far risparmiare e' la valvola calma, 3 minuti
  per giro, e non vale la macchina che servirebbe a impararlo.
- `DISPATCH_MEM_FLOOR_GB` (12 GB, agenti CLI) e `DISPATCH_MEM_FLOOR_NATIVE_GB`
  come pavimento dell'AMMISSIONE: restano dove sono, questa change tocca solo chi
  li leggeva per i check.
