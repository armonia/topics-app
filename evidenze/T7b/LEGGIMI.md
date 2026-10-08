# Evidenze T7b (Chromium, `E2E_EVIDENCE=1 E2E_VIDEO=1`)

Video e trace delle due scene nuove, una corsa per lato, stessa VM, 08/10/2026 ~03:49 UTC
(load 1,1-1,3). Prima = `cloud/t7b-base` `8246707` con le spec del ramo copiate; dopo =
`cloud/t7b-topic-sipario`.

| Cartella | Scena | Numeri della corsa |
|---|---|---|
| `prima/sipario` | `topic-visited-first-frame` «una topic visitata con un'immagine in vista…» | sipario alzato a 1260 ms / 75 frame dal clic, cioè al tetto duro; l'immagine ha già il riquadro (320 px), CLS 0 |
| `dopo/sipario` | idem | sipario alzato a 283 ms / 16 frame, 1392 ms prima che i byte arrivino; riquadro 320 px, CLS 0 |
| `prima/bolla` | `chat-image-box` «la bolla di chi allega…» | immagine alta 0 px prima dei byte, poi cresce: CLS 0,0488 |
| `dopo/bolla` | idem | riquadro di 320 px da subito, l'immagine si riempie dentro: CLS 0 |

Visto sui fotogrammi estratti con ffmpeg (4 al secondo): in «prima/sipario» dopo il clic sul tab
restano ~6 fotogrammi di scheletro (~1,5 s) e la topic compare con l'immagine già piena (i byte
sono arrivati intanto); in «dopo/sipario» lo scheletro dura un fotogramma, poi la topic con il
riquadro grigio in fondo per ~1,2 s, che si riempie quando arrivano i byte, senza che niente si
muova. In «prima/bolla» la bolla entra con il solo testo e l'immagine compare dopo, spingendo il
testo; in «dopo/bolla» la bolla entra già con il riquadro grigio alto quanto l'immagine.

`riquadro/`: il riquadro in attesa dei byte (byte trattenuti 8 s), in chiaro e in scuro, dalla spec
scratch `placeholder.spec.ts.txt` (mai committata come test). Chiaro `rgb(245,245,246)` su pagina
`rgb(236,237,238)`; scuro `rgb(34,35,37)` su `rgb(8,10,14)`; 576×320 in tutti e due.
