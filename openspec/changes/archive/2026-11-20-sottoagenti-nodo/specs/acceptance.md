# Barra di sottoagenti-nodo

## (a) Integrazione con nodo finto
`spawn_agent` da chat su un repo git, Mac sotto il pavimento di memoria ⇒ la
corsa nasce sul nodo (`createRun`), il risultato torna al genitore
(`subagent-result`), il ramo torna al checkout del Mac (`fetchBundle` +
`plantCarriedBranch`).

## (b) Cartella non git
`spawn_agent` su una cartella senza `.git` ⇒ resta sul Mac, prezzata sul costo
vero del figlio (non sul prezzo di una card).

## (c) Stop
`stop_agent` su un figlio in corsa su un nodo ⇒ `cancelRun` annulla la corsa
remota; il figlio esce come fermato, non come riuscito.

## (d) Prova dal vivo
8 figli in parallelo con Mac sotto 6 GB disponibili: almeno 4 finiscono sul
nodo permanente; `ps` sul Mac durante la prova non mostra processi dei figli
remoti.

## Comandi (escono non-zero se rotti)
- Test locali solo sui file toccati dalla change (`bun test <file>`); il resto
  si legge dalla CI della PR (typecheck, lint, dead-code, unit, lingua
  commenti/identificatori, em-dash).

## Mutanti (ognuno deve far diventare rosso almeno un test)
- Un figlio con `stayLocal` (cartella non git, o macOS/browser/sessioni/Jarvis
  vivo) finisce comunque su un nodo.
- `stop_agent` su un figlio remoto non chiama `cancelRun` (la corsa resta viva
  sul nodo dopo lo stop).
- Il pavimento del Mac per un figlio remoto è ancora quello delle card
  (`isRemoteTask`-equivalente mancante).
- Un figlio che resta sul Mac continua a pagare il prezzo di una card invece
  del suo costo vero.
- Un nipote (sottoagente di un sottoagente) parte su un nodo o sul Mac anziché
  essere rifiutato come oggi.
