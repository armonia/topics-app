# Acceptance: agenti-in-topics

## AGCFG-01 Anagrafica di Jarvis e Visione
Scenario: apro Agenti, vedo la salute dei canali, le incoerenze, la personalità di Jarvis, le sue 3 chat. Spengo «Brief del mattino»: parte `{id:"j1",paused:true}` e la nota dice Salvato. Passo a Visione: una chat, il suo lavoro; accendo «Solo se citato»: parte `{channel,chat:"200",account:"visione",mention:true}`. Modifico la personalità e salvo: parte con `agent:"gtm"`.
Senza jarvis-channels la vista resta la lista delle sessioni.

Barra: `pw-remote -- npx playwright test tests/e2e/agents-config.spec.ts` (video on) esce 0.

Mutazione: togliendo `account: c.account` dal post della chat in `AgentProfiles.tsx` lo scenario è rosso (provato il 09/11: 1 failed).

## AGCFG-02 Scritture sicure
`bun test server/routes/agent-config.test.ts`: ogni scrittura lascia il backup, un input sbagliato (chat inesistente, booleano non booleano, file fuori elenco, testo vuoto) è rifiutato e il file resta identico, la modifica di una chat di Visione non tocca la regola di Jarvis, i token non escono (solo «Portachiavi: …»).
