# Delta: chat (lean-vs-claude-code)

## ADDED Requirements

### Requirement: CCLI-13 - Un lavoro interno non paga il contesto dell'utente

Un one-shot interno (titolo, giudice, scelta del modello) SHALL partire senza i
CLAUDE.md, lo stile di output e gli hook dell'utente: `--settings` SHALL portare
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `outputStyle: "default"` e
`disableAllHooks: true`, nello stesso blocco delle altre leve (CCLI-07). Le
sorgenti delle impostazioni SHALL restare `user,project,local`: l'`env`
dell'utente può instradare la CLI, come fa il proxy degli account.

Una risposta che l'utente legge (modifica di un messaggio, rigenerazione, ripiego
SSE) SHALL dichiararsi `userFacing` e SHALL tenere quel contesto.

PERCHÉ: la CLI mette in cache solo fino alla fine di un prompt che cambia a ogni
chiamata, quindi quel contesto veniva riscritto nella cache da 1 h, a prezzo
doppio, a ogni titolo. Misura del 14/10 (CLI 2.1.299): da 14.879 a 1.722 token di
prefisso, da $0,0596 a $0,0069 a chiamata.

#### Scenario: titolo di una chat
- WHEN parte un one-shot interno
- THEN gli argomenti portano le tre leve, e togliendone una qualsiasi il banco va rosso

#### Scenario: modifica di un messaggio
- WHEN l'utente modifica un messaggio e la risposta passa dal one-shot
- THEN il one-shot porta solo `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
