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
