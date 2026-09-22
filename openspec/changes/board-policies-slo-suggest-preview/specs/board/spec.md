# Board — le tre policy approvate il 2026-09-22

## ADDED Requirements

### Requirement: BOARD-POLICY-01 — Una card `visibile` non consegna senza anteprima, e le altre classi non cambiano

Una card che la board ha **gia' etichettata** `visibile` (`deriveCloser`: tocca
`client/src/**` fuori dai test) tocca una superficie che il reviewer apre per
GUARDARLA. Il passaggio a `review` si rifiuta finche' `previewImage` e' vuota.

Il perimetro e' stretto di proposito. Chiedere una prova a ogni card fabbrica
artefatti su consegne che non hanno niente da mostrare: e' cosi' che un cancello
comincia a produrre evidenza per se stesso invece che per chi legge.

#### Scenario: la card visibile senza anteprima
- **GIVEN** una card con l'etichetta `visibile` e `previewImage` vuota
- **WHEN** un agente la porta in `review`
- **THEN** il server risponde **409** con codice `review_needs_preview`
- **AND** il messaggio dice cosa fare (`previewImage=<percorso>`), non solo cosa manca
- **AND** la card NON si muove

#### Scenario: la stessa card, con l'anteprima
- **GIVEN** la stessa card dopo `update_task(previewImage=…)`
- **WHEN** viene riportata in `review`
- **THEN** entra in review

#### Scenario: le altre classi passano intatte
- **GIVEN** una card `decisione`, una `invisibile`, una con la sola etichetta di
  genere `feature`, e una **senza ancora nessuna etichetta**
- **WHEN** vengono portate in `review` senza anteprima
- **THEN** entrano tutte in review
- **AND** in particolare la card senza etichetta non viene trattenuta: il cancello
  risponde su cio' che e' SCRITTO, mai su cio' che indovina verra' scritto

### Requirement: BOARD-POLICY-02 — Le attese del pavimento si contano, e l'invariante resta

Quando il pavimento delle risorse trattiene la coda, il fermo si conta: quante
volte (`episodes`) e per quanto (`heldMs`), con la finestra da cui si conta
(`since`). Il valore e' leggibile da `GET /api/boards/:projectId/settings`.

E' una MISURA, non una leva: nessuna card parte che prima non sarebbe partita,
`dispatchFanOut` resta un agente per card, e nessuna guardia viene allentata. Si
misura prima di promettere, perche' uno SLO scritto senza questo numero sarebbe
una promessa a intuito.

#### Scenario: un fermo e' un episodio, non una raffica di letture
- **GIVEN** una coda con card pronte e la memoria che scende sotto il pavimento
- **WHEN** il pavimento viene riletto diciotto volte di seguito mentre e' sotto
- **THEN** l'episodio contato e' **uno**, non diciotto
- **AND** `holding` e' vero e `heldMs` include l'episodio in corso
- **AND** nessuna card e' partita durante il fermo

#### Scenario: la risalita chiude l'episodio, una seconda discesa ne apre un altro
- **GIVEN** un episodio in corso
- **WHEN** le risorse rientrano sopra il pavimento
- **THEN** `holding` torna falso e il tempo resta contato
- **AND** una discesa successiva conta un episodio nuovo, non il proseguimento

#### Scenario: il primo episodio di ogni avvio e' il warm-up
- **GIVEN** un server appena avviato, con la finestra della memoria vuota
- **WHEN** il pavimento trattiene la coda finche' non ha letture da guardare
- **THEN** quel fermo e' contato come episodio, perche' e' un fermo vero
- **AND** chi legge `episodes` deve sapere che il primo e' garantito a ogni boot:
  e' la ragione per cui `since` e' esposto accanto al conteggio
