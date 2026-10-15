## Requirements

### Requirement: D3H-01 — misurare la freschezza dello stato Git

Il banco avvia il server isolato, apre il repository fixture come progetto, si collega al WebSocket
e misura il tempo dal salvataggio al primo `git:status` dello stesso progetto che contiene il file.
Confronta il percorso nativo acceso e spento, stampa mediana, p95 e massimo, e restituisce un codice
non-zero quando il p95 nativo supera 150 ms. Il workflow manuale su Ubuntu esegue la misura con
otto processi che saturano la CPU.
