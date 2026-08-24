#!/usr/bin/env bun
/**
 * Un handshake SOLO, contro Discord vero, per rispondere a una domanda sola:
 * questa applicazione è mia?
 *
 * PERCHE' ESISTE: quando la presence resta in `error` con «nessun READY», la
 * spiegazione ovvia è che l'Application ID non appartenga a questo account.
 * E' spesso falsa. Discord chiude in silenzio anche quando gli handshake sono
 * troppo ravvicinati: misurato su `discord-ipc-0`, il primo risponde in mezzo
 * secondo e il terzo di fila scade. Il 24/08 questa diagnosi sbagliata ha fatto
 * annullare un cambio di applicazione che stava riuscendo.
 *
 * Isolato vuol dire isolato: se il server sta ritentando ogni minuto, la sonda
 * gareggia con lui e può ereditare il suo timeout. Ferma il server, oppure
 * accetta che un rosso qui vada riprovato.
 *
 *   bun run scripts/discord-ipc-probe.ts [APPLICATION_ID]
 *
 * Senza argomento usa lo stesso id del servizio (DISCORD_CLIENT_ID, o il
 * default del codice), che è la domanda giusta nove volte su dieci: «l'app che
 * sto per usare davvero, risponde?».
 */
import { DEFAULT_CLIENT_ID } from "../server/services/discord-presence";
import { DiscordIpcError, existingIpcCandidates, handshake } from "../server/services/discord-ipc";

const clientId = process.argv[2] ?? process.env.DISCORD_CLIENT_ID?.trim() ?? DEFAULT_CLIENT_ID;

if (!/^[0-9]{17,20}$/.test(clientId)) {
  console.error(`non sembra un Application ID Discord (attesi 17-20 numeri): ${clientId}`);
  process.exit(64);
}

const candidates = existingIpcCandidates();
console.log(`applicazione : ${clientId}`);
console.log(`socket       : ${candidates.length === 0 ? "nessuno" : candidates.join(", ")}`);

const started = Date.now();
try {
  // Il timeout è il DOPPIO di quello del servizio (4s): una sonda che scade
  // prima del vero client risponderebbe a una domanda diversa da quella posta.
  const res = await handshake({ clientId, timeoutMs: 8000 });
  const ms = Date.now() - started;
  try { res.socket.destroy(); } catch { /* già morto */ }
  console.log(`\nREADY in ${ms}ms su ${res.socketPath}`);
  console.log(`utente       : ${res.user?.username ?? "?"} (${res.user?.id ?? "?"})`);
  console.log(`\nL'applicazione risponde: e' di questo account.`);
  console.log(`Se la presence resta in errore, NON sono le credenziali.`);
  process.exit(0);
} catch (err) {
  const ms = Date.now() - started;
  const code = err instanceof DiscordIpcError ? err.code : "socket_error";
  console.error(`\nfallito dopo ${ms}ms: ${(err as Error)?.message ?? err}`);
  if (code === "no_socket") {
    console.error(`\nDiscord desktop non e' in esecuzione: non c'e' niente da interrogare.`);
  } else {
    // Le due cause hanno lo stesso sintomo, e distinguerle costa un minuto di
    // attesa: dirlo qui evita di scambiare un limite di frequenza per un furto
    // di identita'.
    console.error(`\nDue cause danno lo stesso silenzio:`);
    console.error(`  - handshake troppo ravvicinati (aspetta ~60s e rilancia questa sonda);`);
    console.error(`  - l'applicazione non appartiene a questo account.`);
    console.error(`Un secondo tentativo verde a freddo scagiona l'applicazione.`);
  }
  process.exit(1);
}
