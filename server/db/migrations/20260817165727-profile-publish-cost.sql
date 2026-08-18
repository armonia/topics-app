-- Opzione di mostrare la spesa in dollari sulla pagina pubblica del profilo.
-- DEFAULT 0 (falso): la pagina pubblica non rivela la spesa senza consenso
-- esplicito. Chi lo vuole lo attiva dalle impostazioni del profilo.
ALTER TABLE app_settings ADD COLUMN profile_publish_cost INTEGER NOT NULL DEFAULT 0;
