-- 095: CHI ha scritto questo messaggio.
--
-- `messages` nasce nella 001 e da allora ha `role` — 'user' o 'assistant' — e
-- nient'altro che dica da chi arriva. Finché l'unico umano era il proprietario
-- del Mac, `role='user'` ERA l'autore. Dalla 084 le persone sono N, e «l'ha
-- scritto un utente» ha smesso di essere una risposta: non si può dire di chi
-- sia un prompt, quindi non si può contare quanti ne fa una persona né quanto
-- consuma — che è esattamente ciò che i profili degli amici devono mostrare.
--
-- DUE COLONNE, NON UNA. La persona è il SOGGETTO (è lei che compare su un
-- profilo, ed è lei che sopravvive a un telefono cambiato); il dispositivo è il
-- CREDENZIALE con cui quel messaggio è entrato. Tenerne una sola costringe a
-- scegliere fra «non so da quale telefono» e «non so di chi è», e nessuna delle
-- due assenze è recuperabile dopo.
--
-- NULL È UNA RISPOSTA, ed è quella giusta per: ogni messaggio dell'assistente
-- (l'autore è un modello, non una persona — scriverci qualcuno renderebbe il
-- conteggio dei prompt il doppio del vero), i messaggi importati da un
-- transcript della CLI, e tutto ciò che è stato scritto prima di oggi su una
-- macchina con più di un proprietario.
ALTER TABLE messages ADD COLUMN author_person_id TEXT REFERENCES people(id);
ALTER TABLE messages ADD COLUMN author_device_id TEXT REFERENCES devices(id);

-- La domanda calda è «quanti messaggi e quanti token ha questa persona»:
-- l'indice la copre e resta piccolo perché salta le righe senza autore, che
-- sono la stragrande maggioranza (ogni risposta dell'assistente).
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_person_id)
  WHERE author_person_id IS NOT NULL;

-- IL RIEMPIMENTO, e la condizione che lo rende un FATTO invece di un'ipotesi.
--
-- Si scrive un autore sui messaggi utente già in archivio SOLO se questa
-- installazione ha ESATTAMENTE UN proprietario. In quel caso non si sta
-- indovinando: su questa macchina c'era una persona sola, e ogni prompt è suo.
-- Con due proprietari la stessa riga sarebbe un'invenzione — e un'invenzione
-- che poi si LEGGE come una misura, sopra un numero che dice «tu fai 4.000
-- prompt» a chi non ne ha fatto mezzo.
--
-- `role = 'user'` e non tutte le righe: l'autore di una risposta è un modello.
UPDATE messages
   SET author_person_id = (SELECT person_id FROM installation_owners)
 WHERE role = 'user'
   AND author_person_id IS NULL
   AND (SELECT COUNT(*) FROM installation_owners) = 1;
