-- 079: modalità notturna della board — dispaccia solo a macchina scarica, e si
-- ferma a un orario.
--
-- Portata dentro Topics da un turno notturno che viveva fuori
-- (`~/jarvis/master/bin/master-night.sh`): si arma quando la persona se ne va,
-- parte quando le sessioni finiscono e il carico scende, si ferma alle 10.
--
-- Tre colonne e non una, perché le tre cose rispondono a domande diverse:
--
--  · `night_mode`        — l'interruttore. Lo accende una PERSONA, mai il
--    sistema: il senso è «vado via», e nessuna euristica lo sa.
--
--  · `night_mode_until`  — QUANDO SMETTERE, `HH:MM` sull'orologio locale. Un
--    turno che non sa finire è peggio di uno che non parte: senza fine
--    resterebbe armato il giorno dopo, addosso a chi lavora.
--
--  · `night_mode_started_at` — quando è stato acceso, ISO 8601. Serve a
--    calcolare la fine: «fino alle 10:00» acceso alle 23:00 vuol dire domani
--    mattina, acceso alle 02:00 vuol dire stamattina. Senza l'istante di
--    accensione i due casi sono indistinguibili.
--
-- Tutte NULLable / default spento: nessuna board esistente cambia comportamento
-- finché qualcuno non accende l'interruttore.
ALTER TABLE board_settings ADD COLUMN night_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_settings ADD COLUMN night_mode_until TEXT;
ALTER TABLE board_settings ADD COLUMN night_mode_started_at TEXT;
