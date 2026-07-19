-- 055: anteprima della consegna sulla card Kanban.
--
-- `preview_image` = path assoluto di uno screenshot del deliverable (stesso
-- allowlist dei media dei commenti, servito da /api/media). La card lo rende
-- come thumbnail: la review parte guardando la cosa, non leggendo il titolo.
-- NULL = nessuna anteprima (card identica a oggi).
ALTER TABLE tasks ADD COLUMN preview_image TEXT;
