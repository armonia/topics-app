# Piano — vedere le sessioni di un altro utente («amicizia») + incognito

> Task `d6baaf5e`. Scritto il 04/08/2026. **È un piano da approvare, non una decisione presa**:
> le due scelte che cambiano tutto sono in §1 e vanno fatte prima di scrivere una riga.

---

## 0. Da dove si parte davvero

Due fatti misurati sul codice di oggi, ed entrambi sono più duri di come suona il task.

1. **Topics non ha nessuna autenticazione.** Non «ha un'autenticazione debole»: non ce l'ha
   (`README`/`SECURITY`: *no built-in authentication*). Non esiste il concetto di utente.
2. **L'accesso remoto è un tunnel che espone il server INTERO** (`server/routes/remote.ts`:
   Tailscale Funnel, con rilevamento di cloudflared/ngrok). Chi ha l'URL **è te**: tutte le
   chat, tutti i terminali, tutti i progetti, con pieno diritto di scrittura.

Conseguenza: «vedere le sessioni di un amico» non è una funzione che si aggiunge sopra. Il
90% del lavoro è **il livello che oggi non esiste** — identità e autorizzazione — e
l'amicizia è l'ultimo 10%.

---

## 1. Le due decisioni da prendere prima

> **DECISO DA ATTILIO IL 04/08: (A) → relay CIECO, cifratura end-to-end.** Parole
> sue: «deve essere sicuro no? però sempre condivisibile». Le due cose stanno
> insieme, ma non gratis, ed è giusto sapere il prezzo prima: **condividere resta
> possibile — cambia CHI può leggere.** Con la cifratura end-to-end le chiavi
> vivono sui dispositivi, il relay instrada byte che non sa aprire, e chi
> condividi vede tutto come prima. Quello che sparisce sono le funzioni che
> richiedono al SERVER di capire il contenuto: ricerca lato server sulle
> conversazioni condivise, cronologia consultabile da un dispositivo nuovo senza
> le chiavi, anteprime generate dal server. Se un giorno ne servirà una, non sarà
> «una funzione in più»: sarà tornare indietro sulla scelta. Il piano qui sotto
> vale lo stesso, con la fase 3 più costosa (scambio e recupero delle chiavi).

**(A) Il relay vede i contenuti?**
Il task dice «hosting: Hetzner», quindi un relay server-side. Vuol dire che le tue chat e
l'output dei tuoi terminali **transitano da una macchina** — e lì sono in chiaro, salvo
cifratura end-to-end. L'alternativa è un relay cieco (instrada byte cifrati fra i due
dispositivi, non può leggerli), che costa parecchio di più in progettazione e rende
impossibile qualunque funzione server-side (ricerca, cronologia condivisa, replay).
**Raccomandazione: relay che vede, e detto chiaramente nell'interfaccia.** Un relay cieco è
la scelta giusta per un prodotto che promette riservatezza a estranei; qui gli utenti sono
persone che si sono aggiunte a vicenda, e la promessa onesta è «i tuoi dati passano dal
nostro server», non una crittografia che poi non regge alle funzioni che vorrai.

**(B) Chi è l'autorità dell'identità?**
Serve un posto che dica «questo è Attilio» in modo che due macchine diverse siano d'accordo.
Le opzioni pratiche: (i) account propri sul relay (email + magic link), (ii) OAuth di terzi
(GitHub/Google), (iii) identità di Tailscale, che **molte installazioni già hanno** visto che
il tunnel attuale la usa. **Raccomandazione: (iii) se accettabile, (ii) altrimenti.** Scrivere
da zero registrazione, recupero password e verifica email è il modo più veloce per introdurre
il primo vero buco di sicurezza in un prodotto che finora non ne aveva perché non aveva
account.

---

## 2. Le fasi, ognuna utile da sola

Il criterio dell'ordine: **nessuna fase esiste solo per abilitare la successiva.** Se il
progetto si ferma dopo la 1, quello che c'è è comunque un miglioramento.

### Fase 1 — Autenticare il tunnel (senza amici, senza relay)
Il server chiede un'identità a chi arriva da remoto e rifiuta chi non ce l'ha.
**Vale da sola**: oggi l'URL del tunnel è una chiave universale, e questo lo chiude.
Nessun account di terzi ancora: basta un segreto per dispositivo, generato dall'app e
approvato dalla macchina che ospita.
Verifica: apri il tunnel da un dispositivo mai approvato → non entri. Da uno approvato → sì.

### Fase 2 — Identità e presenza per dispositivo
Ogni dispositivo approvato ha un nome e uno stato (online/offline), visibile ovunque — è il
punto 3 del task. **Vale da sola**: sapere da quale macchina stai lavorando risolve già un
problema vero (le sessioni fantasma di [[project-topics-process-leaks]] partono da lì).

### Fase 3 — Il relay e l'amicizia
Registro sul relay, richiesta/accettazione, elenco degli amici. Nessuna condivisione ancora:
**essere amici non mostra niente.** Questo è deliberato ed è il punto 2 del task — la
condivisione è un gesto separato e per-sessione.

### Fase 4 — Condivisione per sessione, in sola lettura
L'owner sceglie UNA sessione e la condivide con UN amico. Sola lettura. Nessuna promozione a
scrittura, ancora.

### Fase 5 — Promozione a «può scrivere»
Gesto esplicito dell'owner, per-sessione e revocabile. **Mai implicito nell'amicizia**, e mai
per-utente-in-generale: il diritto di scrivere nel terminale di qualcun altro è il potere di
eseguire comandi sulla sua macchina, e va chiesto ogni volta per la cosa specifica.

### Fase 6 — Incognito
Un progetto marcato incognito è **escluso alla sorgente**, non filtrato in vista: il relay non
ne riceve i dati, non li ha e non può sbagliare a mostrarli. Il filtro in vista è la forma
sbagliata dello stesso requisito — basta un percorso dimenticato e trapela.

---

## 3. Le cose che si rompono, e vanno decise adesso

- **Il modello a due stati** («aperta = tab, chiusa = archiviata») è per-installazione. Con due
  persone sulla stessa sessione, *chi* la chiude e *per chi*? Proposta: la chiusura dell'ospite
  chiude **la sua vista**, mai lo stato dell'owner.
- **I terminali sono processi veri.** Una sessione condivisa in scrittura è una shell sulla
  macchina dell'owner. Va detto nell'interfaccia con queste parole, non con «può scrivere».
- **La cronologia condivisa è una copia.** Quando l'amicizia finisce, ciò che l'ospite ha già
  visto l'ha visto. La revoca ferma il futuro, non il passato — e l'interfaccia deve dirlo,
  altrimenti «rimuovi amico» promette una cosa che non fa.
- **Chi paga il relay.** Su Hetzner c'è un costo ricorrente e un responsabile dei dati altrui:
  è una decisione di prodotto, non di infrastruttura.

---

## 4. Quanto è grande

Le fasi 1 e 2 sono lavoro contenuto e locale (il server c'è già, il tunnel anche). Dalla 3 in
poi si introduce **un secondo sistema da gestire** — un servizio in rete, con account, dati di
persone diverse e una superficie d'attacco che oggi non esiste. Non è un'estensione di Topics:
è un prodotto affiancato.

**La mia raccomandazione è di autorizzare la fase 1 e la 2 subito** — chiudono un buco reale e
non impegnano su niente — e di trattare la 3 come una decisione a sé, dopo aver risposto a §1.
