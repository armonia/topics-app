-- 080: i dispositivi autorizzati — la prima identità che questo server abbia mai
-- avuto.
--
-- Fino a stamattina il server non sapeva chi bussava, e non gli serviva: c'era un
-- pairing token unico, uguale per tutti, e prima ancora niente del tutto. Tolto
-- quello (change `lan-open-same-origin`), la porta è rimasta aperta a chiunque
-- raggiungesse `:3333` — e il server ascolta su OGNI interfaccia, non solo sulla
-- LAN di casa. Verificato lo stesso giorno da una seconda rete presente sulla
-- macchina: `GET /preview/<path assoluto>` → 200.
--
-- Difendersi elencando quali reti sono buone è una lista che marcisce: le
-- interfacce di una macchina non si enumerano in anticipo. L'identità no.
--
-- UN DISPOSITIVO, NON UN UTENTE. Il proprietario è uno. Ciò che serve è
-- distinguere QUALE dispositivo e poterlo togliere di mezzo — non registrare
-- persone. Niente password, niente account, nessun servizio esterno: il sito
-- vende `account: None` come differenziatore, e questo strato non lo smentisce.
--
-- `token_hash` E NON IL TOKEN. Il valore in chiaro esiste una volta sola, nel
-- cookie del dispositivo; qui resta solo lo SHA-256. Un backup del DB, o una
-- lettura del file via il file server ancora da sandboxare, non consegna le
-- sessioni. È la differenza fra un furto di dati e un furto di accessi.
--
-- `revoked_at` E NON UN DELETE. Una riga cancellata non racconta niente; una
-- revocata dice che quel dispositivo c'è stato e quando gli è stata tolta la
-- fiducia. Serve a chi legge dopo, ed è ciò che rende l'elenco in Impostazioni
-- una cronologia invece di un inventario.
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  -- Nome mostrato in Impostazioni e sopra la status bar. Proposto dallo
  -- user-agent al momento della richiesta, modificabile: «iPhone di Attilio»
  -- dice a un umano cosa sta guardando, «Mozilla/5.0 (iPhone; CPU iPhone OS…»
  -- no.
  name          TEXT NOT NULL,
  -- SHA-256 esadecimale del token di sessione. UNIQUE: due dispositivi non
  -- possono condividere una sessione, e un inserimento che ci provasse fallisce
  -- invece di sovrascrivere in silenzio.
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  -- Ultima richiesta servita. Scritto con parsimonia (non a ogni chiamata: sono
  -- ~94 per boot), serve all'elenco per dire «visto l'ultima volta…».
  last_seen_at  INTEGER,
  -- Da dove ha chiesto accesso la prima volta. Puramente informativo, per
  -- riconoscere una riga a distanza di settimane.
  first_ip      TEXT,
  -- NULL = attivo. Valorizzato = revocato, e la riga resta.
  revoked_at    INTEGER
);

-- Il gate cerca per hash a OGNI richiesta gated: senza indice sarebbe una
-- scansione per ogni chiamata dell'app.
CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(revoked_at, last_seen_at);
