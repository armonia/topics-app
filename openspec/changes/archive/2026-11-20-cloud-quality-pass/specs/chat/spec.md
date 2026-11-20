## ADDED Requirements

### Requirement: CHAT-MEDIA-BOX-01 — Un'immagine di un messaggio occupa il suo spazio prima di caricarsi

Un'immagine disegnata in chat (`MediaImage`: il marcatore `MEDIA:`, un
`[Attached file: …]`, l'array `media`, un'immagine markdown su un percorso locale)
SHALL occupare il suo riquadro finale prima che i suoi byte arrivino, così che il
caricamento non sposti niente sotto gli occhi di chi legge.

Il server SHALL mandare con ogni messaggio che esce verso i client (pagina di
`/api/history`, frame `message:new` e `message:media`) un campo
`mediaSizes: { <percorso>: [larghezza, altezza] }` per le immagini PNG, JPEG, GIF e
WebP di cui legge l'intestazione, con larghezza e altezza scambiate per un JPEG
ruotato dall'EXIF. Le dimensioni NON SHALL essere salvate nel database: si leggono
all'uscita, dal file, con una cache per percorso e `mtime`.

Il client SHALL dare all'immagine, fino al suo caricamento, lo stesso riquadro che
il browser le darà a caricamento avvenuto (`max-w-full max-h-80`, proporzioni
mantenute, mai ingrandita), e dopo il caricamento SHALL lasciarla dimensionarsi da
sé come prima.

Senza `mediaSizes` (server che non le manda, file illeggibile, SVG, immagine
remota) il comportamento SHALL restare quello di prima: l'immagine cresce quando
arriva. Un client che non conosce il campo lo ignora.

Finché i byte non arrivano, il riquadro SHALL leggersi come il posto di
un'immagine e non come un buco: una tinta neutra del tema, in chiaro e in scuro,
senza animazioni. Il sipario della lista (TOPIC-FIRST-01) NON SHALL aspettare
un'immagine in vista che ha già il suo riquadro, perché il suo arrivo non sposta
niente; un'immagine senza riquadro resta aspettata come prima.

La bolla di chi invia un'immagine allegata (file scelto, incollato, o primo
messaggio di una bozza) è disegnata prima che il server abbia la riga: il client
SHALL metterci le dimensioni lette dal file nel composer, sotto lo stesso percorso
con cui `MediaImage` le cerca. L'invio NON SHALL aspettare quella lettura più di
mezzo secondo.

#### Scenario: una risposta con immagine arrivata mentre la persona era via
- **GIVEN** una chat letta, con la copia locale scritta, e una risposta con
  un'immagine arrivata sul server dopo
- **WHEN** la persona ricarica con la prima pagina trattenuta e l'immagine lenta
- **THEN** la risposta compare in fondo con il riquadro dell'immagine già alto
  quanto l'immagine, e il CLS del ritorno è ≤ 0,01 (prima 0,034)

#### Scenario: un'immagine che arriva dal vivo
- **GIVEN** una chat aperta, ferma in fondo
- **WHEN** arriva dal server un messaggio con un'immagine (`message:new`), oppure le
  immagini di fine turno (`message:media`), e i byte dell'immagine tardano
- **THEN** il riquadro dell'immagine è già alto quanto l'immagine, e il CLS è ≤ 0,01

#### Scenario: una topic visitata con un'immagine in vista si scopre senza aspettarne i byte
- **GIVEN** una topic letta, con la copia locale scritta, la cui ultima risposta
  ha un'immagine di dimensioni note
- **WHEN** la persona torna sulla topic dal suo tab e i byte dell'immagine tardano
  1,5 s
- **THEN** il sipario si alza prima che i byte arrivino, in un numero di frame
  lontano dal tetto duro del sipario (prima: al tetto, 74-75 frame, ~1270 ms),
  l'immagine è già alta quanto sarà, e il CLS è ≤ 0,01

#### Scenario: la bolla di chi allega un'immagine
- **GIVEN** una chat aperta, ferma in fondo
- **WHEN** la persona allega un PNG e invia, e i byte dell'immagine tardano
- **THEN** la bolla compare con il riquadro dell'immagine già alto quanto
  l'immagine, e il CLS è ≤ 0,01 (prima 0,0488)

#### Scenario: senza dimensioni, come prima
- **GIVEN** un messaggio con un'immagine il cui file il server non sa leggere
- **THEN** il messaggio non porta `mediaSizes` e l'immagine si disegna come prima
