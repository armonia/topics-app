-- 101: il REGISTRO delle notifiche. Quello che finora non esisteva.
--
-- Fino a qui una notifica era spara-e-dimentica: `notifyNative` in
-- client/src/lib/shell/app.ts posta il banner del sistema, `maybeSendPush` in
-- server/push-triggers.ts manda la push, e finisce lì. Nessuna riga da nessuna
-- parte. Conseguenza operativa, verificata prima di scrivere questa tabella: la
-- cronologia non è una VISTA su un dato che c'era già, è un dato NUOVO. Il
-- giorno in cui si accende comincia vuota, e va detto invece di riempirla di
-- una lista finta ricostruita a posteriori (non è ricostruibile: `mentions` è
-- un'altra cosa — le menzioni dentro i messaggi — e `activity_log` non registra
-- ciò che è stato MOSTRATO all'utente).
--
-- IL NUMERO è 101 perché main sta a 100 (`task-labels`). Due file con lo stesso
-- numero e il runner applica il primo e SALTA il secondo, in silenzio — vedi il
-- commento in testa alla 100 e `scripts/check-migration-numbers.ts`.
--
-- ── COSA REGISTRA, E PERCHÉ QUESTE COLONNE ──────────────────────────────────
--
-- `target_url` è la METÀ PIÙ IMPORTANTE della richiesta, non un extra. Una
-- cronologia in cui il click non porta da nessuna parte è una lista di rimpianti:
-- ti dice che qualcosa è successo e ti lascia a cercarlo. La destinazione si
-- SALVA al momento dell'invio perché dopo non è più deducibile (il topic può
-- essere archiviato, il task chiuso). Il formato è quello che il client sa già
-- aprire — `/task/<id>` e `/topic/<id>`, le stesse rotte dei deep-link
-- (client/src/lib/openTaskLink.ts) e delle push (`taskUrl`/`topicUrl`).
--
-- `dedupe_key` esiste perché la STESSA notifica ha più di un mittente:
--   · con i gruppi staccati il frame WS arriva a N finestre, e ognuna chiama
--     `fire()` — N POST identici a millisecondi di distanza;
--   · un `task:review-ready` produce insieme il banner nativo (client) e la
--     push (server): un evento, due porte.
-- Il registro deve avere UNA riga per evento, non una per superficie. Il
-- confronto è a FINESTRA (vedi NOTIFICATION_DEDUPE_MS), non un UNIQUE secco:
-- un vincolo di unicità perpetua ingoierebbe per sempre la seconda review
-- legittima dello stesso task fra un mese.
--
-- `group_key` è il cancello del «visto» sui RAGGRUPPAMENTI. Una notifica che
-- raggruppa più eventi (il `tag` che sul web collassa i banner dello stesso
-- topic) deve valere come UNA cosa da guardare: segnare visto un membro segna
-- visti tutti quelli del gruppo, altrimenti il contatore non torna mai a zero.
-- È un difetto già pagato una volta (il «visto» che mancava sui rollup).
--
-- `seen_at` è GLOBALE, non per dispositivo: la persona è una, e un contatore che
-- riparte da capo cambiando finestra è rumore. Chi vuole decidere COSA arriva su
-- QUESTO dispositivo lo fa nelle preferenze delle notifiche, che sono un'altra
-- cosa e restano device-local.
--
-- ── TETTO E SCADENZA (scritti, non impliciti) ───────────────────────────────
-- 500 righe, 30 giorni: il taglio lo applica il writer a ogni inserimento
-- (server/db/notification-log.ts). Senza una politica scritta in un mese questa
-- tabella diventa illeggibile e la cronologia perde il suo unico scopo, che è
-- «cosa mi sono perso ADESSO».

CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- Che genere di evento era: 'task-review', 'task-parked', 'chat-message',
  -- 'session', 'terminal', 'approval', 'other'. Non c'è CHECK di proposito —
  -- il vocabolario vive in shared/notification-log.ts e lo applica il layer
  -- route. Un CHECK sarebbe una seconda lista libera di divergere dalla prima
  -- (vedi 029-terminal-session-type-check.sql).
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- Dove porta il click. NULL = da nessuna parte (la riga resta leggibile, ma
  -- non è cliccabile: meglio di un click che non fa niente).
  target_kind TEXT,
  target_id TEXT,
  target_url TEXT,
  -- Da quale porta è uscita: 'banner' (nativo, deciso dal client) o 'push'
  -- (web-push, deciso dal server). Serve a leggere il registro quando una
  -- notifica «non è arrivata»: dice quale catena l'ha prodotta.
  source TEXT NOT NULL DEFAULT 'banner',
  dedupe_key TEXT NOT NULL,
  group_key TEXT,
  seen_at TEXT
);

-- La lettura è sempre «le ultime N, dalla più recente».
CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at DESC);
-- Il dedup guarda «questa chiave, negli ultimi secondi».
CREATE INDEX IF NOT EXISTS idx_notification_log_dedupe ON notification_log(dedupe_key, created_at DESC);
-- Il contatore è una COUNT sulle non viste: indice parziale, resta piccolo.
CREATE INDEX IF NOT EXISTS idx_notification_log_unseen ON notification_log(seen_at) WHERE seen_at IS NULL;
