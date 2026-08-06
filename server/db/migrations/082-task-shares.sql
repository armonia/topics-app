-- 082: ospiti, e i task che vedono.
--
-- `device-auth` (migration 080) ha dato al server un'identità: sa QUALE
-- dispositivo bussa. Ma tutti i dispositivi sono del proprietario e vedono
-- tutto, quindi «condividere un task con qualcuno» non era esprimibile — non
-- c'era un «qualcuno» diverso da te, e non c'era un «solo questo».
--
-- Due aggiunte, e nessun concetto nuovo di identità.
--
-- IL RUOLO sta sul dispositivo, non su una tabella di utenti. L'ospite È il
-- dispositivo. Introdurre qui un modello di «persona» significherebbe averne due
-- da tenere in sincrono — quello dei dispositivi, che decide gli accessi, e
-- quello delle persone, che decide i permessi — e il giorno che divergono il
-- permesso dice una cosa e l'accesso ne fa un'altra. Quando arriverà l'identità
-- del PROPRIETARIO (il login sul computer) servirà a firmare CHI ha condiviso,
-- non a sostituire questo.
--
-- `owner` di default, ed è deliberato: il caso normale è il tuo secondo telefono,
-- e un default `guest` renderebbe l'appaiamento normale una trappola in cui non
-- si vede niente e non si capisce perché. Il prezzo è che il default è anche il
-- più permissivo — per questo la scelta è esplicita nel cartello di approvazione
-- e il ruolo si legge nell'elenco, così un errore si vede e si corregge.
ALTER TABLE devices ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';

-- I task che un ospite può vedere. Riga presente = permesso; nessuna riga =
-- niente. Non c'è un permesso NEGATIVO di proposito: un elenco di divieti sopra
-- un default permissivo è la forma in cui i buchi si nascondono.
--
-- ON DELETE CASCADE su entrambi i lati: revocare un dispositivo o cancellare un
-- task non deve lasciare un permesso che punta al vuoto — e soprattutto non deve
-- lasciarlo pronto a rianimarsi se quell'id venisse riusato.
CREATE TABLE IF NOT EXISTS task_shares (
  task_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  shared_at  INTEGER NOT NULL,
  PRIMARY KEY (task_id, device_id),
  FOREIGN KEY (task_id)   REFERENCES tasks(id)   ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- La domanda calda è «quali task vede QUESTO ospite», una per richiesta.
CREATE INDEX IF NOT EXISTS idx_task_shares_device ON task_shares(device_id);
