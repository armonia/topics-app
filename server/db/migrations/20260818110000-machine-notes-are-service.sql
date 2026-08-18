-- Le note di macchina gia' scritte diventano NOTE DI SERVIZIO.
--
-- Dal 18/08 il GC, il landing audit e il percorso del land marcano da se'
-- `kind='service'` cio' che e' contabilita' (vedi il commento su `addComment`).
-- Ma il thread e' una cosa che RESTA: le 857 righe gia' scritte continuavano a
-- fare muro fra chi rivede e la parola di chi ha fatto il lavoro, e su una board
-- viva quel muro e' proprio quello che si sta guardando adesso.
--
-- `service` NON cancella: `foldsAway` ripiega le righe in «N note di servizio»
-- nel drawer, apribili con un click, e le toglie dalla finestra della card.
--
-- IL CONFINE E' «CAMBIA COSA FAI», NON «CHI L'HA SCRITTA». Restano parola, e non
-- sono toccate qui: «Land != consegna» e «Land NON confermato» (cio' che e'
-- atterrato non e' cio' che hai approvato), «la card NON si chiude: restano N
-- sottotask», «Landato ma NON ancora attivo» e «tocca desktop-tauri/» (chiedono
-- un gesto), i checks ROSSI e NON MISURATI, «Build client fallita», e ogni
-- avviso su sessioni esterne, budget finito o errore del provider.
--
-- I predicati sono ancorati all'inizio del testo (`LIKE 'x%'`, non `'%x%'`)
-- perche' un commento umano che CITA una di queste frasi non deve sparire.
UPDATE task_comments SET kind = 'service'
 WHERE author = 'system'
   AND COALESCE(kind, 'comment') = 'comment'
   AND (
        content LIKE 'Non è su main: %'                    -- landing audit, ha gia' il chip
     OR content LIKE '⚠️ Worktree %tenuto%'                -- GC, riscritta ogni 30 minuti
     OR content LIKE '⚠️ Worktree NON ripulito:%'
     OR content LIKE '🧹 Cartella del worktree liberata%'
     OR content LIKE 'Worktree e branch del task ripuliti.%'
     OR content LIKE 'Land accodato:%'                     -- ricevuta interna della coda
     OR content LIKE 'Riallineato prima del land:%'
     OR content LIKE 'Mergiato su main (commit %'
     OR content LIKE 'Il landing tocca il server:%'        -- va live da solo, nessun gesto
     OR content LIKE 'Client ricostruito:%'
     OR content LIKE '**Checks pre-review verdi**%'        -- e' il chip card-checks-green
   );
