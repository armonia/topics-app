# Tracce: prezzo memoria delle card senza check

- [ ] Usare `review_checks` della board per distinguere card senza check e
  mantenere il prezzo attuale per le card con check.
  - Barra: la card senza check usa 4 GB; la card con check conserva il prezzo
    mediano corrente.
- [ ] Provare ammissione e trattenimento con swap pieno e 4,8 GB liberi.
  - Barra: il test mirato passa; mutazione al prezzo vecchio fallisce.
- [ ] Aggiornare KANBAN-75 lasciando invariati il tetto per risorse e le soglie
  generali.
  - Barra: il contratto descrive entrambe le board e il caso off-lane.
