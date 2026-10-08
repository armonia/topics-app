# Prove di T12

REPORT: `../../reports/T12.md`. Worktree nella VM: `/home/user/t12-head` (testa `d47732e`), `/home/user/t12-main` (`main` 3964518),
`/home/user/t12-headS` e `/home/user/t12-mainS` (S, con `evidence/V3/accordion-debug.patch`; il lato main con `tests/e2e/` della testa).

- `bar.sh <worktree> <label> [main-worktree]`: la barra di T12, un passo alla volta; `logs/bar-prima`, `logs/bar-dopo` (`summary`,
  liste dei rossi `fails-*.txt`, `comm-*.txt`), `logs/bar-dopo-v1` (la prima barra «dopo», interrotta sui tre cancelli rossi).
- `s-run.sh <N> <blocco>`: S, carico L1, blocchi alternati testa/main; `logs/s-runs` (riassunto e righe della sonda per blocco).
- `mut.sh <commit>`: le mutazioni B3 in un worktree scratch; `logs/mut*.log`.
- `smoke-keep.sh`: lo smoke del sidecar con il log del binario tenuto e il conteggio di `schema_migrations`.
- `logs/boot.txt`: avvio del server di test (`evidence/V3/boot-time.sh`), coppie testa/fix e A/A.
- `logs/bar-prima/hung-shard0-files.txt`: i 461 file dello shard appeso su Bun 1.3.8 (testa).
