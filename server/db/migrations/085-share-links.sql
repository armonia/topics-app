-- 085: i link di condivisione — una CAPACITÀ, non un accesso.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COS'È UN LINK, E PERCHÉ NON È UN LOGIN
--
-- Fuori dalla rete di casa non si può chiedere a un ospite di appaiare un
-- dispositivo: l'appaiamento vuole che qualcuno guardi due schermi vicini e
-- confronti un codice. Da lontano quel gesto non esiste.
--
-- Quindi il link È la credenziale, e vale per UNA cosa sola. Non ti fa entrare:
-- ti fa vedere quella. È la differenza fra una chiave di casa e il biglietto di
-- un cinema — e sceglierla è ciò che rende accettabile che il link giri in una
-- chat, che è dove i link girano davvero.
--
-- La conseguenza va guardata in faccia invece che nascosta: chi ha il link
-- entra. Non c'è un secondo fattore, non c'è un «sei tu?». Per questo:
--   * ha una SCADENZA, e non opzionale;
--   * si revoca, e la revoca è immediata;
--   * chi lo crea deve LEGGERE queste due cose accanto al pulsante, non
--     scoprirle dopo.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA CHIAVE STA QUI, E IL RELAY NON CE L'HA
--
-- `key` è la chiave AES con cui la macchina cifra e l'ospite decifra. Vive su
-- QUESTA macchina perché è questa macchina a cifrare; nel link viaggia nel
-- FRAMMENTO dell'URL, la parte dopo `#` che il browser non manda mai a nessun
-- server. Quindi il relay instrada e non capisce, e questo è vero per
-- costruzione e non per policy.
--
-- Non si conserva un hash al posto della chiave, come si fa per i token di
-- sessione: lì il server deve solo VERIFICARE, qui deve CIFRARE. Un hash non
-- cifra niente. È la ragione per cui questa colonna è un segreto vero, e per cui
-- il file del database va trattato come tale — la stessa nota della 080 sul
-- perché `devices.token_hash` invece è un hash.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PERCHÉ UNA TABELLA E NON UNA COLONNA SU `grants`
--
-- Una concessione dice «questo soggetto può vedere questa cosa». Un link dice
-- «chi ha questa stringa può vedere questa cosa», e non ha un soggetto: è
-- anonimo per costruzione. Sono due frasi diverse, e infilarle nella stessa
-- riga vorrebbe dire un `subject_id` che a volte è qualcuno e a volte è un
-- segreto — cioè una colonna che significa due cose, che è il modo in cui un
-- modello comincia a mentire.
CREATE TABLE IF NOT EXISTS share_links (
  -- Il riferimento PUBBLICO: sta nel percorso del link e passa dal relay, che
  -- lo usa per instradare. Non apre niente da solo — senza la chiave nel
  -- frammento non c'è niente da leggere.
  ref           TEXT PRIMARY KEY,
  -- La chiave di cifratura, in base64url. Vedi sopra: è un segreto vero.
  key           TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('task', 'topic')),
  resource_id   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- NOT NULL di proposito: un link che non scade è un link che qualcuno
  -- ritroverà in una chat fra due anni e che funzionerà ancora.
  expires_at    INTEGER NOT NULL,
  -- Revoca immediata, e la riga resta: dice che quel link c'è stato e quando
  -- gli è stata tolta la validità. Stessa scelta di `devices.revoked_at`.
  revoked_at    INTEGER,
  -- Quante volte è stato aperto. Non è statistica: è l'unico modo per
  -- accorgersi che un link è finito dove non doveva.
  opened_count  INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER
);

-- La domanda dell'interfaccia: «questa cosa ha un link attivo?».
CREATE INDEX IF NOT EXISTS idx_share_links_resource
  ON share_links(resource_type, resource_id, revoked_at);
