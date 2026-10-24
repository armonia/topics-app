# browser-store-reaper-setting — la pulizia dei browser chiusi è un'impostazione di Topics

## Perché

#425 aggiusta il 404 di `/api/browsers/data-store-keep-list`. Da quel momento il reaper
(`client/src/lib/browserDataStoreReaper.ts`) gira per la prima volta e cancella gli store WKWebView
orfani fermi da 60 giorni: cookie, login, dati locali dei siti. Non si annulla. Attilio, approvando
#425: «Ok ma dovrebbe essere una impostazione però di topics».

## Cosa cambia

- `app_settings` prende due colonne nullable, `browser_store_reap_enabled` e
  `browser_store_reap_after_days` (migration `20261024120001-browser-store-reap.sql`). Nessun dato
  riscritto: la riga esistente guadagna due NULL, e NULL vuol dire «mai toccata».
- `shared/browser-store-reap.ts` dice cosa significano: NULL = acceso, 60 giorni; i giorni stanno in
  7..365, fuori si riportano al limite più vicino.
- `PUT /api/app-settings` salva l'interruttore (booleano) e i giorni già riportati nel range; un valore
  che non è un numero è un 400. `GET /api/app-settings` risponde 503 quando la riga non si legge: un 200
  con tutto NULL si leggerebbe «mai toccata», cioè acceso, anche con uno spento salvato.
- Il reaper legge l'impostazione a ogni avvio, prima di tutto. Spento: niente keep list, niente comando
  Tauri. Impostazione non arrivata: come una keep list non arrivata, niente cancellato. Acceso: passa a
  Tauri i giorni dell'impostazione, riportati di nuovo in 7..365.
- La UI: menu Topics → Sistema → Prestazioni, subito sotto «Libera le pagine non viste quando la memoria
  scarseggia». Interruttore «Pulisci i dati dei browser chiusi», spiegazione «Cancella per sempre cookie
  e dati dei browser che non apri più. Quelli aperti non si toccano.», riga «dopo N giorni senza uso».

## Barra

`specs/acceptance.md`: tre file di test verdi, rossi sul codice di prima o sui mutanti, sedici mutanti
rossi, i cancelli statici a 0, i tre typecheck a 0. Ciò che è verde resta verde.

## Fuori

- Il Rust: `MIN_REAP_AGE_DAYS` resta il pavimento di 7 giorni in `desktop-tauri/src-tauri/src/lib.rs`.
- Un «pulisci adesso» manuale, un elenco degli store, un conteggio di cosa è stato tolto.
- Il browser condiviso (Playwright), che tiene i suoi dati altrove.
- Un e2e: dovrebbe fingere Tauri, e `__TAURI_INTERNALS__` manda tutto al server di produzione.

## Deciso da

- **Attilio**: che la pulizia sia un'impostazione di Topics.
- **Coordinatore**: accanto alle altre impostazioni dei browser; i testi; acceso a 60 giorni per chi non
  l'ha mai toccata; 7..365 col riporto al limite, sul server e di nuovo nel reaper; spento = nessuna
  chiamata; impostazione non letta = niente cancellato; Rust invariato.
- **Io (agente)**:
  - il posto esatto è il livello Prestazioni: lì sta l'unica altra impostazione dei browser valida per
    tutta l'app (le pagine liberate quando la memoria scarseggia) e l'elenco dei siti tenuti vivi;
    nessun gruppo «Browser» esiste, e crearne uno per una riga sarebbe un secondo posto da cercare;
  - il timestamp `20261024120001` è il primo libero dopo il più alto su `origin/main`
    (`20261024120000`), e nessun ramo remoto lo usa;
  - i giorni si arrotondano all'intero; una stringa vuota o non numerica è un 400, non un 7;
  - le due righe non si disegnano finché l'impostazione non è letta: mostrare il default al suo posto
    direbbe una scelta che nessuno ha visto.

## Non ancora specificato

Niente.
