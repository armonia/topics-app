-- Uno SCADUTO non e' un rosso: le card gia' marcate si rileggono.
--
-- Dal 18/08 `checksVerdict` scrive tre esiti invece di due, e la card disegna
-- «check non misurati» in ambra al posto di «checks rossi». Ma il verdetto
-- gia' scritto resta: misurate sul DB vivo, delle 15 card con `checks_state =
-- 'fail'` SEI portavano solo comandi SCADUTI al tetto dei 20 minuti — il 40%
-- delle bocciature accusava un codice sano, e chi rivedeva leggeva rosso.
--
-- Il predicato e' quello di `checksVerdict`, riscritto in SQL sull'unica cosa
-- che il DB sa leggere di `checks_json`: la presenza di un fallimento NON
-- scaduto. La forma serializzata e' stabile — `"ok":false` e `"timedOut":true`
-- senza spazi, scritta da `JSON.stringify` — ed e' l'unica ragione per cui
-- questa domanda si puo' fare con un LIKE.
--
-- SI SBAGLIA VERSO IL ROSSO. Se il JSON e' assente, illeggibile o contiene
-- ANCHE UN SOLO `"ok":false` che non sia scaduto, la riga non si tocca: meglio
-- un rosso di troppo (si guarda e si scopre che era un timeout) che un rosso
-- tolto a una consegna davvero rotta.
UPDATE tasks SET checks_state = 'unknown'
 WHERE checks_state = 'fail'
   AND checks_json IS NOT NULL
   AND checks_json LIKE '%"ok":false%'
   -- almeno uno scaduto...
   AND checks_json LIKE '%"timedOut":true%'
   -- ...e nessun fallimento con un exit code vero. `"code":null` accompagna
   -- sempre e solo i comandi che non sono arrivati in fondo.
   AND checks_json NOT LIKE '%"ok":false,"code":0%'
   AND checks_json NOT LIKE '%"ok":false,"code":1%'
   AND checks_json NOT LIKE '%"ok":false,"code":2%'
   AND checks_json NOT LIKE '%"ok":false,"code":3%'
   AND checks_json NOT LIKE '%"ok":false,"code":4%'
   AND checks_json NOT LIKE '%"ok":false,"code":5%'
   AND checks_json NOT LIKE '%"ok":false,"code":6%'
   AND checks_json NOT LIKE '%"ok":false,"code":7%'
   AND checks_json NOT LIKE '%"ok":false,"code":8%'
   AND checks_json NOT LIKE '%"ok":false,"code":9%'
   AND checks_json NOT LIKE '%"spawnError"%';
