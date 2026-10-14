# D1 · Server senza sprechi: si legge dalla memoria, si manda solo a chi guarda

Regole comuni: `tracks/_comuni.md`. Dipende da D0, perché le barre sono i suoi comandi.

**GOAL.** Le letture che la UI fa di continuo rispondono dalla memoria. Un client che non guarda
niente non riceve quasi niente.

## Da dove si parte (misure del 14/10, `baseline.md`)

**`git/status`: 6.008 chiamate al giorno, p95 di 385 ms, massimo 12,6 s.**
- La cache dura 5 s (`server/lib/git-status-cache.ts:31`).
- Ogni poll dopo quei 5 s è un miss da cinque spawn di `git` (`server/lib/git-status.ts`).
- Succede anche se il watcher ricalcola e spinge lo stato a ogni cambio (`refreshGitStatus` in
  `server/git-watcher.ts`).

**`files`: p95 di 349 ms, massimo 40 s.** `walkFileTree` (`server/lib/file-tree.ts`) rifà la visita
dell'albero a ogni richiesta.

**Socket: 6,9 KB/s di payload per un client fermo.**
- `external-sessions` manda il censimento intero, circa 37 KB, a ogni cambio di stato di una
  sessione (`server/services/external-sessions.ts:155`).
- Con 22 sessioni vive cambia quasi a ogni giro.
- Nel server ci sono 332 chiamate a `broadcastToAll` contro 21 a `broadcastToTopicSubscribers`:
  quasi tutto va a tutti, anche lo streaming delle chat che il client non ha aperto.

## Cosa cambia

1. **Stato git.**
   - Per un percorso con un watcher vivo, la cache vale finché il watcher non la invalida. Il tetto
     di sicurezza è 60 s, per l'evento che FSEvents perde.
   - Senza watcher resta il TTL di 5 s.
2. **Albero dei file.** Stessa regola, con la cache invalidata dal watcher dei file che c'è già
   (`server/file-watcher.ts`).
3. **Frame per abbonamento.**
   - Ogni tipo di frame è classificato: globale, per topic, per progetto o per board.
   - I frame per topic vanno solo a chi ha quel topic aperto.
   - Un test elenca i tipi e fallisce quando ne nasce uno senza classe.
4. **`external-sessions` come differenza.**
   - Si mandano solo le aggiunte, le sessioni tolte e i cambi di stato.
   - Il censimento intero va solo all'iscrizione.

## Barra

```bash
bun run check:route-latency                 # git_status p95 ≤ 20 ms; files, scripts, system_status ≤ 50 ms
bun run measure:ws-idle -- --budget 1024    # esce 0 (in D0 esce 1)
```

- **Contatore di spawn.** Un test d'integrazione conta le chiamate a `spawnBounded`: con un progetto
  aperto e nessun cambio per 10 minuti simulati, 0 spawn di `git status`.
- **Mutazione.** In una copia si rimette il TTL di 5 s: il test del contatore deve fallire.
- **Produzione.** 24 ore dopo il porto, lo script della baseline sul log dà `git/status` con p95
  ≤ 20 ms.
- **Spec-flow con video.** Si salva un file da fuori dall'app e il pannello git lo mostra entro
  1 s, senza poll.

## Fuori

- Rust: è D3.
- Cambi al protocollo del client oltre all'iscrizione ai topic.
- Il frame `ui-state:init` (90 KB una volta per connessione, compresso a circa 21 KB): costa a ogni
  riconnessione, non a riposo, e ha già la sua misura.
