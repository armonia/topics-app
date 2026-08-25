#!/usr/bin/env bun
/**
 * ONE handshake, against the real Discord, to answer one single question: is
 * this application mine?
 *
 * WHY IT EXISTS: when presence stays in `error` with «nessun READY», the  allow-italian: quotes the error message the code emits
 * obvious explanation is that the Application ID does not belong to this
 * account. It is often false. Discord also closes silently when handshakes
 * come too close together: measured on `discord-ipc-0`, the first answers in
 * half a second and the third in a row times out. On 24/08 this wrong
 * diagnosis got a change of application that was succeeding called off.
 *
 * Isolated means isolated: if the server is retrying every minute, the probe
 * races against it and can inherit its timeout. Stop the server, or accept
 * that a red here has to be retried.
 *
 *   bun run scripts/discord-ipc-probe.ts [APPLICATION_ID]
 *
 * With no argument it uses the service's own id (DISCORD_CLIENT_ID, or the
 * code's default), which is the right question nine times out of ten: "the app
 * I am actually about to use, does it answer?".
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
  // The timeout is DOUBLE the service's (4s): a probe that expires before the
  // real client would be answering a different question from the one asked.
  const res = await handshake({ clientId, timeoutMs: 8000 });
  const ms = Date.now() - started;
  try { res.socket.destroy(); } catch { /* already dead */ }
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
    // The two causes have the same symptom, and telling them apart costs a
    // minute of waiting: saying so here keeps a rate limit from being mistaken
    // for a stolen identity.
    console.error(`\nDue cause danno lo stesso silenzio:`);
    console.error(`  - handshake troppo ravvicinati (aspetta ~60s e rilancia questa sonda);`);
    console.error(`  - l'applicazione non appartiene a questo account.`);
    console.error(`Un secondo tentativo verde a freddo scagiona l'applicazione.`);
  }
  process.exit(1);
}
