# Tracce
1. Lettura dell'anagrafica e incoerenze (`server/routes/agent-config.ts`, `readRegistry`). Barra: AGCFG-02.
2. Scritture con backup e riavvio a zero turni (`applyEdit`, `reload`). Barra: AGCFG-02.
3. Vista (`AgentProfiles.tsx`, `AgentsPane.tsx`, i18n). Barra: AGCFG-01 con mutazione.
4. Istruzioni per chat, chi può scrivere, orari dei lavori (`applyEdit` chat/job, `validateSchedule`, `ChatEditor`, `JobEditor`). Barra: AGCFG-03, mutazione sui senders.
5. Pulizia dei dati veri (fatta il 10/11, backup `backups/*.20261110T014643-pulizia-doppioni`): 3 regole morte di Visione tolte, numero di Attilio in una forma, 40 lavori con agente esplicito.
