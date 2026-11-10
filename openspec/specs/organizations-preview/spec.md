## Purpose

L'anteprima per le organizzazioni (`client/src/ui`, `client/src/ui-gallery`) è uno
strato isolato: riceve tutto dalle props, ha i suoi testi, le sue primitive e le
sue schermate di prova. Questa capability fissa le due regole che tengono
quello strato onesto, e che i test nuovi dell'anteprima citano.

## Requirements

### Requirement: ORGPREV-01 — Un flusso si disegna con UN componente, in sola lettura e in modifica

Il sistema SHALL disegnare i casi affiancati di un flusso (editor, card e
pagina di esecuzione) con lo stesso componente, e SHALL fare in modo che le
esecuzioni simulate seguano i casi d'esempio: un caso da confermare non ha
numero di protocollo e aspetta la persona.

#### Scenario: esecuzione di un caso da confermare

- **WHEN** l'esecuzione simulata riguarda un caso d'esempio da confermare
- **THEN** non porta un numero di protocollo e lo stato dice che aspetta la persona

### Requirement: ORGPREV-02 — Le righe di una card della bacheca dicono solo ciò che la card non ripete

Il sistema SHALL comporre le righe di una card della bacheca dai fatti del
flusso, senza ripetere il titolo né due volte la stessa informazione, e SHALL
contare le parole condivise fra due righe per decidere cosa tagliare.

#### Scenario: due righe con le stesse parole

- **WHEN** due righe di una card condividono quasi tutte le parole
- **THEN** ne resta una sola
