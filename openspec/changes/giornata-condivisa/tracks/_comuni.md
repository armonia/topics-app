# Regole comuni alle tracce

- **Un ramo per traccia**, `prog/<id>`. Lo stato non sta in una casella: lo
  dicono il ramo sul remoto, il report in `reports/<id>.md` e la barra eseguita.
- **La base e' `origin/main`**, mai `main` locale. Dopo T0 e' l'unica base
  possibile; prima di T0 si passa `origin/main` a mano.
- **Chi scrive non verifica.** La revisione la fa un agente che non ha scritto
  quel ramo.
- **La prova e' un comando uscito zero o una misura letta.** Per il
  comportamento, un video. Finire tentativi o tempo e' il motivo per cui ti sei
  fermato, non la prova che funziona.
- **Niente HERO.** Prima di aggiungere un controllo: quale fallimento specifico
  rileva, e cosa cambierebbe se accadesse. Senza risposta, non si aggiunge.
- **Cio' che e' verde resta verde.** Le barre di `daily-driver` e i 45 `check:*`
  non regrediscono.
- **Codice in inglese, commenti in italiano.** I cancelli del repo lo verificano.
- **Meno codice, misurato.** Ogni traccia riporta le **righe nette di
  produzione** che aggiunge o toglie (`*.ts`, `*.tsx`, `*.rs`, esclusi i test).
  Una traccia che aggiunge righe nette deve dire **cosa cancella in cambio**, o
  perche' non puo'. Base del 22/10: **520.184 righe** di produzione (server
  198.166, client 233.331, shared 21.930, scripts 43.323, rust 20.900, relay
  2.187, cli 347). `check:bloat` ha gia' il ratchet sui file oltre 800 righe e
  sui cloni: il conteggio netto gli si aggiunge, non lo sostituisce.
- **La qualita' non si scambia con la brevita'.** Un test cancellato non e'
  codice risparmiato. Una riga in meno che costa una guardia in meno e' un
  guadagno falso. Si cancella cio' che e' **duplicato, morto, o sostituito da
  una cosa piu' semplice che fa lo stesso**, e la barra lo prova.
