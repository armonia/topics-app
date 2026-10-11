# Acceptance — native-token-economy

1. `bun test server/providers/native/compaction-cadence.test.ts` esce 0. Simulazione deterministica:
   storia che cresce di 8k token stimati a giro per 120 giri su finestra 200k, ogni compattazione
   conta come riscrittura dell'intero prefisso, ogni giro normale come scrittura del solo nuovo.
   Con le costanti nuove le compattazioni sono almeno la metà di prima e i token scritti in cache
   almeno il 40% in meno; rosso con le costanti vecchie (mutazione su copia).
2. Con stima non calibrata la soglia resta 0,75 (test).
3. Riga di log per giro con chat e i quattro conteggi; la riga di compattazione porta la chat (test
   sul formato, come gli altri log del nativo).
4. `bun scripts/token-audit.ts --since 2026-10-11` gira in sola lettura sul DB vero
   (`mode=ro`) ed esce 0 con la tabella per chat.
5. `bun test server/providers/native` verde; `typecheck:server`, `check:bloat`,
   `check:identifier-language` a 0.
