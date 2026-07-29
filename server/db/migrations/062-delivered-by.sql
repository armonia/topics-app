-- Chi ha portato il task in review, e perché.
--
-- Oggi in colonna Review una card che l'agente ha consegnato e una che il sistema
-- ha portato lì da solo (budget di tentativi finito, modello che si rifiuta) hanno
-- lo stesso identico aspetto. Sono due cose diverse: nella prima c'è un deliverable
-- da guardare, nella seconda c'è un turno finito male da cui forse non è uscito
-- niente. Il reviewer deve saperlo PRIMA di aprire, non dopo.
--
-- delivered_by: 'agent' | 'human' | 'system'. NULL = mai passato per la review.
-- delivered_reason: codice macchina della causa, valorizzato SOLO per 'system'
-- ('retries_exhausted', 'model_refused'). La prosa resta nel commento di sistema:
-- questo serve alla UI per dire la cosa giusta senza fare parsing di un testo.
ALTER TABLE tasks ADD COLUMN delivered_by TEXT;
ALTER TABLE tasks ADD COLUMN delivered_reason TEXT;
