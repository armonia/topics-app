# Discord Rich Presence — la pubblica Topics, con i conteggi veri del server

Topics scrive da sé la tua Rich Presence su Discord: apre il socket IPC locale
del client Discord (`discord-ipc-0…9`), fa l'handshake e manda `SET_ACTIVITY`.
Nessuna dipendenza npm, nessun processo in più, nessuna chiamata di rete.

**Parte spenta.** Pubblicare cosa stai facendo non è una cosa che si accende per
conto di qualcuno: la colonna nasce `NULL` (migration
`server/db/migrations/20260812093221-discord-presence.sql`) e finché non la
accendi tu il servizio non apre nessun filo.

## Dov'è l'interruttore

**Impostazioni → Profile → Discord.** Tre cose in una card:

- **on/off** — l'interruttore vero. Spegnerlo pulisce la presence, non la
  congela sull'ultimo stato.
- **livello di dettaglio**, che è un controllo di *privacy* e non un gusto: la
  presence la vede chiunque condivida un server con te.
  - `minimal` — che Topics è aperto. Nessun numero, nessun nome.
  - `activity` (default a interruttore acceso) — i conteggi: quante sessioni
    hai aperte, quante stanno lavorando adesso.
  - `detailed` — anche il **nome del progetto**. È l'unico gradino da cui può
    uscire una parola che non hai scelto per quel pubblico, quindi non è il
    default e non lo diventa.
- **stato del filo** in chiaro (`off`, `connecting`, `connected`, `no_discord`,
  `error`) più, a filo aperto, l'account Discord su cui stai pubblicando —
  l'unica conferma che serve se sulla macchina ci sono due account.
- **anteprima** di ciò che vedono gli altri, per tutti e tre i livelli. Esce
  dalla stessa funzione che pubblica (`buildActivity`), non da un'imitazione
  lato client: ciò che vedi prima di accendere è ciò che finirà sul profilo.

Non serve riavviare: il servizio rilegge le impostazioni a ogni giro.

**Uno scrittore alla volta.** Discord tiene una presence sola per applicazione.
Se sulla stessa macchina un altro programma pubblica la presence, l'ultimo che
scrive vince e la card sfarfalla fra due verità. Prima di accendere
l'interruttore di Topics, ferma l'altro.

## Da dove vengono i numeri

Conteggi esatti del server, non stime:

| Sulla card | Cos'è davvero |
|---|---|
| sessioni aperte | i topic non archiviati di questa installazione |
| al lavoro adesso | turni in streaming + agenti della board con un task in mano |
| task in corso | i task che la board sta eseguendo |
| il cronometro | da quando è in piedi il **server** |

## Il banner per il README del profilo GitHub

`GET /api/profile/banner.svg` — le stesse statistiche in un'immagine.
Parametri: `?theme=dark|light`, `&name=`, `&subtitle=`.

L'SVG è autoconsistente per costruzione: niente `<image href>` esterni, niente
`@font-face`, solo famiglie di sistema. Il README di GitHub serve le immagini
dal proxy Camo, che riscrive l'URL e scarica il file una volta sola: tutto ciò
che non è dentro il file, là fuori non esiste.

**Il server è locale, quindi GitHub non può chiamarlo.** Il banner non si linka:
si **rigenera e si committa** nel repo del profilo.

```sh
curl -s 'http://localhost:3333/api/profile/banner.svg?theme=dark' > topics-stats.svg
```

```markdown
![Topics](./topics-stats.svg)
```

Toccare il repo del profilo GitHub è un passo a mano, fuori dallo scopo di
questo codice.
