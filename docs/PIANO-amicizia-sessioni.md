# Piano — vedere le sessioni di un altro utente («amicizia») + incognito

> Task `d6baaf5e`. **Revisione 2 — 10/08/2026.** La prima stesura è del 04/08 e oggi è
> in gran parte superata: tre delle sue sei fasi sono state costruite nel frattempo.
> Questa revisione riparte da ciò che c'è **nel codice di oggi**, non da come stavano
> le cose ad agosto. `git log docs/PIANO-amicizia-sessioni.md` per la versione vecchia.

---

## 0. Cosa è cambiato dal 04/08 (misurato)

Il piano vecchio partiva da due fatti: «Topics non ha nessuna autenticazione» e
«l'accesso remoto è un tunnel che espone il server intero». **Nessuno dei due è più
vero.** Da allora sono atterrate quattro change:

| change | cosa ha portato | dove si vede |
|---|---|---|
| `device-auth` | identità del **dispositivo**: `devices`, cookie, approvazione, revoca | `080-devices.sql`, `server/lib/device-auth.ts` |
| `task-sharing-guests` | il **gate ospite**: allowlist di percorsi, verbi, e frame WS | `server/lib/grants.ts`, `083-grants.sql` |
| `sharing-orgs` | il soggetto diventa la **persona/organizzazione**, non il ferro | `084-people-orgs.sql`, `server/lib/principals.ts` |
| `relay` | la macchina **chiama fuori**: Worker + Durable Object, payload ciechi | `relay/src/*`, `server/services/relay-client.ts` |

Più: `share_links` (085), `tool_grants` (086), l'account via codice email
(`server/lib/account.ts`, con `remote_id` come chiave fra due installazioni),
e il tunnel Tailscale **rimosso** — `TOPICS_TUNNEL_PORT` oggi è la porta interna che
il relay ricontatta, non un'esposizione.

Tradotto sulle fasi del piano vecchio: **F1 fatta, F2 metà, F3 metà (il relay c'è,
l'amicizia no), F4 fatta ma solo dentro casa** (condividi con chi è sulla tua rete o
ha un dispositivo appaiato). Restano scoperti: l'amicizia fra **installazioni
diverse**, la scrittura, la presenza per persona, l'incognito.

---

## 1. I cinque punti del task, contro il codice di oggi

**1) Richiesta/accettazione di amicizia — NON esiste, ed è l'unico pezzo che richiede
un servizio nuovo.** Lo schema è già predisposto (`people.origin IN ('local','cloud')`,
`remote_id`, `principals_rev` in `084`), ma il sincronizzatore non è mai stato scritto e
`server/lib/account.ts:66` lo dice esplicitamente: `origin` resta `'local'` perché
«nessun servizio ha mai scritto quella riga». Oggi due installazioni non hanno **nessun**
modo di sapere l'una dell'altra. L'amicizia è **anagrafe**, quindi vive nel piano di
controllo — e `limiti-accettati.md` di `sharing-orgs` ha già deciso il confine: il cloud
trasporta solo `people`/`orgs`/`org_members`, **mai** i grants, che restano locali per
sempre. Si condivide solo dalla macchina che ha la roba.

**2) Scrittura per-sessione — il gate oggi nega tutto, ed è il verso giusto.**
`isGuestAllowedMethod` (`grants.ts:102`) rifiuta ogni verbo mutante tranne il logout, e
`grants.level` ammette solo `'read'|'deny'` (084). Manca il livello, ma il livello è la
parte facile: il pezzo vero è che `/ws/terminal/:id` e `/ws/browser/:id` **non sono
nell'allowlist**, e la nota `6.7` della change `relay` spiega perché non basta
aggiungerli — spazi e tab vivono in un blob JSON da ~56 KB in una riga di `ui_state`, e
vanno promossi a righe **prima**. È lavoro di fondamenta, non una voce in un enum.

**3) Presenza cross-device — c'è il mattone, manca il muro.** `server/presence.ts`
elenca le **finestre** di questa installazione; `auth.ts:473` sa se un dispositivo è
`connected`, ma solo dentro Impostazioni. Non esiste una presenza per **persona**
(l'aggregato dei suoi dispositivi), e i frame `presence:*` non sono in
`GUEST_SAFE_FRAMES` — quindi anche esistendo, a un amico non arriverebbero.

**4) Incognito per progetto — non esiste.** `projects` (016) non ha la colonna, e non
c'è stato bisogno finora: senza un grant esplicito nulla è visibile. Serve **adesso**,
prima dell'amicizia, per una ragione precisa — quando condividere diventa un gesto
frequente, l'unica difesa che regge è quella che rende la condivisione **impossibile**,
non quella che la nasconde.

**5) Hosting — già deciso, per il relay.** `openspec/changes/relay/proposal.md`:
Cloudflare Workers + Durable Objects, non un VPS, «e la scelta è reversibile a costo
quasi nullo». Hetzner non è più il candidato: il carico di un relay è fatto di
connessioni ferme, che con l'ibernazione non costano e su un VPS sono RAM occupata h24.
**Resta aperto solo per il piano di controllo** (§3).

---

## 2. Le fasi residue, in ordine

Il criterio dell'ordine non è cambiato: **nessuna fase esiste solo per abilitare la
successiva.** Ognuna ha la sua barra.

**F0 — Chiudere il debito che sta sotto.** Non si costruisce l'amicizia sopra un relay
con i buchi aperti già censiti: `share_links.key` è la chiave AES-256 **in chiaro a
riposo** (6.1), l'ingresso ospite del Durable Object non autentica nessuno (6.2),
`/agent/:installationId` è dirottabile (6.3), e `relay-do.ts` **non lo esegue nessun
test** (6.4). Più i quattro punti aperti di `sharing-orgs` (5.2–5.4, 8.1).
*Barra:* i test di `relay/` eseguono il DO davvero; nessuna chiave in chiaro nel DB.

**F1 — Incognito per progetto.** `projects.incognito`, la spunta in fase di add-tab, e
l'esclusione **alla sorgente**: non un filtro in vista ma un rifiuto in
`grants-query.ts` (un grant su una risorsa di un progetto incognito non si può creare) e
nel gate WS. Vale da sola, ed è la rete di sicurezza di tutto il resto.
*Barra:* un test prova che condividere un topic di un progetto incognito **fallisce**, e
che nessun frame di quel progetto esce verso un socket ospite.

**F2 — Presenza per persona.** Aggregare i dispositivi in uno stato di persona, un frame
dedicato nell'allowlist, e la resa in interfaccia. Dentro l'installazione vale già da
sola (sapere da quale macchina stai lavorando); attraverso il relay diventa il punto 3
del task. *Barra:* due dispositivi della stessa persona, uno spento → la persona resta
online.

**F3 — Il piano di controllo e l'amicizia.** Il servizio (§3), il registro delle
persone, richiesta/accettazione, e il sincronizzatore dell'anagrafe con `remote_id` come
chiave. **Essere amici non mostra niente**: è deliberato, ed è il punto 2 del task.
*Barra:* due installazioni, due DB diversi, dopo l'accettazione la stessa persona ha lo
stesso `remote_id` da entrambe le parti.

**F4 — Sessione condivisa a un amico remoto, in sola lettura.** Qui non c'è quasi niente
di nuovo: è il `grant` su `topic` che già esiste, con il destinatario che ora è
raggiungibile. *Barra:* l'amico vede lo streaming di UNA chat e riceve `403` su tutto il
resto.

**F5 — Promozione a «può scrivere», per sessione.** Livello `'write'` nel CHECK, gate
sul **verbo** e sui socket di terminale, firma di chi ha scritto nel messaggio, revoca
istantanea. Gesto esplicito dell'owner, **mai implicito nell'amicizia**. Dipende dalle
fondamenta di 6.7. *Barra:* un ospite `read` che tenta un input su un pty prende `403`
anche col socket già aperto; promosso, l'input arriva e **compare firmato**.

---

## 3. L'unico bivio ancora aperto: dove vive il piano di controllo

Serve un servizio che tenga account, indirizzi, richieste di amicizia e anagrafe
sincronizzata. Due strade:

- **Cloudflare Workers + D1** — stesso account, stesso dominio e stessa pipeline di
  deploy del relay e del landing; nessuna amministrazione di sistema su un pezzo
  critico. **È la raccomandazione**: il piano di controllo scrive poco e legge poco, e
  non ha bisogno di un Postgres.
- **Hetzner + Postgres** — se la fatturazione e i rapporti fra persone/organizzazioni
  cresceranno oltre quello che D1 regge comodamente. Costo: una macchina da tenere
  aggiornata, che custodisce i dati di persone diverse.

In entrambi i casi vale il vincolo già scritto: **il piano di controllo non vede mai i
task e i topic**, per costruzione e non per policy.

---

## 4. Ciò che si rompe, e va detto in interfaccia

- **Chi chiude una sessione condivisa, e per chi.** La chiusura dell'ospite chiude **la
  sua vista**, mai lo stato dell'owner.
- **Un terminale condiviso in scrittura è una shell sulla macchina dell'owner.** Va
  scritto con queste parole, non con «può scrivere».
- **La revoca ferma il futuro, non il passato.** Ciò che l'ospite ha già visto l'ha
  visto: «rimuovi amico» non può promettere altro.
- **L'incognito non è retroattivo.** Marcare incognito un progetto già condiviso deve
  **revocare** i grant esistenti, non solo impedirne di nuovi — altrimenti la spunta
  mente.

---

## 5. Quanto è grande

F1 e F2 sono lavoro locale e contenuto. F0 è debito già censito, quindi noto. **F3 è la
soglia**: introduce un secondo sistema in rete, con account e dati di persone diverse —
non è un'estensione di Topics, è un prodotto affiancato. F5 è la più costosa in
proporzione a quanto sembra, perché prima chiede le fondamenta di `ui_state`.
