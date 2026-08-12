-- 101-push-device-prefs.sql: l'iscrizione push diventa un DISPOSITIVO, con le
-- sue preferenze.
--
-- `push_subscriptions` (migration 006) teneva soltanto l'endpoint e le chiavi:
-- abbastanza per spedire, non abbastanza per governare. Fino a oggi non si
-- vedeva, perché la tabella era VUOTA — nessuno si era mai iscritto. Nel
-- momento in cui il telefono si iscrive servono tre cose che la riga non sa
-- dire:
--   · CHI è          → `device_id` + `device_label`. L'endpoint è un URL di
--     Apple/Google lungo 200 caratteri: non è una cosa da mostrare a un umano, e
--     non sopravvive a una re-iscrizione (il browser lo rigenera). `device_id`
--     è generato dal client e vive nel suo localStorage, quindi è LUI la
--     continuità del dispositivo attraverso le re-iscrizioni.
--   · se PARLA       → `enabled`. Per-endpoint, cioè per-dispositivo: è il
--     punto dell'intera card. Un interruttore globale che spegne il telefono
--     mentre spegne anche il Mac non è una preferenza, è un danno collaterale.
--   · cosa fa QUANDO L'APP È APERTA → `when_open`: `native` (il service worker
--     mostra il banner di sistema, la pagina tace) oppure `in-app` (a finestra
--     visibile il banner lo disegna la pagina e il sistema tace). Una voce sola
--     in entrambi i casi; cambia solo quale.
--
-- `last_seen_at` è la data dell'ultima iscrizione/heartbeat: serve a distinguere
-- «questo dispositivo c'è» da «questa è una riga di un telefono che non hai più»
-- nell'elenco delle impostazioni, senza doverlo dedurre dall'assenza di errori.
--
-- Niente DEFAULT sui valori esistenti da correggere: la tabella è vuota (0
-- righe, misurato prima di aprire la card), quindi i default valgono solo per le
-- righe future. `enabled = 1` perché ci si iscrive per ricevere; `when_open =
-- 'native'` perché è quello che l'utente ha chiesto — ad app aperta, al massimo
-- la notifica nativa.
ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN device_label TEXT;
ALTER TABLE push_subscriptions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN when_open TEXT NOT NULL DEFAULT 'native';
ALTER TABLE push_subscriptions ADD COLUMN last_seen_at TEXT;

-- Un dispositivo = una riga. Il browser può rigenerare l'endpoint (chiavi
-- ruotate, PWA reinstallata) e senza questo indice la vecchia riga resterebbe
-- lì a ricevere push che nessuno consegna più, e a comparire nell'elenco come un
-- secondo telefono che non esiste. `device_id` è NULL per le righe legacy senza
-- id: l'indice UNIQUE in SQLite ignora i NULL, quindi non le collega fra loro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_device
  ON push_subscriptions(device_id);

INSERT INTO schema_migrations (version, name, applied_at) VALUES (100, 'push-device-prefs', datetime('now'));
