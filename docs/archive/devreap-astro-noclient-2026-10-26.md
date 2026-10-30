# devreap: REAP-NOCLIENT per server astro/vite senza browser

**Data:** 2026-10-26  
**Commit jarvis:** 9906b60  
**Card:** 50bf1f38

## Problema

I dev server Astro/Vite del progetto `armonia-agency` accumulavano
fino a **5,09 GB** di footprint (misurato con `memhog`) senza che
nessun browser fosse connesso. Il Mac toccava l'84% di swap.

`devreap` non li raccoglieva per tre motivi:
1. `astro` non era in `DEV_PATTERNS` (solo `vite` e `next`)
2. La soglia emergenza richiede 6 GB per singolo processo;
   ogni server astro vale ~600 MB
3. `inbound` del survey combinato era gonfiato dalle connessioni
   interne astro->workerd (contate come client dal figlio)

## Fix (jarvis/scripts/devreap)

- `DEV_PATTERNS` += due pattern per `astro`
- Nuova regola `REAP-NOCLIENT`: uccide i dev server in
  `NOCLIENT_PATHS` (default `~/Projects/armonia-agency`) con
  zero connessioni browser da `NOCLIENT_AGE` secondi (default 2 h),
  senza gate di pressione
- `noclient_servers` usa `net_detail(root)` invece di
  `r["inbound"]` del survey per evitare il falso positivo
  workerd

## Misure

| | footprint |
|---|---|
| PRIMA (26/10) | 5 090 MB |
| DOPO (primo giro) | ~400 MB |

Il dato 26/10 dal task era 3,1 GB; misurato a task partito: 5,09 GB.

## Note operative

- Il fix gira ogni 5 min via launchd (`com.jarvis.devreap`)
- `DEVREAP_NOCLIENT_KILL=0` per disabilitare senza toccare il codice
- `DEVREAP_NOCLIENT_AGE=<s>` per cambiare la finestra (default 7200)
- Il `tsserver` con padrone vivo (jcode) non viene toccato
