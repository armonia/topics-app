# Agenti e Sistema: gerarchia, harness, strumenti, memorie

## Da decidere
1. **La gerarchia dei mockup** (Agenti › agente › Configura; Sistema › Salute, Harness, Strumenti, Memorie) è quella giusta? Consigliata: sì, perché toglie la configurazione dalla pagina dell'agente e dà un posto a strumenti e memorie, che oggi non ce l'hanno. Alternativa: tenere la configurazione nella pagina dell'agente, a schede invece che in colonna.

ok / ok ma 1 no

## Perché
- La pagina Agenti mette tutto su una colonna: personalità, modello, 49 regole di chat (metà con l'id al posto del nome), 148 lavori. Non c'è una vista d'insieme degli agenti né un posto per crearne uno.
- Gli agenti sono cablati nel server (`server/routes/agent-config.ts:23-25`): contro la regola zero.
- Strumenti e contesto stanno in due popover del menu; le memorie non hanno UI. Un guasto di sistema (una memoria che un agente non riceve, regole che si contraddicono) non si vede.
- La persona non ha strati: ogni agente ha i suoi IDENTITY, SOUL, USER e AGENTS interi. L'anima comune e le regole dell'utente stanno nel SOUL di un solo agente; un agente nuovo parte da zero e ne esce peggiore.
- I canali si leggono come testo («discord · …»), mentre il resto del design system usa le icone di marca (`client/src/lib/brandIcons.tsx`, `CHANNEL_MARKS`).

## Cosa cambia
- **Agenti** (barra laterale): panoramica con una scheda per agente (icone dei canali, stato, peso del contesto), «Da sistemare» e attività. **Agente**: Attività di default, Configura su una pagina sua con una colonna di sezioni (Identità, Mestiere, Canali e chat, Lavori, Strumenti, Memoria, Modello e account, Contesto ricevuto, File e backup). Ogni valore preso dal sistema è segnato «ereditato» e porta dove si cambia.
- **Sistema** (in fondo alla barra): pagina vera al posto dei popover. Salute (tutti i problemi, ognuno col link a dove si sistema), Harness (gli strati e il loro peso, le contraddizioni, il rimando alla pagina di ogni agente), Strumenti (catalogo unico: server MCP, skill, comandi; chi li usa), Memorie (ogni deposito: chi lo riceve da solo, indice, ricerca, lettura e modifica).
- **Persona a strati**: base di Topics (anima e regole comuni, generica, nel repo) → regole dell'utente (una volta, nei dati) → agente (identità e mestiere, più eventuali aggiunte). Un agente nuovo scrive solo l'identità. Una sola funzione assembla gli strati, e la usa chi esegue i turni.
- **Strumenti per agente**: «tutti» di default, «solo questi» come filtro sul catalogo, applicato davvero al turno.
- **Memoria per agente**: sua, condivisa o sola lettura, letta dalla configurazione.
- `solido` ha la parola **Visibile**: niente stato o guasto che l'utente deve governare vive solo in un file o in un log.

## Barra
`specs/acceptance.md`: test per traccia, due scenari e2e con video, mutazioni sui punti critici. Ciò che è verde resta verde.

## Fuori
- Spostare il motore dei canali dentro questo repo (decisione a parte, vedi la card dei repo).
- Nuovi canali, nuovi tipi di strumenti, quote e costi per agente.
- Il ridisegno delle Automazioni (sono lavori a orario: qui si linkano, non si rifanno).

## Deciso dall'agente
- Le regole dell'utente lasciano il SOUL dell'agente e passano allo strato utente; i permessi che nominano persone restano aggiunte dell'agente che li aveva (non si allargano agli altri agenti da soli).
- La base generica vive nel repo (`server/agents/base/`), i dati dell'utente fuori; senza dati dell'utente la base funziona da sola.
- I pesi degli altri harness (Claude Code, Codex, jcode) vengono dall'hub solo se c'è: senza hub la sezione dice cosa manca, non sparisce.

## Non ancora specificato
- Come si chiamano gli strati nella UI per chi non sa cos'è un harness: «Base», «Le tue regole», «Agente» sono provvisori, si giudicano sul mockup.
