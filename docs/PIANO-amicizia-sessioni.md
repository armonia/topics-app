# Piano: organizzazioni, profili, presenza per persona, incognito

> Task `d6baaf5e`. **Revisione 3, 13/08/2026.** La rev.2 è del 10/08. L'11/08 sono
> atterrati due commit (`ec0ee0ed`, `aef8f70b`: circa 5.400 righe con i test) che hanno
> costruito buona parte di ciò che il piano chiedeva, e il documento non lo sapeva.
> Questa revisione riparte dal codice di oggi, non dalla stesura precedente.
> `git log docs/PIANO-amicizia-sessioni.md` per le versioni vecchie.
>
> **Decisione presa (12/08): opzione B, il piano di controllo va in cloud.**
> Un'organizzazione non è un gruppo di persone che si collegano a questa macchina. È un
> gruppo di **installazioni diverse**, ognuna con le sue sessioni. Il consiglio in bozza
> era A (tutto locale). È stato scartato, e §1 spiega perché B costa meno di quanto
> sembri.

---

## 0. Cosa è cambiato dall'11/08 (misurato)

| commit | cosa ha portato |
|---|---|
| `ec0ee0ed` | progetti d'organizzazione, incognito, autore sui messaggi, profili da GitHub |
| `aef8f70b` | statistiche d'uso reali per persona, Rich Presence Discord |

### Già vivo

- **Organizzazioni vere.** Crea, rinomina, revoca, membri, ruoli `owner`/`admin`/`member`.
  `GET`/`POST /api/auth/orgs` (`server/routes/auth.ts:724-780`), `DELETE` (:781),
  `PATCH` (:878), membri (:941). Interfaccia in Impostazioni
  (`client/src/components/Settings/IdentitySection.tsx`, con `membri.ts`).
- **Profili.** Faccia e nome da GitHub (`server/lib/github-profile.ts`), `GET /api/people`
  (`server/routes/people.ts:100`), sezione Amici
  (`client/src/components/Settings/FriendsSection.tsx`).
- **Statistiche per persona.** Prompt, token in ingresso e in uscita, costo, ultimo
  prompt (`server/lib/person-stats.ts:26-40`), rese in `FriendsSection` e in
  `ProfileStatsSection`.
- **Incognito sul progetto.** La colonna (`092-project-org-incognito.sql`), la spunta in
  sidebar (`client/src/components/Sidebar/TopicTree.tsx`), e un filtro deciso socket per
  socket, non in vista: `vedeProgetto` (`server/lib/project-visibility.ts:84`) e
  `envelopeProgettoPer` (:163).

### A metà

- **Presenza.** `buildPresenceSnapshot` (`server/presence.ts:85`) elenca le **finestre**
  di questa installazione. `auth.ts:473` sa se un dispositivo è `connected`, e
  `DeviceIdentityRow` (`SidebarStatusBar.tsx:834-852`) lo rende già in sidebar: «Questo
  computer», più quanti dispositivi sono vivi adesso. Il soggetto è sempre il
  **dispositivo**, mai la persona.
- **Statistiche.** Prompt e token sì, numero di sessioni no: `StatistichePersona` non ha
  quel campo.
- **Permessi.** `grants.level` ammette `'read'|'deny'` (`084-people-orgs.sql:290`).
  `write` non esiste. `deny` non ha interfaccia, e §3 spiega perché non è una
  dimenticanza.

### Manca, e il primo è un buco

**L'incognito nasconde il progetto, ma non impedisce di condividerlo.** Non è
un'impressione, è una misura: il modulo che decide la visibilità di un progetto
(`server/lib/project-visibility.ts`) non è raggiungibile dal percorso della
condivisione, e la condizione «incognito» da quel lato non viene mai valutata.

In concreto, ed è tutto ciò che serve sapere per correggerlo: **le rotte che creano
una condivisione validano il tipo di risorsa e il soggetto, ma non chiedono mai a
quale progetto appartenga la risorsa.** Manca il controllo di appartenenza al
progetto, e va aggiunto. Vale su entrambe le porte, la concessione diretta a un
soggetto e il link pubblico, e il rifiuto deve stare in tutte e due: chiuderne una
sola sposta il problema, non lo risolve.

Non è un difetto teorico. La spunta esiste in interfaccia e non fa ciò che promette,
ed è la promessa a essere il difetto: per questo F1 è la prima fase e non una
rifinitura. Finché F1 non atterra, «incognito» va letta come «non compare in
elenco», non come «non esce di qui». Questo documento è pubblico e si ferma qui di
proposito: il dettaglio di dove e come sta nel codice e nella card del task, non in
una pagina che chiunque legge prima che la correzione sia spedita.

Restano poi scoperti, e sono lavoro e non difetti:

- Chi è online, **per persona**.
- Quante sessioni ha una persona.
- La scrittura per singola sessione.
- La superficie sociale sopra la status bar. Il posto però non è vuoto: lo occupa
  `DeviceIdentityRow`, che parla di dispositivi.

---

## 1. La decisione: l'organizzazione vive in cloud (B)

### B è la strada per cui lo schema è già stato scritto

Questo cambia la stima, e va detto prima di tutto il resto. La `084` non è neutrale
rispetto al bivio: è stata scritta **aspettando B**.

- `people` e `orgs` portano `origin`/`remote_id`/`rev`/`updated_at`/`synced_at` da
  subito, e la migrazione dice perché: «costano tre colonne adesso e risparmiano un ALTER
  su tabelle piene mentre si scrive un client di sincronizzazione, cioè nel momento
  peggiore possibile» (`084:52-55`).
- `org_members.revoked_at`: «Chi la scrive è il piano di controllo, quando esisterà»
  (`084:110-112`).
- `org_members.local_blocked_at` esiste già come **la leva locale che la sincronizzazione
  non tocca mai**, contro il caso preciso in cui licenzi qualcuno il venerdì col Mac
  staccato e la tua revoca si annulla da sola lunedì (`084:113-119`).
- `server/lib/account.ts` ha già l'account via codice email, con `remote_id` come chiave
  fra due installazioni.
- Il trasporto c'è: relay su Cloudflare Workers più Durable Object, con i suoi test.

B non è una svolta. È il completamento di un disegno già posato.

### Il confine, e l'unica cosa che B allarga

`openspec/changes/sharing-orgs/limiti-accettati.md:24` fissa il confine, e va riletto
perché è il vincolo che governa tutto il resto: il piano di controllo trasporta **solo
anagrafe** (`people`, `orgs`, `org_members`), mai i `grants`, che restano locali per
sempre. Il prezzo è dichiarato: «condividi il progetto col team dal pannello web» non
esisterà, si condivide solo dalla macchina che ha la roba. Ed è il prezzo giusto, perché
il piano di controllo resta ignorante dei task e dei topic **per costruzione e non per
policy**.

Ma «vedere chi è online e quante sessioni ha» non è anagrafe. È un numero che cambia ogni
minuto, e il confine non lo prevedeva. Due modi per farlo passare:

- **Il battito nel piano di controllo.** Ogni installazione manda periodicamente una riga
  minima: chi sono, sono viva, ho N sessioni. Leggere «chi è online nella mia
  organizzazione» diventa una query sola. Costo: il confine si allarga da anagrafe a
  anagrafe più contatori.
- **La presenza sul relay, da installazione a installazione.** Il confine resta intatto.
  Ma per sapere chi interrogare serve comunque la mappa persona → installazioni, che è di
  nuovo il piano di controllo. E si paga una connessione verso ogni installazione da
  guardare, quasi sempre addormentata, per leggere due numeri.

**Raccomandazione: il battito, con il confine riscritto di una riga.** Il piano di
controllo vede `person_id`, `installation_id`, `last_seen`, `sessioni: N`. Non vede
titoli, non vede progetti, non vede contenuti. Un numero e un timestamp. E l'allargamento
va **scritto in `limiti-accettati.md` come accettato**, non lasciato implicito: è
esattamente la forma di deriva che quel documento esiste per fermare.

---

## 2. Le fasi, in ordine

Criterio invariato dalla rev.2: **nessuna fase esiste solo per abilitare la successiva**,
e ognuna ha la sua barra.

L'ordine però cambia rispetto alla bozza discussa sulla card, e la ragione è la scelta B.
Lì la federazione era ultima e facoltativa. Con B «chi è online nella mia organizzazione»
è **irraggiungibile senza piano di controllo**, quindi la federazione si sposta al centro
e la scrittura scivola in fondo: è la più cara e la meno chiesta.

**F1. L'incognito impedisce davvero.** Non un filtro in più, un rifiuto alla sorgente:
entrambe le porte della condivisione risolvono il progetto della risorsa e rifiutano se
è incognito. E non è retroattivo di suo: marcare incognito un progetto già condiviso
deve **revocare** i grant esistenti, altrimenti la spunta mente sul passato invece che
sul futuro.
*Barra:* un test prova che condividere un topic di un progetto incognito **fallisce**
(sia grant sia link), che marcare incognito un progetto già condiviso revoca i suoi
grant, e che nessun frame di quel progetto esce verso un socket ospite.

**F2. Presenza e conteggio per persona, dentro l'installazione.** Aggregare i dispositivi
in uno stato di **persona** (una persona è online se lo è almeno un suo dispositivo), e
aggiungere il numero di sessioni a `StatistichePersona`. Vale già da sola: su una
macchina con più persone appaiate risponde alla domanda senza nessun cloud.
*Barra:* due dispositivi della stessa persona, uno spento, la persona resta online. E il
conteggio sessioni di una persona corrisponde alle sue righe, non a quelle
dell'installazione.

**F3. La riga sociale sopra la status bar.** Non una superficie nuova: il posto esiste ed
è `DeviceIdentityRow` (`SidebarStatusBar.tsx:834`), che oggi dice «Questo computer» e
conta i dispositivi. F3 le cambia il **soggetto**: chi sei tu, e chi è online nelle tue
organizzazioni. Sul telefono la barra non c'è (`App.tsx:1532`), quindi la stessa
informazione deve avere casa nel menu «Topics» (`SidebarSystemMenu`), o nasce già
mancante su metà dei dispositivi.
*Barra:* la riga elenca persone e non dispositivi, e su viewport telefono la stessa
informazione è raggiungibile dal menu.

**F4. Il piano di controllo: anagrafe sincronizzata.** Il servizio (Cloudflare Workers
più D1, come il relay e il landing), il registro delle persone, l'invito e
l'accettazione, e il sincronizzatore con `remote_id` come chiave. Rispetta i due vincoli
già scritti: `local_blocked_at` non si tocca mai, i `grants` non attraversano il confine.
*Barra:* due installazioni, due database diversi, dopo l'accettazione la stessa persona
ha lo stesso `remote_id` da entrambe le parti. E una revoca locale fatta offline
sopravvive al primo pull.

**F5. Il battito: presenza e sessioni attraverso le installazioni.** Riempie la riga di
F3 con le persone vere dell'organizzazione. È piccola **se** F4 esiste, e impossibile
senza.
*Barra:* due installazioni su due macchine, la seconda si spegne, entro la finestra del
battito la prima la mostra offline. E il piano di controllo non ha mai visto un titolo.

**F6. Scrittura per singola sessione.** Livello `'write'` nel CHECK, gate sul verbo e sui
socket di terminale, firma di chi ha scritto nel messaggio, revoca istantanea. Gesto
esplicito dell'owner, mai implicito nell'appartenenza a un'organizzazione. Dipende dalle
fondamenta descritte nella nota `6.7` della change `relay`: spazi e tab vivono in un blob
JSON da circa 56 KB in una riga di `ui_state`, e vanno promossi a righe **prima**.
*Barra:* un ospite `read` che tenta un input su un pty prende `403` anche col socket già
aperto. Promosso, l'input arriva e **compare firmato**.

---

## 3. Tre correzioni alla rev.2

**1) `share_links.key` in chiaro non è un buco da tappare, è una scelta obbligata.** La
rev.2 metteva in F0 la barra «nessuna chiave in chiaro nel DB». Quella barra è
irrealizzabile per costruzione: la chiave serve a **cifrare** il payload, quindi l'host la
deve avere intera, e un hash non cifra. Il censimento del relay lo diceva già
correttamente (`openspec/changes/relay/tasks.md:113-121`): «non è aggirabile, è l'host
che deve CIFRARE». Era la barra a essere sbagliata, non il rilievo. La barra giusta è
un'altra: limitare il raggio (la scadenza c'è ed è tappata a 30 giorni, `auth.ts:1215`),
tenere la revoca raggiungibile anche a relay spento (`auth.ts:1198-1200`), e **scrivere
la conseguenza in interfaccia**: chi legge `data/topics.db` apre ogni link vivo.

**2) Il Durable Object del relay ora un test che lo esegue ce l'ha.**
`relay/relay-do.run.test.ts` istanzia `SessioneRelay` per davvero e lo guida come lo
guida il runtime dei Worker: `fetch()` per l'aggancio, poi i metodi `webSocketMessage` e
`webSocketClose`, che è l'unica forma ammessa quando si ibernà. Il punto `6.4` in
`relay/tasks.md` resta la sua casella vecchia, e questa revisione la spunta: un elenco di
debiti che non registra i debiti pagati smette di essere letto.

**3) `deny` senza interfaccia non è un pezzo mancante, è un limite accettato.** La rev.2
lo elencava fra le cose da fare. `limiti-accettati.md:10` lo aveva già deciso e motivato:
il CHECK e la precedenza esistono ora perché SQLite non altera un CHECK in posto, ma «la
UI per scriverlo arriva quando esiste il caso reale, e non prima, perché una precedenza
che l'utente non vede è una precedenza che l'utente non capisce».

---

## 4. Ciò che si rompe, e va detto in interfaccia

- **L'incognito non è retroattivo da solo.** Marcare incognito un progetto già condiviso
  deve revocare i grant esistenti, non solo impedirne di nuovi. È la prima riga di F1
  perché è la parte che si dimentica.
- **Un terminale condiviso in scrittura è una shell sulla macchina dell'owner.** Va
  scritto con queste parole, non con «può scrivere».
- **La revoca ferma il futuro, non il passato.** Ciò che l'altro ha già visto l'ha visto.
- **Chi chiude una sessione condivisa, e per chi.** La chiusura dell'ospite chiude la sua
  vista, mai lo stato dell'owner.
- **Nuovo, e nasce con B: il piano di controllo custodisce dati di persone diverse.** Fino
  a oggi Topics non poteva avere una fuga di dati altrui, perché non teneva dati altrui.
  Dal giorno in cui F4 esiste, può. Non è un argomento contro B, è la voce che va messa
  nel conto e nella documentazione pubblica.

---

## 5. Quanto è grande

F1, F2 e F3 sono locali e contenute, e insieme rispondono già alla domanda del task su
una installazione sola: chi c'è, quanto lavora, e una spunta che mantiene la promessa.
F4 è **la soglia**: introduce un secondo sistema in rete, con account e dati di persone
diverse. Non è un'estensione di Topics, è un prodotto affiancato, e il fatto che lo
schema locale lo aspetti non riduce il lavoro dall'altra parte del confine. F5 è piccola
se F4 esiste. F6 è la più costosa in proporzione a quanto sembra, perché prima chiede le
fondamenta di `ui_state`.
