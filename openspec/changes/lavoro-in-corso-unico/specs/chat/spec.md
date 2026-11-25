## MODIFIED Requirements

### Requirement: BGVIS-10 — Una chat senza turno aperto dice cosa aspetta, e scrive solo quando scrive

La tab e la riga della sidebar di una chat il cui turno è chiuso e che aspetta
lavoro SHALL dire che aspetta, e cosa: `data-waiting-on` sul glifo vale
`subagent` (un figlio di `spawn_agent`), `process` (un `run_command` che la
sveglierà), `job` (un compito della CLI: un Agent, un Bash, un Monitor) o
`resuming` (un report la sta già svegliando), in quest'ordine. Il lavoro che
gira è lavoro (ATTN-02): il glifo è il loader del lavoro, col movimento di ciò
che gira (`delegate` per i sottoagenti e gli Agent, `run` per un comando), MAI il
movimento lento di `wait`, che resta a ciò che aspetta la persona (23/11: una
chat con quattro agenti al lavoro sotto si leggeva come ferma). Il tooltip dice
cosa gira, quanti agenti, e che la chat è libera. Con un turno aperto il glifo è
quello di chi scrive (`data-waiting-on` assente); a lavoro finito non resta
niente, né sulla tab né sulla riga.

I figli di `spawn_agent` sono righe di `subagents` che né lo snapshot della CLI né
il registro dei processi conoscono: lo stato di attenzione li SHALL avere come UN
compito `subagent` della mappa (`withSubagentTask`; `wake` quando resta solo un
risultato da consegnare), riscritto a ogni cambio (un figlio nato, un suo turno
aperto o chiuso, un risultato aggiunto o consegnato, il suo stato:
`observeSubagentWaitChanged`) e non solo alla fine del turno del genitore. Il
compito è nella mappa e non ha una riga sua nel testo: i figli stanno già nella
striscia sotto la chat, e lo Stop del compositore non gli si applica.

- Un riavvio non li uccide: un figlio ancora in corso o con un risultato dovuto
  resta nella mappa (`subagentOwed`); uno finito a server spento esce senza il
  rosso «il processo è finito con N compiti in volo».
- La cartella di progetto continua a contare la chat come «con lavoro dentro»
  (ATTN-12): questa clausola riguarda tab e riga.
- La riga della sidebar SHALL dirlo anche a parole, al posto dell'ultimo
  messaggio: «N sottoagenti al lavoro» quando ce n'è almeno uno al lavoro
  (SUBAGENT-30, `data-agents`), «Aspetta un sottoagente» quando i figli devono
  solo consegnare, «Processo in corso», «Lavoro in background in corso», «Sta
  per riprendere» (`topic-waiting-on`, con lo stesso `data-waiting-on` del
  glifo). Con un turno aperto non c'è.
- Un figlio finito SHALL essere detto UNA volta: quando la sua card di esito è
  già nella trascrizione (`subagent-result-card`, che dice come è finito:
  «fermato prima di finire», «completato»), la striscia sotto la chat NON SHALL
  avere la sua riga «finito» (`useSubagentResultIds`). Finché la card non c'è la
  riga resta; un figlio vivo la tiene sempre.

#### Scenario: la tab dice cosa aspetta e si ferma quando tutto è finito
- **GIVEN** una chat il cui turno ha lasciato un Bash in background, e un figlio
  di `spawn_agent` vivo
- **THEN** tab e riga hanno `data-waiting-on="job"`, poi `"subagent"` col figlio
- **WHEN** un messaggio apre un turno
- **THEN** il glifo è quello di chi scrive, senza `data-waiting-on`
- **WHEN** il turno chiude, il lavoro riporta e il figlio è fermato
- **THEN** né la tab né la riga hanno `data-waiting-on` né `data-loader-state`
  (`tests/e2e/tab-waiting-on-work.spec.ts`)
