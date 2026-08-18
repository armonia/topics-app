-- Token opaco nel percorso della pagina pubblica del profilo.
-- NULL = pagina spenta (restituisce 404). Non-null = pagina attiva all'URL
-- /public/profile/<token>. Il token si genera al primo click su «Pubblica»
-- e si azzera con «Revoca»: condividere e' un gesto, non uno stato del server.
-- DEFAULT NULL: la pagina e' spenta per tutti finche' il proprietario non la
-- pubblica esplicitamente — nessuno scopre l'URL per tentativi.
ALTER TABLE app_settings ADD COLUMN profile_share_token TEXT DEFAULT NULL;
