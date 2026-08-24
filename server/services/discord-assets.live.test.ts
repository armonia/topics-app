/**
 * La domanda a DISCORD VERO: onora un `large_image` esterno?
 *
 * PERCHE' UN TEST CHE PARLA COL MONDO
 * Per un anno il codice ha portato scritto che no, Discord ignora gli URL
 * esterni finche' non carichi un asset sul portale sviluppatori — e che quindi
 * l'ultimo passo non era codice ma un lavoro manuale a mano dell'umano.
 * Nessun test finto poteva smentirlo: un `IpcSocket` di prova risponde quello
 * che gli abbiamo insegnato a rispondere. Lo ha smentito l'unica cosa che
 * sapeva la verita', cioe' Discord.
 *
 * Il fatto misurato il 24/08, con l'applicazione a ZERO asset: l'URL passa e
 * torna indietro riscritto in `mp:external/...`, la forma con cui Discord dice
 * «me ne sono fatto carico, lo servo dalla mia CDN».
 *
 * IL CONTROLLO NEGATIVO E' IL TEST
 * Che un campo torni indietro non significa nulla se torna indietro sempre.
 * Qui si manda anche una chiave inventata: quella SPARISCE dalla risposta.
 * E' la differenza fra le due risposte a dire che l'URL e' stato accettato
 * davvero, e senza il caso negativo questo file sarebbe una tautologia.
 *
 * SI SALTA DA SOLO quando Discord non c'e' (CI, macchina altrui, app chiusa):
 * un test che dipende dal mondo non deve tingere di rosso una suite per un
 * fatto che non riguarda il codice.
 *
 * E SI SALTA ANCHE QUANDO NON E' STATO CHIESTO. Discord serve un client per
 * volta su quel socket: eseguirlo mentre il server di Topics e' collegato gli
 * strappa il filo, e la presence resta in `error` finche' il backoff non la
 * riporta su — misurato, ~70 secondi di card sbagliata sul profilo di chi
 * stava solo lanciando i test. Un test che rompe cio' che osserva si esegue
 * quando lo si vuole, non per sbaglio: serve `DISCORD_LIVE_TEST=1`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameDecoder, encodeFrame, handshake, IPC_OP } from "./discord-ipc";
import { DEFAULT_CLIENT_ID, DEFAULT_LARGE_IMAGE } from "./discord-presence";

/**
 * Il socket di Discord, cercato dove il sistema lo mette davvero.
 *
 * Non basta `tmpdir()`: sotto un supervisore (o dentro questo agente) il
 * TMPDIR del processo e' una directory privata, mentre Discord scrive nel
 * TMPDIR dell'utente. Si guardano entrambi.
 */
function socketDiscord(): string | null {
  const radici = [tmpdir(), process.env.TMPDIR ?? "", "/tmp"].filter(Boolean);
  // Il TMPDIR dell'utente, quello vero, quando il nostro e' stato dirottato.
  try {
    for (const base of ["/var/folders"]) {
      if (!existsSync(base)) continue;
      for (const a of readdirSync(base).slice(0, 40)) {
        const dir = join(base, a);
        try {
          for (const b of readdirSync(dir).slice(0, 40)) radici.push(join(dir, b, "T"));
        } catch { /* permessi: si prosegue */ }
      }
    }
  } catch { /* niente /var/folders: si usano le radici semplici */ }

  for (const r of radici) {
    for (let i = 0; i < 10; i++) {
      const p = join(r, `discord-ipc-${i}`);
      try {
        if (existsSync(p)) return p;
      } catch { /* non leggibile: avanti */ }
    }
  }
  return null;
}

/**
 * Il test parla col mondo solo se glielo si chiede E se il mondo c'e'.
 * Entrambe le condizioni, perche' bastano l'una senza l'altra a produrre un
 * rosso che non parla del codice.
 */
const ABILITATO = process.env.DISCORD_LIVE_TEST === "1";
const SOCK = ABILITATO ? socketDiscord() : null;

describe.skipIf(!SOCK)("Discord vero: gli asset che accetta", () => {
  test("onora un large_image esterno anche senza asset caricati sul portale", async () => {
    const r = await handshake({ clientId: DEFAULT_CLIENT_ID, candidates: [SOCK!], timeoutMs: 8000 });
    const sock = r.socket as unknown as {
      on: (e: string, f: (c: Uint8Array) => void) => void;
      write: (b: Uint8Array) => void;
      end?: () => void;
      destroy?: () => void;
    };
    const decode = createFrameDecoder();
    const risposte: Array<Record<string, any>> = [];
    sock.on("data", (c) => { for (const f of decode(c)) risposte.push(f.payload as any); });

    async function pubblica(nonce: string, large: string): Promise<Record<string, any> | undefined> {
      sock.write(encodeFrame(IPC_OP.FRAME, {
        cmd: "SET_ACTIVITY",
        nonce,
        args: { pid: process.pid, activity: { details: "test", state: nonce, assets: { large_image: large, large_text: "Topics" } } },
      }));
      for (let i = 0; i < 30; i++) {
        const trovata = risposte.find((x) => x?.nonce === nonce);
        if (trovata) return trovata;
        await new Promise((s) => setTimeout(s, 100));
      }
      return undefined;
    }

    try {
      const esterno = await pubblica("esterno", DEFAULT_LARGE_IMAGE);
      const inventata = await pubblica("inventata", "chiave_che_non_esiste_42");

      // L'URL esterno sopravvive, e Discord lo riscrive come risorsa propria.
      expect(esterno?.data?.assets?.large_image).toBeTruthy();
      expect(String(esterno?.data?.assets?.large_image)).toStartWith("mp:external/");

      // Il controllo negativo: una chiave che non esiste viene buttata via.
      // Senza questa riga, la precedente non proverebbe niente.
      expect(inventata?.data?.assets?.large_image).toBeUndefined();
    } finally {
      // Non si lascia in giro una presence di prova sul profilo di chi esegue.
      sock.write(encodeFrame(IPC_OP.FRAME, { cmd: "SET_ACTIVITY", nonce: "pulizia", args: { pid: process.pid, activity: null } }));
      await new Promise((s) => setTimeout(s, 300));
      sock.end?.();
      sock.destroy?.();
    }
  }, 30_000);
});
