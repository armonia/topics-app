> **Stato (2026-11-20):** costruita solo T1 (`server/lib/primary-role.ts`, ruolo ed epoca). Mancano T0 (`queueAfterRestart` in `task-dispatcher-remote-node.ts` rimette ancora in coda e cancella la corsa invece di riattaccarla), T3 (nessun deposito segreti cifrato in `server/lib`), T4/T9 (nessun comando `primary switch`/`primary claim` in `server` o `scripts`), T5-T8 e T10.

## Da decidere

1. **Segreti sul server: sì, ma solo l'elenco minimo del sistema agentico, cifrato a riposo, mai password personali o bancarie.** Il server Hetzner diventa la macchina che tiene i token dei bot Discord, il token dell'agente Topics, la chiave dei file cifrati del repo, i token Hetzner e Cloudflare, quello di fatturazione e la chiave di decifratura della replica del DB (elenco esatto in T4). Se il server viene compromesso, si compromettono quelli. Alternativa: il server riceve solo token a scadenza breve e il resto resta sul Mac, ma allora a Mac spento canali e cron non funzionano.
2. **Account Claude: convertire i due che ruotano il refresh (`auto-4`, `auto-5`) in token da un anno, con un login ciascuno nel tuo browser (2 minuti l'uno, `switchboard-token`).** Così Mac e server li usano insieme senza invalidarsi, e non c'è nulla da trasferire a ogni passaggio. Alternativa: restano com'erano, un titolare solo per volta, trasferiti a ogni passaggio: funziona, ma un ordine sbagliato li scollega e serve un login. Gli altri due sono già token da un anno.
3. **Dove vive il principale: sul nodo permanente già pagato (0 € in più), con la CI e le card accanto.** Occupazione da misurare a fine lavoro (T12); se la CI ne soffre, un server dedicato (costo mensile da quotare con `hetzner-tetto`, non stimato qui). Alternativa: server dedicato subito.

«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

# Nodo principale scelto a mano, per tutto il sistema agentico

**Perché.** Quando spegni o porti via il Mac, board, canali di Jarvis, cron e account Claude si fermano: oggi tutto il sistema agentico vive su una sola macchina. Attilio ha scelto: il principale si sceglie a mano dalla tray e il server Hetzner lo diventa per intero (decisione sua, 17/11).

**Cosa cambia.**
- **Un principale per volta, con epoca.** Chi ha l'epoca più alta comanda; chi ne ha una più bassa viene respinto (nodi, tunnel, hub). Niente doppio principale per costruzione.
- **Passaggio pulito con drain** (`analisi.md` sez. 4): fermi i dispatch, `.backup` del DB, copia con cartella di stato, jarvis-channels e account, avvio sul nuovo con epoca+1. Mac morto: `claim` dal replicato Litestream (~1 s di scritture a rischio, dichiarato dal prodotto).
- **Segue il principale** (`analisi.md` sez. 2): Topics (DB, board, dispatcher, turni), hub-service (account), jarvis-channels (canali, voce, 38 cron agent e i cron command del sistema), node-pool, gateway MCP e memoria. **Resta sul Mac** quello che è del Mac come computer: backup, salute, Promemoria, Beeper, iPhone, hobby; e le card su cartelle non git, che aspettano il Mac.
- **Account** (`analisi.md` sez. 3): un solo titolare dei refresh per volta; i due token da un anno funzionano ovunque; i due che ruotano vengono convertiti (scelta 2).
- **Requisito (Attilio, 17/11): sul principale i modelli Claude passano solo dagli abbonamenti** (account dello switch, token OAuth o da un anno), mai da una API key a consumo né da crediti comprati. L'hub ha un ripiego a chiave API (`sb/apikey.rs`, `api-accounts.json`, 3 voci): sul principale è spento e le chiavi non entrano nel deposito segreti. Barra in T2.
- **Il Mac che torna** è un nodo, non il principale: la app si collega al principale, le card che gli servono arrivano a lui, il riporto del principale è un comando a mano dal menù (deciso da me: un ritorno automatico farebbe decidere al caso chi comanda). Il suo DB di prima resta da parte come `topics.db.prima-<epoca>`.
- **Tray**: menù «Nodo principale» con la lista dei computer, chi lo è adesso, da quando; se il principale scelto non risponde per N minuti la tray lo dice e offre «prendi tu» a mano (mai automatico).

**Prima traccia, un giorno (T0).** Riattacco: al riavvio il Mac rilegge la corsa aperta sul nodo invece di cancellarla. Da sola evita di buttare una consegna finita a Mac spento (`analisi.md` sez. 1, punto 4) e non dipende da nient'altro.

**Barra.** Per traccia in `tasks.md`; d'insieme: un passaggio vero Mac → server → Mac con video, con una card in volo, un messaggio WhatsApp ricevuto sul server, un turno su un account Claude fatto dal server e il DB confrontato prima e dopo; `openspec validate nodo-principale-a-mano` esce 0.

**Fuori.** Qualunque chiave API Claude a consumo e crediti a pagamento sul principale. Sposta solo ciò che segue il principale; i servizi RESTA della mappa non si toccano. Nomi, IP e account nel codice: mai (tutto da `machines`, impostazioni, deposito segreti). Il PC Windows non è candidato a principale (dorme). Fusione di due DB: non si fa.

**Costo.** ≈ 175 h di lavoro (tracce in `tasks.md`, ±30%; non misurato). Spesa nuova: 0 € se resta sul nodo permanente (scelta 3).

## Non ancora specificato

- Se Anthropic tollera i token di quegli abbonamenti da un IP di datacenter (si prova in T2 con un turno vero, prima di costruire il resto).
- Se un `claim` dopo Mac morto richiede di ricollegare il dispositivo WhatsApp (dipende dall'età dello stato copiato).
- Come i terminali e le sessioni vive della app sul Mac (PTY, pannelli browser) si comportano quando il principale è remoto: oggi la card le legano al server che le ha create.
- Quali figli del gateway MCP hanno segreti o app solo-Mac (3 file con `security`/`osascript`, non letti uno per uno).
