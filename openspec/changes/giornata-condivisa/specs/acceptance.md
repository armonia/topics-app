# Barra di giornata-condivisa

## 1. I comandi

Ognuno esce non-zero oggi. Alla fine della sua traccia esce zero, e resta zero.

| Traccia | Comando | Oggi | Alla fine |
|---|---|---|---|
| T0 | `git rev-list --left-right --count main...origin/main` | `6 646` | `0 0` |
| T0 | `bun scripts/board-doctor.ts` non riporta `land-drags-foreign-commits` | lo riporta per e9226ab7 | non lo riporta |

| T1 | le due sonde d'origine della nota privata | passano il gate | `403` |
| T1 | `bun run check:security` | n/d | esce 0 |
| T2 | `bun scripts/backup-restore-check.ts` | il file non esiste | esce 0: si decomprime, `integrity_check=ok`, 188 migration |
| T2 | `find data/backups -name 'topics-*.db.zst' -mtime -1 \| wc -l` | `0` | `>= 1` |
| T3 | `/usr/bin/grep -rn 'COALESCE(MAX(server_seq)' server/ \| wc -l` | `>= 2` | `0` |
| T3 | `bun scripts/measure-cross-device.ts` (nuovo) | il file non esiste | p95 sotto la soglia che fissa T3 alla prima misura |
| T4 | `bun test tests/sim/sync-convergence.test.ts` | il file non esiste | 200 seed x 3 client con partizioni: 0 divergenze, 0 resurrezioni |
| T4 | `/usr/bin/grep -rn 'storeSyncInternalRef\|setOpenPanels(\|setFocusedPanelId(' client/src --include=*.ts --include=*.tsx \| /usr/bin/grep -v '\.test\.' \| wc -l` | `96` | `0` |
| T5 | `bun run test:unit:shuffle` x20 (nuovo) | lo script non esiste | 0 rossi su 20 giri |
| T5 | 4 shard unit in-process | rossi, «mai gli stessi» | verdi 20/20, p50 <= 300 s |
| T6 | `cargo tree -p tauri \| head -1` | `2.11.3` | `>= 2.12.3` |
| T6 | passo `assert-sig` in `tauri-release.yml` | non esiste | esce non-zero se manca un `.sig` o se differisce da `latest.json` |
| T7 | `bun test server/routes/share-links.test.ts` sul livello del link | nessun livello sul link | `level` con lo stesso CHECK di `grants` |
| T7 | `bun test server/db/activity-log.test.ts` su `person_id`/`device_id` | colonne assenti | presenti con FK, scritte negli 8 punti di decisione |
| T8 | `bun scripts/runner-parity.ts` (nuovo) | il file non esiste | la stessa card gira su locale e su PC con lo stesso esito |
| T9 | `bun run check:ink` sul messaggio in streaming | il markdown si ri-parsa intero | O(1) per chunk: il blocco di coda e nulla piu' |
| T9 | `bun run check:inp-shell` (nuovo, Event Timing dal guscio) | il file non esiste | p95 dell'interazione sotto la soglia fissata al primo giro |
| T10 | tre tentativi sulla stessa card con i diff a confronto | un tentativo per card | tre, e la scelta diventa `deliveryCommit` |
| T11 | `bun scripts/delivery-score.ts` (nuovo) | il file non esiste | rifiuta una consegna con sha non pushato o rail rosso ereditato da main |
| T12 | `git worktree list \| wc -l` | `25` | solo quelle con un ramo vivo |
| T12 | `du -sh .claude/worktrees ~/.topics/backups ~/.topics/db-backups` | 1,6 GB + 4,6 GB + 614 MB | potate, con una politica scritta |
| T12 | `bun run check:gates-orfani` (nuovo) | 13 `check:*` non girano in nessun workflow | `0` orfani, o ognuno dichiarato tale con il motivo |

## 2. Gli scenari, con video

Il `.webm` del test e' la prova che lo scenario passa. Un resoconto a parole non lo e'.

1. **La giornata a tre.** Tre persone su tre dispositivi, un progetto, una board.
   Ognuna apre una card, ne commenta una altrui, ne avvia un agente. Nessuno
   tocca la macchina che ospita. Alla fine le tre viste mostrano lo stesso stato.
2. **Un invito dall'arrivo alla revoca.** Si invita per email, l'ospite apre,
   legge dentro il suo ruolo, scrive dove il ruolo lo permette, e alla revoca
   perde l'accesso entro un frame. Nel transcript che ha visto non compare
   nessun segreto.
3. **Il riavvio a meta' turno.** Il server riparte mentre tre agenti stanno
   scrivendo e sei dispositivi guardano. Nessun turno si perde, nessun terminale
   mostra uno schermo bianco, nessuna pane resta vuota.
4. **Una card corsa da tre agenti.** Tre tentativi sulla stessa card di gusto, i
   diff affiancati, la scelta che diventa la consegna e le altre due worktree
   che si chiudono senza residui.

## 3. Le mutazioni

Ognuna si introduce a mano e deve far fallire il test indicato. Se il test resta
verde, il test non vale e va riscritto prima di andare avanti.

| Mutazione | Test che deve diventare rosso |
|---|---|
| Riallargare il confronto d'origine (vedi nota privata) | `auth-gate.test.ts`, caso della granularita' |
| Allocare `server_seq` con `SELECT MAX` in un solo punto | `tests/sim/sync-convergence.test.ts` |
| Scartare un frame su dieci nel banco di convergenza | lo stesso test, invariante di convergenza |
| Far scadere un link senza revocare il grant che ne nasce | scenario 2 |
| Far tornare uno `deliveryCommit` non pushato | `scripts/delivery-score.ts` |
| Lanciare un `throw` in un handler di channel del guscio | il test del channel di T6 |
