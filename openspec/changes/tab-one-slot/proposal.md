## Da decidere

Deciso da Jarvis su delega di Attilio (29/09: «valuta tu al top … la notifica o il progress dovrebbe stare sempre a destra … stop e poi chiusura come stati successivi»).
1. Tre zone fisse: icona, nome, slot. Il nome ha un minimo garantito di 56 px e a riposo fra nome e slot non c'è niente. Perché: oggi il nome è l'unico pezzo che si restringe, e sulla tab di progetto «Armonia» sparisce del tutto.
2. Uno slot a destra, 20 px, sempre riservato anche vuoto, che mostra UN segnale: pausa > lavoro (anello, col numero dentro se c'è anche attenzione) > numero di attenzione > niente. Perché: un segnale che compare o sparisce non sposta più niente, e lo stato si legge sempre nello stesso punto.
3. Al passaggio del mouse o col fuoco lo slot diventa IL comando: Ferma finché c'è un turno vivo, poi Chiudi nello stesso punto. Mai due bottoni affiancati. La tab di progetto non offre Ferma. Perché: è la sequenza chiesta, e sul progetto un clic accanto alla chiusura fermerebbe N agenti.
4. Escono dalla tab lo spillo, il tempo, «ha aperto un browser» e cloud: restano nella sidebar e nel tooltip. Marcatore di progetto, avviso di organizzazione ed errori della console diventano un segno d'angolo sull'icona, largo zero. Perché: sono informazioni di contorno che oggi costano il nome.
5. Barra: una e2e misura nome e slot, che hanno lo stesso x e la stessa larghezza a riposo, al lavoro, con attenzione, al passaggio e da fermata. Col massimo dei segnali il nome resta ≥ 56 px.

ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `TABSLOT-01` |
| 2 | `TABSLOT-02` |
| 3 | `CHROME-12` (modificato) |
| 4 | `TABSLOT-03`, `CHROME-14` (modificato) |
| 5 | `TABSLOT-01`, `TABSLOT-02` (scenari) |

---

# Una tab, tre zone: il nome resta, lo stato sta a destra, il comando prende il suo posto

## Why

La tab di progetto «Armonia» del 29/09 mostrava sei cose in 150 px: l'icona, il
marcatore di progetto, il numero 13, lo spillo, «5m» e l'anello di lavoro. Il
nome non si vedeva più. La causa sta in `PaneTabBar.tsx`: la larghezza è fissa
(`TAB_W = 150`) e il nome è l'unico pezzo che si restringe (`truncate flex-1
min-w-0`). Tutti i segnali stanno nel flusso, fra il nome e il bordo, quindi
ognuno che compare o sparisce (il tempo che passa da «5m» a «12m», lo spillo,
il numero) sposta e stringe il nome.

Al passaggio del mouse, CHROME-12 mette Ferma e Chiudi affiancati. Attilio
vuole l'altra forma: lo stato sempre a destra, e al passaggio prima Ferma, poi
Chiudi, nello stesso punto.

## What changes

- La tab ha tre zone fisse: icona, nome, slot (TABSLOT-01).
- Lo slot a destra mostra un solo segnale, secondo una precedenza, e al passaggio
  diventa il comando (TABSLOT-02, CHROME-12 modificato).
- I segnali di contorno lasciano la tab o diventano un segno d'angolo
  sull'icona (TABSLOT-03, CHROME-14 modificato).

## Impact

- `client/src/components/Layout/PaneTabBar.tsx` (la tab, `PaneTabCommands`), i
  componenti dei segnali che oggi stanno in coda, `index.css` (`.row-trail`,
  `.row-actions`) solo per la tab.
- La riga di sidebar NON cambia: il suo binario resta com'è.
- Le e2e che fissano i segnali nella tab (`tab-pinned`, `tab-project-marker`,
  `tab-spawned-browser`, `tab-cloud`, il tempo nella tab, Ferma e Chiudi
  affiancati) si aggiornano al contratto nuovo.
