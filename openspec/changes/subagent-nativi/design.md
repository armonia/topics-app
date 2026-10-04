# Design — subagent-nativi

## §1 Il figlio è una chat a sé (scelta 1)

Un figlio nativo è un topic con `provider: "topics"`, `id` = agentId e session
key `topic:<id8>`. Il suo turno parte da `POST /api/chat` chiamato nel processo
(`deps.route`, lo stesso router del risveglio del padre e del goal loop), così
ogni garanzia della route vale anche per lui: righe, uso nel registro, cut del
contesto, ripresa dopo un riavvio, Stop. Lo stream si legge fino in fondo; poi
si aspetta che la sessione esca da `activeStreams` e si legge l'esito dalla chat
(ultima riga assistant dal momento dell'invio) e dal registro delle fini di
turno (`readTurnEnd`, solo se depositata dopo l'invio).

Il codice sta in `server/lib/native-subagents.ts`, configurato da `server.ts`
con il router, `activeStreams`, il salvataggio dei topic e la lettura dei
messaggi. Il resto dello stato è quello dei figli CLI: la riga `subagents`
(migrazione `20261004180000`: `runtime`, `session_key`, `tools`), la dedup e il
recapito di `subagent-runtime.ts` tramite `reportNativeChildTurn`.

Alternativa scartata: turno annidato dentro il padre. Avrebbe chiesto
profondità, budget, canale UI e annullamento costruiti da zero (CHAT-NTOOL-03).

## §2 Il runtime di default (scelta 2)

La route sceglie `topics` salvo `runtime: "claude-code"`. Ricade sulla CLI,
dicendolo nella risposta (`runtimeNote`), se il motore non è connesso o se il
figlio non avrebbe un progetto noto: un `projectPath` allarga le rotte dei file
del client a quella cartella, quindi una `cwd` qualunque scelta da un modello
non diventa la casa di una chat (`nativeChildPlace`). Chi chiede `topics`
esplicitamente riceve un rifiuto invece della ricaduta.

Modello: la catena di SUBAGENT-08, poi `engineModelOf` traduce gli alias nel
catalogo del motore. Profilo: corpo del file come system prompt del topic,
`tools:` tradotto (`subagent-tool-policy.ts`), applicato dal provider nativo
sia sugli schemi dichiarati sia all'esecuzione (`allowTool` del loop).

## §3 Profondità e tetti (scelta 3)

`MAX_AGENT_DEPTH` scende da 3 a 2, per entrambi i runtime. La profondità si
cammina sulle righe (`subagentDepth`): un figlio CLI ha per chiave il suo id,
uno nativo la session key della sua chat. Al tetto il provider nativo non
dichiara i cinque strumenti dei sotto-agenti e li rifiuta all'esecuzione; la
route rifiuta comunque con 429.

Un figlio nativo occupa un posto solo mentre il suo turno gira: a fine turno la
riga diventa `retired`, perché non c'è un processo da tenere acceso. I tetti di
5 per padre e 6 sul Mac contano quindi i figli al lavoro.

## §4 Stop

`stop_agent` chiama `/api/chat/abort` sulla chat del figlio (richiesta interna),
segna il figlio come fermato dal padre, archivia la chat. Lo Stop di una persona
sul padre (`/api/chat/abort` con causa `user`) chiama `stopNativeChildrenOf`
prima di fermare il turno del padre: i figli al lavoro si fermano, le chat
restano visibili. Il risultato `stopped-by-parent` non sveglia nessuno
(`resultWakesParent`).

## §5 Riavvio

I figli nativi `running` non passano da `reportLostChildren` (non hanno un
terminale). `adoptNativeChildrenAtBoot` parte dopo l'adozione dei turni
sopravvissuti: per un minuto guarda la chat; un turno ripreso si aspetta e si
riporta, uno che non torna si riporta `lost`.

## Non coperto

- La card «sotto-agenti al lavoro» del client (`SubAgentsStrip`) legge il
  roster dei terminali: i figli nativi non ci compaiono. Li si vede annidati
  sotto la chat padre nella sidebar (04/10, SUBAGENT-18: mai come chat a sé né
  come scheda) e come card dell'esito nella chat del padre.
- L'uso del figlio finisce nel registro sotto la SUA chat, non sommato a
  quello del padre.
