# Change: amici-e-account

> **Stato: PROPOSTA, non approvata.** Nessuna riga di implementazione prima di un
> sì esplicito. I bivi in fondo sono decisioni di prodotto, non domande retoriche:
> per ognuno c'è già una raccomandazione e la ragione presa dal codice.
>
> Card `756e39ee`. La richiesta, testuale: «persone non è persone ma amici, e manca
> totalmente un sistema per diventare amici. Manca completamente una sezione account
> dove c'è il login etc. Dovremmo farla, così poi logghiamo un'identità su Windows e
> l'altra sul Mac, li facciamo amici e testiamo bene tutto il resto».

## Why

### Il pezzo che manca non è quello che sembra

La richiesta suona come tre lacune. Contro il codice, due delle tre esistono già
per metà, e la terza non è una lacuna: è una **decisione presa al contrario**, e
va riaperta con gli occhi aperti.

**1. La sezione account esiste, ma quasi sempre non si disegna.**
`client/src/components/Settings/AccountSection.tsx` c'è, è montata dentro il tab
Profilo (`IdentityPages.tsx:71`), e parla con `/api/auth/account`
(`server/routes/account.ts`): chiedi un codice a un indirizzo, lo incolli,
l'identità remota viene **agganciata** a una persona che esiste già (ACCOUNT-01).
Solo che `mostraSezione` la nasconde quando non c'è un servizio degli account
configurato e non c'è nessun collegamento, cioè su ogni installazione normale.
Il risultato, dal punto di vista di chi guarda, è esattamente la frase della card:
non c'è un posto dove si legge chi sei e da dove si esce.

E c'è un secondo scollamento: quel flusso **manda una mail con un codice**, cioè
è fuori dallo scopo dichiarato di questa card. Quindi non è la strada per «loggare
un'identità su Windows e l'altra sul Mac».

**2. «Chi sono» oggi è un DISPOSITIVO, non una persona.**
L'autenticazione che esiste davvero è quella dei dispositivi (change `device-auth`):
`pair/request`, un codice mostrato, `pair/approve` dall'altra parte, un cookie,
`devices`, `logout`. È un cancello a due assi (origine, poi identità) e funziona.
Ma il soggetto è la macchina. La persona è un'altra tabella (`people`, migrazione
`084-people-orgs.sql`), e le due si toccano solo in `actingPersonId`.

**3. «Diventare amici» è impossibile per costruzione, e la ragione è scritta.**
Una riga di `people` nasce in due punti soli: il bootstrap della `084`, e
`server/routes/auth.ts:1206`, quando **tu** scrivi a mano il nome di qualcuno nel
tuo gruppo. Nessun percorso fa nascere una persona perché *un'altra installazione*
ha detto di esistere. Quindi due macchine possono avere due righe che si chiamano
allo stesso modo e non sono la stessa persona per nessuno.

Il legame che esiste, `follows` (migrazione `20260821162529`), è **asimmetrico di
proposito**, e la migrazione dice perché con parole sue: un legame mutuo
«avrebbe bisogno di un invito, di un'accettazione, di uno stato in sospeso e di un
rifiuto, che sono quattro stati e due andate e ritorni». Era la scelta giusta per
il problema di allora (rendere raggiungibile un profilo senza fatturare insieme).
Non è la scelta giusta per il problema di adesso, perché **la richiesta è
letteralmente quei quattro stati**. Questa change li paga, sapendo cosa costano.

### Il confine da non passare

Il cancello esistente vale già, e questa change non lo tocca: arrivare attraverso
il relay non conferisce niente (RELAY-E2E-01), un ospite legge solo ciò che gli è
stato concesso (GUEST-01..04), senza credenziale non si entra (GUEST-03).

**Un'amicizia non è una credenziale.** È un nome, una faccia e una presenza. Non
è un `grant`, non è un dispositivo appaiato, non è una sessione ospite. Il giorno
in cui «siamo amici» diventa una scorciatoia per leggere una chat, la superficie
sociale è diventata un secondo cancello che nessuno ha revisionato. Per questo la
prima cosa che la spec dice non è cosa l'amicizia permette: è cosa **non**
permette.

## What Changes

Quattro pezzi, in quest'ordine, perché ognuno è inutile senza il precedente.

### F1. Identità: una sezione «Account» che c'è sempre

- La sezione smette di nascondersi. Senza nessun servizio configurato mostra
  comunque **chi sei su questa installazione**: nome, faccia, indirizzo se c'è,
  il gruppo, il dispositivo con cui stai guardando, e come si esce (`logout`,
  che oggi esiste solo come rotta senza un bottone nelle impostazioni).
- Diventa una voce di primo livello in `SETTINGS_SECTIONS`, non una scheda dentro
  il Profilo: «chi sono» è la prima domanda, e oggi è a due clic di distanza sotto
  un'altra parola.
- Il collegamento a un account remoto per codice via mail **resta com'è** e resta
  facoltativo: fuori scope, non toccato.
- Su un'installazione senza servizio degli account, «login» significa **scegliere
  l'identità locale**: dare un nome e un indirizzo alla persona proprietaria, che
  la `084` ha già creato al primo avvio. È questo che rende possibile «questa
  macchina è di X, quella è di Y» senza spedire una mail a nessuno.

### F2. Il legame: invito, accettazione, stato

- Una tabella `friends` (o `friend_edges`): una riga **per lato**, con lo stato
  (`pending_out`, `pending_in`, `accepted`, `declined`, `removed`), l'identità
  dell'altro (installazione, persona, nome, faccia in cache) e il momento.
  Sopravvive al riavvio perché è una riga, non un socket.
- Un invito è una **capacità monouso su una cosa sola**, la stessa forma dei link
  di condivisione (GUEST-08): un codice/link che si passa a mano, fuori
  dall'applicazione. Nessuna mail, nessun servizio terzo.
- Riscattare l'invito è una chiamata dall'installazione B a quella A, che porta
  il biglietto da visita di B e riceve quello di A. Da lì entrambe hanno una riga.
- L'invito scaduto, già usato o inventato danno **lo stesso nulla** (la regola
  che GUEST-08 già impone ai link).
- Sciogliere l'amicizia è locale e unilaterale, sempre, anche senza rete: la
  lezione di PROFILE-03, «chiudere il proprio profilo non deve poter intrappolare
  qualcun altro in una relazione che non può sciogliere».

### F3. Il nome, e il chip

- «Persone» diventa «Amici» dove il soggetto è la relazione: il chip in fondo alla
  sidebar (`statusBar.friends.*`, già chiamato così nel codice) e la sua pagina.
- Il chip conta **gli amici**, non tutti quelli che la rubrica conosce. Con zero
  amici lo stato vuoto porta al gesto che li crea, invece di limitarsi a dire che
  non conosci nessuno.
- La rubrica delle Impostazioni resta «Persone»: lì dentro ci sono anche i membri
  del gruppo, che non sono amici di nessuno. Due parole per due insiemi diversi,
  e la rinomina si ferma dove l'insieme cambia (vedi bivio 3).

### F4. La prova, su due macchine vere

- Uno scenario Gherkin sotto `tests/features/` guidato da spec-flow
  (`spec-flow.config.json`), che è già cablato su `openspec/specs` e produce il
  documento vivo: due installazioni, due identità, un invito, un'accettazione,
  un riavvio di entrambe, e l'amicizia ancora lì.
- Il banco a due dispositivi c'è per metà: `playwright.windows.config.ts` esegue
  contro l'app Windows **installata**, raggiunta via tunnel ssh, e il lock della
  porta di test (E2E-LOCK-01) protegge le run concorrenti. Quello che manca è la
  regia di due server insieme in una sola run.

## Impact

- **Spec toccate:** `friends` (nuova), `accounts-orgs` (la sezione Account che
  non si nasconde), `profile` (l'insieme raggiungibile guadagna una terza fonte
  accanto a org e follow).
- **Codice:** una migrazione nuova, `server/routes/friends.ts`, `server/lib/friends.ts`,
  la sezione Account nelle impostazioni, il chip e la sua pagina, i dizionari
  (`i18n-it`, `i18n-en`), lo scenario e2e.
- **Non toccati, e va detto perché il rischio è lì:** il cancello
  (`device-auth`), i `grants`, la visibilità dei progetti, il relay. Un'amicizia
  non entra in nessuno di quei percorsi. Se durante l'implementazione servisse
  toccarli, quella è la prova che il modello è sbagliato, non un dettaglio da
  sistemare.

## Bivi aperti (decisione di chi legge)

1. **Come viaggia l'invito.** (a) codice corto da incollare a mano, zero servizi;
   (b) link cliccabile che passa dal relay; (c) tutti e due.
   *Raccomandato: (a) adesso, (b) quando il relay è acceso di default.* Il codice
   funziona anche fra due macchine sulla stessa scrivania, senza rete di mezzo.
2. **Cosa vede un amico appena l'amicizia è accettata.** (a) nome, faccia e
   presenza, e nient'altro; (b) anche profilo e statistiche, filtrati dagli
   interruttori di privacy che PROFILE-03 già definisce.
   *Raccomandato: (a).* Gli interruttori restano il modo di aprire di più, e un
   default che apre non si può richiudere per chi ha già guardato.
3. **Fin dove arriva la rinomina.** (a) solo il chip e la sua pagina; (b) ovunque
   compaia la parola «Persone», rubrica delle Impostazioni compresa.
   *Raccomandato: (a).* La rubrica contiene anche i membri del gruppo.
4. **La presenza.** «3 di 5 online» per degli amici su altre macchine richiede di
   sapere se quelle installazioni sono vive. (a) niente presenza in questa change,
   il chip conta e basta; (b) presenza solo per gli amici raggiungibili dal relay.
   *Raccomandato: (a).* La presenza è una change sua, e senza relay acceso
   mostrerebbe «offline» a gente che sta lavorando.
