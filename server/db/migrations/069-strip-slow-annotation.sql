-- 069: toglie l'annotazione "stream lento" dal contenuto dei messaggi.
--
-- Quando il timeout morbido scattava, il server appendeva a `messages.content`
-- la stringa `\n\n---\n*[⏱ stream lento — il provider è ancora connesso]*`,
-- contando di rimuoverla al recupero con `stripSlowAnnotation()`, che taglia per
-- SUFFISSO. Nei dati reali quel round-trip non ha mai funzionato, per due difetti
-- indipendenti — entrambi visibili nelle righe che questa migration bonifica:
--
--   1. il ramo per contenuto vuoto scriveva `STREAM_SLOW_ANNOTATION.trimStart()`,
--      cioè SENZA il `\n\n` iniziale, mentre `stripSlowAnnotation` confronta
--      `endsWith()` con la stringa COMPLETA: la forma scritta non era la forma
--      cercata, e nessuno strip poteva agganciarla. È il caso comune (il modello
--      è lento a PARTIRE, quindi il contenuto è vuoto): tutte le righe misurate
--      sono di questa forma;
--   2. al recupero il testo nuovo veniva appeso DOPO l'annotazione, che da quel
--      momento non era più un suffisso — quindi neppure la forma completa era
--      recuperabile per suffisso.
--
-- Non è un residuo estetico: quel testo sta dentro un messaggio assistant, quindi
-- torna al modello a OGNI turno successivo come se l'assistente lo avesse detto.
-- Stessa aritmetica del preambolo: costo = token × risposte successive.
--
-- Misurate 63 righe in `content` e 1 in `blocks` sul DB reale. Dal 30/07 il
-- server non la scrive più: la lentezza la mostra `TurnActivityIndicator`, che
-- vive quanto il turno e sparisce con lui.
--
-- `replace()` e non un taglio per lunghezza: l'annotazione va rimossa DOVUNQUE
-- sia finita, non solo in coda. Rimuoverla ricongiunge il testo prima e dopo, che
-- è esattamente il contenuto che l'assistente ha prodotto. In `blocks` la stessa
-- sequenza è JSON-escaped (`---\n` diventa `---\\n`), quindi va sostituita nella
-- sua forma escaped.

-- content — forma scritta dal ramo "contenuto vuoto" (senza \n\n iniziale)
UPDATE messages
   SET content = replace(content, '---' || char(10) || '*[⏱ stream lento — il provider è ancora connesso]*', '')
 WHERE content LIKE '%*[⏱ stream lento — il provider è ancora connesso]*%';

-- content — forma completa (nessuna riga la usa oggi, ma un server ancora in
-- volo con il codice vecchio può scriverla prima del riavvio)
UPDATE messages
   SET content = replace(content, char(10) || char(10) || '---' || char(10) || '*[⏱ stream lento — il provider è ancora connesso]*', '')
 WHERE content LIKE '%*[⏱ stream lento — il provider è ancora connesso]*%';

-- blocks — la timeline JSON, con la sequenza escaped
UPDATE messages
   SET blocks = replace(blocks, '---\n*[⏱ stream lento — il provider è ancora connesso]*', '')
 WHERE blocks LIKE '%*[⏱ stream lento — il provider è ancora connesso]*%';
