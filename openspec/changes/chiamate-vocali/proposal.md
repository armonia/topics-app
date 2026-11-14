# Chiamate vocali in Topics: la voce è di Topics, il canale porta solo l'audio

## Da decidere
Niente: la forma l'ha decisa Attilio il 14/11 («sposta tutto in Topics»; «assicurati che possa io chiamare Jarvis, poi chiamami e segui se si rompe qualcosa finché non è perfetta»). Le scelte tecniche sotto le ha prese l'agente.

## Perché
Le telefonate WhatsApp di Jarvis oggi girano tutte in jarvis-channels (Rust, `src/voice/`, ~3700 righe): voce Gemini Live, cervello, «bocca» veloce, passi raccontati, registrazione, banco. Il lavoro vero della chiamata gira già nel motore di Topics, ma la chiamata non lo vede (legge i passi ogni 3 s da fuori) e Topics non sa che esiste. Attilio vuole un posto solo.

Vincolo duro: la linea WhatsApp non si sposta. Le chiamate WhatsApp esistono solo in whatsapp-rust (VoIP mlow, relay nativo); nessuna libreria JS le fa. Quindi il confine è: **il canale porta l'audio, Topics fa la chiamata.**

## Cosa cambia
- **Topics: servizio `voice-call`** (server/services/voice-call/), porta di `src/voice/` in TypeScript: audio (VAD, ricampionamento 24→16 kHz, riproduzione, velocità), sessione Gemini Live (con `generationComplete`), cervello (modello Claude via i provider di Topics, risposta strutturata), voce veloce (Groq) e «bocca» con la stessa voce, passi del lavoro, intercalari, registrazione, esito. Stesse regole e stesse correzioni del Rust (13-14/11), con i loro test.
- **Topics: ponte generico `WS /api/voice/bridge`**: un canale qualsiasi apre la chiamata (`start` con nome, verso, motivo), manda l'audio dell'altro (PCM16 16 kHz, binario) e riceve quello da suonare; scambia `answered`, `handoff` (compito per l'agente), `progress` (passi), `reply` (risultato), `hangup`, `ended`, `outcome`. Regola zero: niente di Attilio nel codice, chiavi e voce nelle impostazioni.
- **jarvis-channels: solo filo.** Con `voce.motore = "topics"` la chiamata (in entrata e in uscita, e per conto) passa l'audio al ponte; i compiti e i risultati continuano a passare dai turni di oggi (stesse regole, stessa chat). Con `"locale"` resta il Rust di oggi: è il ritorno indietro, finché le chiamate vere non sono pulite.
- **Banco**: gli scenari (`scenari.json`, clip vere fuori dal repo, cartella da impostazione) girano contro Topics attraverso il ponte, con un finto canale.

## Barra
- `bun test server/services/voice-call` esce 0, con i test portati dal Rust (riconoscimento, passi vecchi, domanda doppia, `generationComplete`, risultati brevi, saluto testuale).
- Mutazioni: togliendo `generationComplete`, la regola «passo pronto mentre parla si butta» o `repeatedQuestion`, il test di ciascuna diventa rosso.
- Banco scenari contro Topics: almeno quanto il Rust il 14/11 (16/18, resta solo la clip «quindi pure»), 2 giri.
- Chiamata vera in entrata (Attilio chiama Jarvis) e in uscita (Jarvis chiama Attilio) col motore Topics: registro e registrazione senza niente da correggere, giudicata da Attilio.
- Ciò che è verde resta verde: CI di Topics, test di jarvis-channels.

## Fuori
La linea WhatsApp e i messaggi restano in jarvis-channels. Nessuna vista nuova in Topics in questa change. Nessuna voce nuova né cambio di modelli. Il Rust di `src/voice/` non si cancella finché le chiamate vere col motore Topics non sono pulite (poi è una change a parte).

## Deciso da me
Cervello sui provider di Topics e non su Switchboard: Switchboard è di questa macchina, Topics deve funzionare per chiunque. Compiti e risultati restano sul giro dei turni di jarvis-channels: hanno già identità, regole e chat giuste, rifarli in Topics vorrebbe dire due strade per la stessa cosa.

## Non ancora specificato
Una vista della chiamata dal vivo in Topics (trascrizione, passi, registrazione). Se e quando cancellare il Rust.
