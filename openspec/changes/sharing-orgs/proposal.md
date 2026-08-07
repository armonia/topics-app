# Change: sharing-orgs

## Why

Il soggetto di una concessione è il **ferro**. `grants.subject_type` ammette un
solo valore, `'device'`, e la condivisione è quindi «questa scheda a quel
telefono».

Finché Topics era di una persona sola la cosa era coerente, e la `083` lo diceva:
«con un proprietario solo, persona e dispositivo sono la stessa informazione».
Non lo sono più, e non per un ripensamento di gusto: **il prodotto si vende a
singoli e a team**. Da lì discendono tre cose che oggi non si possono dire.

**Un collega ha due dispositivi.** Condividere col portatile ma non col telefono
non è una frase che qualcuno voglia pronunciare, eppure è l'unica che il modello
sa esprimere. Misurato nel codice: `ShareControl` mostra due righe con lo stesso
nome, il conteggio dice «Condiviso con 3» per una persona sola, e la X toglie
l'accesso a un dispositivo lasciando gli altri dentro. Sembra un difetto di resa;
è il modello.

**Non si può invitare qualcuno.** Una persona che non ha ancora appaiato un
dispositivo *non è rappresentabile*: non compare in `/api/auth/devices`, quindi
non esiste un destinatario a cui condividere. Oggi «invitare» significa
«aspettare che il suo telefono si appai, e poi condividere» — l'ordine delle
operazioni è rovesciato rispetto a come lo si venderebbe.

**Il piano di controllo non ha dove atterrare.** La forma decisa per il prodotto
è: app locale, piano di controllo centrale (account, organizzazioni, licenze,
relay). Account e organizzazioni sono precisamente le entità che qui non
esistono, e disegnarle dopo aver costruito sopra il dispositivo vorrebbe dire
scriverle due volte.

## What changes

**Il soggetto diventa un principale**: `device`, `person`, `org`. Una concessione
resta **una riga con un soggetto solo**; a cambiare è il lato della domanda, che
si confronta con l'insieme dei principali del richiedente — dispositivo → persona
→ sue organizzazioni, **profondità fissa 2**.

**La risoluzione avviene a lettura, e non contraddice la `083`.** Quella regola
(«nessuna gerarchia implicita: il permesso si materializza in righe») nasce per
l'asse **risorsa** — progetto → task — e lì resta intatta, con `via_type`/`via_id`.
Sull'asse **soggetto** non vale, per tre ragioni verificabili: la profondità è
fissa e chiusa (non esiste `orgs.parent_id`, e un test fallisce se compare),
quindi non è un grafo da girare ma una JOIN; la domanda inversa resta la stessa
SELECT sull'indice di risorsa; e materializzare device→persona→org significherebbe
copiare righe a ogni pairing e a ogni nuovo membro, spostando la sicurezza da una
query che è vera a **un job che è girato**.

**La proprietà è LOCALE, e non discende dall'organizzazione.** È la correzione che
regge tutto il resto. `installation_owners` è una tabella che la sincronizzazione
non tocca mai; `org_members` sarà invece una replica ad autorità remota — è la
licenza, è la fattura. Se il ruolo di proprietario ne dipendesse, una carta
rifiutata o una riga tolta da un pannello ti degraderebbero a **ospite sulla tua
macchina**. Un collega dello stesso team che apre il tuo `:3333` è un ospite: è il
tuo filesystem, i tuoi terminali, il tuo abbonamento. L'organizzazione serve alla
licenza, alla rubrica e alla condivisione — non all'accesso.

**Il confinamento smette di essere una colonna e diventa una relazione**:
`devices.role` è derivato, non un dato. Un dispositivo senza persona è confinato
(fallback prudente, come già fa il client).

## Out of scope — e perché

- **Il relay.** La forma è decisa (controllo centrale, dati locali) ma resta da
  scegliere dove termina il TLS, ed è una decisione di infrastruttura e di
  fiducia, non un'implementazione.
- **Il sincronizzatore vero.** Qui si mettono le colonne che lo renderanno
  possibile (`origin`, `remote_id`, `rev`, tombstone) perché SQLite non altera un
  CHECK in posto e aggiungerle dopo vorrebbe dire ricreare le tabelle una seconda
  volta. Il processo che le usa no.
- **Il permesso di SCRIVERE.** `deny` entra nello schema e nella porta di query
  ORA, per la stessa ragione meccanica; l'interfaccia per concederlo no.
- **Il login del proprietario.** Resta il vincolo scritto in `device-auth` §6.3.
  Qui il proprietario è una persona anonima creata dalla migration e rinominabile:
  un nome verificabile dall'esterno arriverà col piano di controllo.

## Risks

1. **Il backfill può fondere due umani in una persona.** Oggi il cartello di
   pairing non chiede a chi appartiene un dispositivo, quindi il telefono di un
   collega approvato una volta è indistinguibile dai propri. Mitigazione: la leva
   di riassegnazione (ORG-021) sta nella stessa consegna, non in una successiva.
2. **Due generazioni di concessioni convivono.** Le righe su `device` e quelle su
   `person`/`org` significano cose diverse nella stessa tabella. Mitigazione: la
   porta unica di query (ORG-007) le rende insieme, e un test fallisce se
   `FROM grants` compare fuori da lì.
3. **Uno scrittore rimasto indietro non fa rumore.** Un vecchio lettore che filtra
   `subject_type='device'` legge di **meno** — fail-closed. È il verso giusto in
   cui sbagliare, ma è silenzioso: per questo la porta unica è un requisito e non
   una convenzione.
4. **Il caso dominante non esercita il modello, e non deve.** Il loopback
   corto-circuita prima di qualunque lettura: il 99% del traffico non tocca
   `people`. È la rete anti-lockout della `080` — una tabella `people` corrotta non
   deve poter chiudere fuori il proprietario dalla propria macchina.

## Come è stato deciso

Tre progetti indipendenti portati alle estreme conseguenze (materializzazione
totale · risoluzione a lettura · tabella unica dei principali), ciascuno passato a
tre lenti separate — coerenza del modello, evasione di un ospite, tenuta il giorno
in cui l'autorità passa a un servizio centrale — e poi sintetizzati. Due dei tre
sono caduti su un difetto che nessuno aveva previsto scrivendoli:

- **materializzazione**: la sicurezza smette di dipendere da una query vera e
  comincia a dipendere da un job girato. Su questa macchina il watcher manda
  SIGTERM al server a ogni salvataggio in `server/`, quindi «il processo muore in
  mezzo alla riconciliazione» non è un caso limite: è il ciclo di sviluppo
  normale. E il rilevatore di divergenza è cieco al **sotto**-permesso.
- **principali con chiusura transitiva**: i tre statement di ricalcolo sono
  `INSERT OR IGNORE` e non esiste una sola `DELETE`. Il ricalcolo è **monotono**:
  può solo concedere. Togliere una persona da un'organizzazione lascia le righe al
  loro posto, per sempre, senza un errore. Il modello introduce la revoca come
  operazione principale e non sa eseguirla.
