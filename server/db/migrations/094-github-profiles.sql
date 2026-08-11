-- 094: la faccia di un amico, e da dove arriva.
--
-- La 084 dice come si chiama una persona e la 095 quali messaggi sono suoi.
-- (Il numero più alto non è un refuso e non è un ordine: questa non dipende da
-- quella — aggiunge una colonna a `people` e una tabella nuova, e girerebbe
-- identica anche da sola. Le due si sono incrociate con le migration di main.)
-- Manca la sola cosa che rende un elenco di nomi un elenco di PERSONE: una
-- faccia. Non la si chiede all'utente — si prende da dove esiste già, cioè da
-- GitHub, che per chi scrive codice è l'anagrafe che tiene aggiornata davvero.
--
-- `people.github_login` — L'AGGANCIO, e nient'altro. Non un profilo dentro
-- `people`: il nome pubblico, l'avatar e il resto cambiano su GitHub e non qui,
-- e tenerli in una riga che chiamiamo «la persona» significa avere due verità
-- sullo stesso soggetto con la nostra che invecchia. Qui sta il login, che è
-- l'unica cosa che decidiamo noi.
ALTER TABLE people ADD COLUMN github_login TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_github ON people(lower(github_login))
  WHERE github_login IS NOT NULL;

-- ── LA COPIA DI CIÒ CHE È DI GITHUB.
--
-- Tabella a parte perché è CACHE, ed è la differenza che conta: si può
-- cancellare per intero senza perdere un dato di questa casa, e la si
-- ricostruisce con una richiesta. Se stesse dentro `people`, svuotarla vorrebbe
-- dire toccare la riga di una persona.
--
-- La chiave è il LOGIN e non `person_id`, ed è il verso giusto anche se
-- l'aggancio è uno a uno (l'indice UNIQUE qui sopra lo impone, come già per
-- l'email): il contenuto di questa tabella è di GitHub, quindi si indirizza col
-- nome che GitHub usa. In pratica significa che il profilo sopravvive a una
-- persona cancellata e ricreata, e che si può avere prima che qualcuno lo
-- agganci a qualcuno.
--
-- `fetched_at` NON è decorativo: l'API pubblica di GitHub dà 60 richieste
-- all'ora a chi non si autentica, e senza un timestamp da confrontare una
-- schermata con otto amici sopra le brucia in due aperture. È il campo che
-- decide se si esce sulla rete.
--
-- `failed_at`/`status` esistono perché anche il FALLIMENTO va ricordato. Un 404
-- (login sbagliato) o un 403 (quota finita) senza memoria si ritentano a ogni
-- disegno della lista, cioè si trasforma un errore in una tempesta di
-- richieste: la stessa forma con cui la quota è finita in primo luogo.
--
-- `COLLATE NOCASE` sulla chiave, e non è un vezzo: su GitHub `TorValds` e
-- `torvalds` sono LA STESSA PERSONA, e le due scritture di questo file entrano
-- con casing diverso — il fallimento si registra col login DIGITATO, il successo
-- con quello CANONICO che risponde l'API. Con una chiave binaria diventano due
-- righe, la lettura ne pesca una a caso, e il caso cattivo è quello in cui trova
-- la riga del fallimento: la faccia che abbiamo già scaricato non compare più,
-- in silenzio e per sempre. Con NOCASE l'ON CONFLICT le fonde ed è una riga sola.
CREATE TABLE IF NOT EXISTS github_profiles (
  login        TEXT PRIMARY KEY COLLATE NOCASE,
  name         TEXT,
  avatar_url   TEXT,
  html_url     TEXT,
  bio          TEXT,
  company      TEXT,
  location     TEXT,
  public_repos INTEGER,
  followers    INTEGER,
  fetched_at   INTEGER,
  failed_at    INTEGER,
  status       INTEGER
);
