# Prove di V3

Script e log della verifica integrata (REPORT: `../../reports/V3.md`). Le worktree erano `/home/user/v3-base`
(`main` 3964518), `/home/user/v3-head` (5d4e463) e `/home/user/v3-new` (7a27c71); gli script le cercano lì.

- `b1.sh`, `e2e.sh`, `chain.sh`, `newchain.sh`: la barra B1 (qa veloce, unit, build + bundle, e2e d'area a 2 shard, unit su Bun 1.3.8).
- `b2.sh` (+ `b2chain*.sh`, `routes2.sh`): i numeri B2, base e testa alternate. `bench-routes.ts` (T5) e `boot-time.sh` (T3) sono miei;
  per T9 `bench-branches.ts`/`bench-loop.sh` dal ramo `cloud/t9-server-loop-evidenza`.
- `b32-processes.sh`: lo scenario dei processi (B3.2). `rerun.sh`: un test rilanciato da solo, alternato fra i lati.
- `v3-chat-pin-intersections.spec.ts.txt` (B3.1) e `v3-board-shape.test.ts.txt` (B3.3): togliere `.txt` e metterli in
  `tests/e2e/` e `client/src/hooks/` per rilanciarli (estensione cambiata perché qui non li prenda la suite).
- `accordion-debug.patch`: la sonda per il flaky `chat-accordion-no-shift` «tool-result-clamp» (stampa i frame quando la chat non si ferma).
- `logs/`: riepiloghi di tutte le corse citate nel REPORT.
