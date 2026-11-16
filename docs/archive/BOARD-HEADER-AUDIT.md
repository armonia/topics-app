# Audit header board Topics (sola lettura, misure DOM via iframe a 375/768/1440/3440; colonna Review esclusa)

Struttura: riga 1 (y40, h36) = ricerca + Tutte/Progetto + chip progetto (scroll orizzontale interno) + slider dettaglio + 2 icone + Orchestratore + Consegna 497 + impostazioni. Riga 2 (y76, h32) = filtri rapidi: Serve te 23, Jarvis 0, Agenti 161, Programmate 31.

## Misure
| px | barra riga 1 | scroll orizz. | filtri rapidi | note |
|---|---|---|---|---|
| 375 | 375 | SI: contenuto 878 (cola 503px fuori vista) | SI: finiscono a 401 > 375 | Orchestratore/Consegna/Impostazioni a x 608-870: raggiungibili solo scorrendo, nessun indizio |
| 768 | 508 (sidebar 260 aperta) | SI: 823 vs 508 | no | Consegna a x922 fuori barra; i chip progetto spingono gli strumenti oltre il bordo |
| 1440 | 1180 | no | no | visibili solo 3 chip su 16 (armonia-site e due chip omonimi); gli altri scorrono dentro |
| 3440 | 3180 | no | no | 16 chip tutti visibili ma vuoto di ~700px (x2345-3037) fra chip e strumenti; strumenti a 3000+ px dalla ricerca |

Tutti i controlli sono alti 24px (h-24 con puntatore fine; coarse:h-11 solo su touch). Slider "Livello di dettaglio" largo 64px.

## Problemi reali (da confermare)
1. 375/768: gli strumenti a destra (Orchestratore, Consegna, impostazioni auto-dispatch) escono dalla barra, senza sfumatura né freccia. Proposta: strumenti fissi a destra (sticky) e solo i chip scorrevoli; o menu "..." sotto 768.
2. 375: i filtri rapidi (Programmate) tagliati a 401px. Proposta: ridurre padding o scorrimento con fade.
3. 1440: 3 chip visibili su 16 senza indicatore di scorrimento. Proposta: chip "+13" o fade a destra.
4. 3440: strumenti lontanissimi dai filtri; proposta max-width del contenuto o strumenti accanto ai chip.
5. Etichette: icone senza testo (2 icone 24x24 accanto allo slider) con aria-label ma senza testo visibile; tooltip da verificare.
6. Doppio nome omonimo ripetuto due volte nei chip (progetti omonimi con path diverso): ambiguità.

## Giudizi visivi per il reviewer (dopo verifica di Jarvis)
- Gerarchia: Consegna 497 e conteggi chip hanno peso uguale; il 497 domina senza essere azionabile?
- Due righe (strumenti + filtri rapidi) vs una sola.
- Altezza 24px dei chip: ok per desktop, stretti a 375 se il puntatore non è marcato touch.

Limiti: screenshot reale solo a 1280 (viewport del pannello); gli altri 4 widths sono misure DOM in iframe e un composito scalato. Non annotati a mano.
