# Proposal - split-dnd-all-directions

## Why

La consegna precedente (card f9aad5f4) aveva la matrice DNDSPLIT verde 12 su 12
e il gesto, in mano, continuava a non funzionare «ovunque dentro il progetto».
La ragione sta tutta in una riga della tabella che nessun caso copriva: i
dodici scenari puntano sempre una pane di PRIMO livello. Il momento in cui il
sistema si rompe e' il secondo livello, cioe' esattamente dopo il primo split -
quando la superficie ha gia' una colonna divisa in verticale e si prova a
dividerla ancora.

L'audit statico dei due motori (`docs/archive/dnd-split-audit.md`, 14 difetti
con riferimenti puntuali) dice che il guasto non e' «una direzione mancante»:
tutte e quattro le direzioni esistono e producono una mutazione. Il guasto e'
che l'ANTEPRIMA e il RISULTATO divergono appena il bersaglio e' annidato, e che
tre gesti si accendono per non fare niente. Chi trascina impara in fretta a non
fidarsi della fascia colorata, e la sensazione e' «non mi fa splittare».

Il modello persistito e' a due livelli fissi: una riga ha colonne, una colonna
puo' avere una pila verticale, e uno slot della pila contiene UNA pane. Uno
split orizzontale DENTRO uno slot non e' rappresentabile, e riscrivere il
modello in un albero ricorsivo (con migrazione del layout salvato e dei due
motori) e' il refactor infinito che la card vieta. Quindi la regola che questa
change applica e' quella che la spec gia' dichiara e che il codice non
rispettava: **un gesto offerto riesce, e cio' che l'anteprima promette e' cio'
che il rilascio produce**. Dove il risultato onesto e' la colonna ospite,
l'anteprima disegna la colonna ospite.

## What Changes

**Il comportamento.**

- Uno split verticale divide l'altezza del SOLO slot puntato. Oggi
  riequalizzava tutta la colonna, cancellando ogni ridimensionamento manuale.
- Lo stesso gesto da' lo stesso layout da qualunque parte venga la tab. In
  standalone, il bordo alto/basso di una cella impilava se la tab veniva dal
  pool e creava una riga a tutta larghezza se la tab aveva gia' una cella sua.
- Il centro del PROPRIO gruppo non si accende piu': era una campitura che
  prometteva una fusione gia' avvenuta.
- La banda fra due righe non si accende quando il rilascio ridisegnerebbe lo
  stesso albero, e non copre piu' la barra tab della riga sotto.
- Il ripiano della pane in volo si pulisce anche su `drop`, non solo su
  `dragend`: il `dragend` si perde quando la sorgente viene smontata dentro il
  drop, e da li' in poi il gesto successivo leggeva una sorgente sbagliata.
- I tetti di sicurezza (32 colonne, 32 righe, 32 slot) li legge anche
  l'anteprima. Erano noti al solo rilascio, che al tetto esce senza cambiare
  niente: la fascia si accendeva e il gesto moriva in silenzio, e questo tocca
  tutte e quattro le direzioni.
- Uno split parcheggiato in attesa della chat compagna scade invece di
  risorgere ore dopo.

**L'anteprima.**

- Su un bersaglio ANNIDATO (o sul primario di una colonna gia' divisa), la
  fascia sinistra/destra disegna il contorno della COLONNA che nascera',
  perche' e' quello che il rilascio produce.
- In standalone il centro di una pane impilata indica la pane sotto il
  puntatore, e la fusione entra in quella: prima entrava nel gruppo della pane
  in cima.
- Le fasce di split non restano piu' sotto le strisce a tutta larghezza: su
  celle basse la banda «impila sopra» valeva zero pixel.

**La prova.** Test reducer sulle quattro direzioni e sulle sequenze
multi-passo, e la matrice e2e estesa ai casi annidati, al movimento fra pane e
al ritorno dopo un ricarico.

## Out of scope

- L'albero ricorsivo che renderebbe rappresentabile uno split orizzontale
  dentro uno slot di pila. E' l'unica riga della matrice che resta senza il suo
  risultato «letterale», ed e' dichiarata: il rilascio produce la colonna
  accanto, e l'anteprima lo dice prima.
