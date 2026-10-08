# Evidenze di T14

- `e2e-prima/` (codice a `d99bc03`) e `e2e-dopo/` (codice a `0fbd5d4`): video `.webm` e `trace.zip`
  di `board-land-conflict`, `board-landing-honesty`, `board-card-landing-receipt`,
  `chat-changed-files-task-range`, chromium, `E2E_TIER=pr E2E_EVIDENCE=1 E2E_VIDEO=1`. 13/13 in
  entrambe. Mostrano il land dalla card (banda «in coda», ricevuta, conflitto, stato di
  atterraggio) e i file della gamma propria del task: stessi esiti prima e dopo, il refactor non
  si vede.
- `logs/`: barra prima e dopo (`*.summary` = solo righe di esito della suite unit), le due
  riproduzioni degli shard rossi alla base senza i test di T14 (`shard-base`, `shard2-base`, con
  la lista dei file in `shard*-cmd.txt`), i log E2E.
- `scripts/`: gli script usati, lanciati così come sono.
