# Design: come due installazioni diventano amiche

Questo documento risponde a una domanda sola, che è quella dove si sbaglia:
**cosa viaggia sul filo, e cosa può fare chi lo intercetta.**

## 1. Il problema, ridotto all'osso

Su A c'è una riga in `people` che è il proprietario di A. Su B ce n'è un'altra
che è il proprietario di B. Non esiste nessun identificatore che le due macchine
condividano, se non quello che un servizio degli account distribuirebbe, e quel
servizio è fuori scope (manda mail, crea account altrove).

Quindi l'identità dell'altro **arriva dall'altro**, non da un'autorità. È una
scelta con conseguenze precise, e vanno dichiarate prima:

- Non c'è nessuno che garantisca che chi accetta l'invito sia chi credi. La
  garanzia è **il canale fuori banda**: hai dato quel codice a quella persona.
  È la stessa garanzia dei link di condivisione di oggi (GUEST-08) e del codice
  di appaiamento di un dispositivo (`device-auth`).
- Perché sia una garanzia sufficiente serve che **l'amicizia non valga niente**:
  chi ruba un invito ottiene una riga in una lista, non l'accesso a una chat.
  È l'invariante FRIEND-02, ed è la ragione per cui viene prima di tutte.

## 2. Il biglietto da visita

Ogni installazione sa dire chi è, senza chiedere a nessuno:

| campo | da dove viene oggi |
|---|---|
| `installationId` | `ctx.relayConfig().installationId`, già usato da `server/routes/account.ts:54` |
| `personId` | `actingPersonId`, la persona che agisce (`server/lib/orgs.ts`) |
| `displayName` | `people.display_name` |
| `avatar` | la faccia in cache (`server/lib/github-profile.ts`), mai un URL da ricaricare |
| `reach` | come ti si raggiunge: origine relay, oppure niente |

`reach` è l'unico campo che può cambiare nel tempo, ed è l'unico che va
riscritto a ogni contatto. Gli altri quattro sono l'identità.

## 3. Il giro, in cinque passi

```
A                                   B
│  1. crea invito (monouso, scade)
│     codice = id + segreto
│ ─────── il codice passa a mano, fuori dall'app ──────►
│                                   │  2. incolla il codice
│                                   │  3. POST /api/friends/redeem
│ ◄─────────── biglietto di B + segreto ───────────────│
│  4. verifica il segreto, brucia
│     l'invito, scrive la riga
│ ─────────── biglietto di A ──────────────────────────►
│                                   │  5. scrive la riga
```

Due righe, una per macchina, entrambe `accepted`. Nessuna delle due è la copia
autorevole dell'altra: **ogni lato è padrone del proprio stato**, e questo è ciò
che rende «togliere un amico» un gesto locale che non ha bisogno di rete e non
può essere rifiutato dall'altro.

### Perché non un'accettazione in due tempi

La forma «B chiede, A approva» esiste già per i dispositivi ed è più naturale da
raccontare. Qui però l'invito lo emette A e lo consegna a mano a B: A ha **già**
approvato nel momento in cui ha passato il codice. Aggiungere una seconda
approvazione dallo stesso lato è un passaggio che non decide niente.

Lo stato `pending` resta comunque nel modello, e non è decorativo: serve al caso
in cui B riscatta mentre A è spenta, o quando l'invito viene emesso dal lato che
poi non è raggiungibile. Vedi il punto 5.

## 4. Cosa NON viaggia

- Nessun cookie, nessun token di sessione, nessun `grant`. Il carico del
  riscatto contiene i cinque campi del biglietto e il segreto dell'invito.
  Nient'altro. Un campo in più qui è una decisione di sicurezza, non un dettaglio.
- Nessuna lista di amici dell'altro: l'amicizia è un fatto fra due, e la rubrica
  di A non è affar di B (è la stessa regola di PROFILE-04, «la rubrica non è
  l'elenco di tutti»).
- Nessun progetto, nessuna chat, nessun percorso di file.

## 5. Quando l'altra macchina è spenta

Il caso normale è che una delle due sia spenta, e va progettato adesso invece di
scoprirlo in prova.

- **B riscatta e A è spenta.** B non può parlare con A. B tiene una riga
  `pending_out` con dentro il codice, e riprova. Non compare fra gli amici finché
  A non risponde: uno stato che dice «amico» quando l'altro non lo sa è la
  bugia peggiore che questa superficie possa raccontare.
- **A ha bruciato l'invito ma la risposta si perde.** A ha la riga `accepted`, B
  non ce l'ha. Il riscatto è **idempotente sulla coppia**: rifarlo con lo stesso
  invito già bruciato **dalla stessa installazione** riconsegna il biglietto di A
  invece di rifiutare. Da un'altra installazione è un invito consumato, cioè lo
  stesso nulla di un invito inventato.
- **Entrambe si riavviano.** Non cambia niente: nessuno dei due stati sta in
  memoria.

## 6. Il rapporto con `follows`

`follows` resta, e resta asimmetrico. Le due relazioni rispondono a due domande
diverse:

- *seguire* = «voglio vedere cosa fa questa persona», una direzione, nessuna
  domanda a nessuno;
- *amicizia* = «ci conosciamo», due direzioni, e un invito che qualcuno ha
  passato a qualcun altro.

Un'amicizia **non** implica un follow e non lo crea in silenzio. Vale la pena
dirlo nella spec perché la scorciatoia (accettare = seguirsi a vicenda) è
tentante e produrrebbe righe che nessuno ha chiesto, in una tabella che governa
cosa si vede.

## 7. Cosa resta da decidere prima di scrivere codice

I quattro bivi in fondo a `proposal.md`. Il primo e il quarto cambiano il codice
del server; il secondo e il terzo cambiano solo l'interfaccia.
