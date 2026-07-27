-- 057: attesa dichiarata di un agente (external-condition wait).
--
-- Un agente dispatchato che deve aspettare una condizione esterna (un servizio
-- che torna su, carico macchina sotto soglia) NON deve dormire con un poller
-- tenendo occupato il suo slot: dichiara l'attesa (wait_for_condition), il task
-- torna in `todo` con la nota e il chip `waiting`, e `dispatch_deferred_until`
-- lo tiene fuori dalla coda finché non scade la finestra — poi il tick lo
-- ri-dispatcha da solo. NULL = nessuna attesa (comportamento identico a oggi).
ALTER TABLE tasks ADD COLUMN dispatch_deferred_until TEXT;
