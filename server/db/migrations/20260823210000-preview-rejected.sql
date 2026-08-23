-- Il ritiro di un'anteprima deve ricordare COSA ha respinto.
--
-- `preview_retired_at` dice che l'immagine se n'è andata e perché, ma non
-- quale fosse. E l'immagine non se n'è andata davvero: resta allegata al
-- commento con cui era arrivata, che è il posto da cui la card l'aveva presa.
-- Alla ripartenza la spazzata d'avvio (`sweepReviewPreviews`) ripassa sulle
-- card in review senza anteprima, ripesca l'ultimo allegato del thread e
-- rimette esattamente la foto appena bocciata — spegnendo il ritiro, perché
-- un'anteprima nuova per contratto lo supera.
--
-- Misurato il 23/08 su quattro card in review di topics-app: tutte con la nota
-- «Anteprima: ritirata», tutte con `preview_retired_at` NULL e la stessa
-- immagine ancora sulla card. Il ritiro non sopravviveva a un riavvio.
--
-- Qui il ritiro prende memoria: i path respinti restano scritti sulla card, e
-- chi promuove un allegato li salta. Non si cancella nessun commento — la
-- storia resta, e il file su disco pure: smette solo di essere spacciato per
-- evidenza di questo lavoro.
ALTER TABLE tasks ADD COLUMN preview_rejected TEXT;

-- Recupero del passato: le card che portano una nota di ritiro ma non hanno mai
-- avuto lo stato scritto (il ramo «pagina bianca» del preview-manager azzerava
-- l'immagine senza motivarla). Si accende il ritiro E si registra come respinta
-- l'immagine che ancora mostrano, che è precisamente quella che la nota accusa.
UPDATE tasks SET
  preview_rejected = json_array(preview_image),
  preview_retired_at = (
    SELECT max(c.created_at) FROM task_comments c
    WHERE c.task_id = tasks.id AND c.content LIKE 'Anteprima: ritirata%'
  ),
  preview_retired_reason =
    'lo screenshot non mostrava il lavoro di questa card ma lo stato vuoto dell''app',
  preview_image = NULL
WHERE preview_retired_at IS NULL
  AND preview_image IS NOT NULL
  AND trim(preview_image) <> ''
  AND EXISTS (
    SELECT 1 FROM task_comments c
    WHERE c.task_id = tasks.id AND c.content LIKE 'Anteprima: ritirata%'
  );
