# Accettazione: split da zero

## Barra eseguibile
```
bun test client/src/lib/splitIntent.test.ts                   # T1-T2: zona → intento, per sorgente, superficie e tetto
bun test client/src/components/Layout/splitKeyboard.test.ts   # T3-T6: frecce sul divisore, fuoco fra celle
bun test client/src/components/Shared/tabSheetEntries.test.ts # T5: Disposizione completa in ogni foglio
bun test client/src/components/Shared/SplitMiniMap.test.ts    # T7: mappa per gli split di progetto
pw-remote -- npx playwright test tests/e2e/split-da-zero.spec.ts  # SPLIT-01..07, video in videos/split/
```
Mutazioni che devono fare rosso:
- T1: rimettere `center` per ogni trascinamento dalla colonna → SPLIT-01 non trova la seconda cella.
- T2: togliere il nome dall'anteprima → SPLIT-02 non lo legge dentro l'impronta.
- T3: dimenticare `tabIndex` sul divisore → SPLIT-04 non ci arriva con Tab.
- T4: mostrare la testata anche con una cella sola → SPLIT-03 ne conta una dove non deve.

## Scenario: dalla colonna si divide (SPLIT-01)
Dato tre chat aperte, tab di lato, una cella
Quando trascino la riga di Beta sul bordo destro della griglia
Allora la griglia ha due celle affiancate, Beta a destra, e un divisore
E trascinando la riga di Gamma sul bordo basso della cella di Beta, Gamma sta sotto Beta e la cella di sinistra resta intera
E trascinando una riga sul centro di una cella, quella chat si vede lì e nessuna pane si chiude

## Scenario: l'anteprima dice cosa succede (SPLIT-02)
Dato una griglia con una cella
Quando trascino una riga sul bordo destro e mi fermo
Allora l'impronta occupa la metà destra della cella e porta icona e nome della chat
E sul centro l'impronta è un contorno dell'intera cella, senza velo
E al tetto delle quattro colonne il bordo destro non si offre

## Scenario: la cella dice cosa contiene (SPLIT-03)
Dato una griglia divisa in due, tab di lato
Allora ogni cella ha una testata con icona e nome, e quella col fuoco è accesa
E un clic sulla testata dell'altra cella le passa il fuoco
E con una cella sola non c'è testata

## Scenario: divisori da tastiera (SPLIT-04)
Dato due celle affiancate al 50%
Quando porto il fuoco sul divisore con Tab e premo freccia destra
Allora la cella di sinistra passa al 55% e il divisore dice 55
E Invio le riporta al 50%

## Scenario: Disposizione da ogni foglio (SPLIT-05)
Dato tab di lato e una chat aperta non sola nella sua cella
Quando apro il foglio della sua riga
Allora c'è Disposizione con Dividi a destra, a sinistra, in basso, in alto, Ingrandisci, Pareggia, Togli dallo split
E Dividi a sinistra la mette in una cella nuova a sinistra
E Togli dallo split la riporta nella cella principale, ancora aperta

## Scenario: fuoco fra le celle (SPLIT-06)
Dato tre celle (due affiancate, una sotto)
Quando premo ⌘⌥→ e poi ⌘⌥↓
Allora il fuoco passa alla cella di destra e poi a quella sotto, e la testata accesa lo segue

## Scenario: mini mappa di progetto (SPLIT-07)
Dato una finestra di progetto divisa in due
Allora la riga del progetto nella colonna mostra la mini mappa con due celle e quella attiva accesa
