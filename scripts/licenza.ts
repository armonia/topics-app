#!/usr/bin/env bun
/**
 * Coniare una licenza. È il pezzo che mancava per poter VENDERE davvero.
 *
 * ── LO SCRIPT E IL SERVIZIO, E PERCHÉ CI SONO ENTRAMBI ──────────────────────
 * Il giro automatico esiste: `scripts/conio-licenze.ts` ascolta Stripe e conia
 * da sé. Questo script resta perché non tutti i clienti passano da Stripe —
 * bonifico, fattura, una prova concordata a voce — e perché quando il servizio
 * non conia bisogna poter emettere il gettone a mano, subito, senza aspettare
 * che qualcuno ripari il servizio mentre un cliente che ha pagato guarda il
 * piano gratuito.
 *
 * Firmano con LA STESSA funzione (`scripts/conio-lib.ts`): due implementazioni
 * della stessa firma sono due implementazioni che col tempo si allontanano.
 *
 * ── LA CHIAVE PRIVATA NON LA SCRIVE, LA STAMPA ──────────────────────────────
 * `chiavi` genera la coppia e stampa entrambe le metà a schermo. NON scrive la
 * privata da nessuna parte: né nel repo, né in un file di comodo che poi resta
 * lì. Dove vive quel segreto è una decisione, e va presa guardandola — non
 * subita perché uno script l'ha depositata in una cartella.
 *
 * Uso:
 *   scripts/licenza.ts chiavi
 *       genera una coppia Ed25519. La pubblica va nel codice, la privata la
 *       metti dove tieni i segreti.
 *
 *   TOPICS_LICENSE_PRIVKEY=<base64> scripts/licenza.ts conia <installationId> [posti] [giorni]
 *       emette un gettone per QUELLA installazione. Default: 5 posti, 365 giorni.
 *
 *   scripts/licenza.ts ispeziona <gettone>
 *       legge un gettone senza verificarlo: serve a rispondere a «cosa ho
 *       mandato a quel cliente?» senza avere la chiave sottomano.
 */
import { generateKeyPairSync } from "node:crypto";
import { caricaPrivata, coniaGettone, KID_DEFAULT, POSTI_MAX, POSTI_MIN } from "./conio-lib";

const [, , comando, ...resto] = process.argv;

/** Il `kid` non decide niente (la verifica prova comunque tutte le chiavi), ma
 *  dice QUALE chiave ha firmato quando un giorno ce ne sarà più di una. */
const KID = process.env.TOPICS_LICENSE_KID || KID_DEFAULT;

function chiavi(): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // I 32 byte grezzi, non il PEM: è il formato che `caricaChiavi` si aspetta,
  // e lo stesso che va nella variabile d'ambiente.
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);

  console.log(`
── CHIAVE PUBBLICA ──────────────────────────────────────────────────────────
Va nel codice, in server/lib/licenza.ts:

  export const CHIAVI_INTEGRATE: readonly string[] = [
    "${KID}:${pub.toString("base64url")}",
  ];

Oppure, per una prova senza toccare il codice:

  export TOPICS_LICENSE_PUBKEYS="${KID}:${pub.toString("base64url")}"

── CHIAVE PRIVATA ───────────────────────────────────────────────────────────
Questa NON viene scritta da nessuna parte. Mettila dove tieni i segreti (un
gestore di password, non un file nel repo). Chi ce l'ha può emettere licenze
per qualunque installazione.

  ${priv.toString("base64url")}

── PROVA SUBITO ─────────────────────────────────────────────────────────────
  TOPICS_LICENSE_PRIVKEY="${priv.toString("base64url")}" \\
    scripts/licenza.ts conia <installationId> 5 365
`);
}

function conia(): void {
  const [iid, postiRaw, giorniRaw] = resto;
  if (!iid) {
    console.error(`Serve l'installationId del cliente. Lo legge da sé: curl -sk https://…/api/license`);
    process.exit(1);
  }
  const posti = Number(postiRaw ?? 5);
  const giorni = Number(giorniRaw ?? 365);
  if (!Number.isInteger(posti) || posti < POSTI_MIN || posti > POSTI_MAX) {
    console.error(`I posti devono essere un intero fra ${POSTI_MIN} e ${POSTI_MAX}.`);
    process.exit(1);
  }
  if (!Number.isFinite(giorni) || giorni <= 0) {
    console.error("I giorni devono essere un numero positivo.");
    process.exit(1);
  }

  // La firma la fa `scripts/conio-lib.ts`, cioè LA STESSA funzione che usa il
  // servizio di conio: due implementazioni della stessa firma sono due
  // implementazioni che col tempo si allontanano, e quella che si allontana è
  // sempre quella che nessuno prova.
  const chiave = caricaPrivata(process.env.TOPICS_LICENSE_PRIVKEY);
  if (!chiave.ok) {
    console.error(chiave.motivo === "assente"
      ? "Serve TOPICS_LICENSE_PRIVKEY. Generala con: scripts/licenza.ts chiavi"
      : "TOPICS_LICENSE_PRIVKEY non è una chiave Ed25519: servono 32 byte in base64url.");
    return process.exit(1);
  }

  const adesso = Date.now();
  const scadenza = adesso + Math.round(giorni * 86_400_000);
  const gettone = coniaGettone({
    installationId: iid,
    posti,
    scadenza,
    adesso,
    chiave: chiave.chiave,
    kid: KID,
  });

  console.log(`
── GETTONE ──────────────────────────────────────────────────────────────────
installazione : ${iid}
posti         : ${posti}
scade         : ${new Date(scadenza).toISOString().slice(0, 10)}

${gettone}

Il cliente lo installa da Impostazioni → Piano, incollandolo nel campo e
premendo «Installa». Oppure, se preferisce il terminale (PUT, non POST: è
la stessa rotta che l'interfaccia chiama):

  curl -sk -X PUT https://127.0.0.1:3333/api/license \\
    -H 'Content-Type: application/json' \\
    -d '{"token":"${gettone.slice(0, 24)}…"}'

oppure mettendolo in TOPICS_LICENSE_TOKEN.
`);
}

function ispeziona(): void {
  const g = (resto[0] ?? "").trim();
  const pezzi = g.split(".");
  if (pezzi.length !== 2) {
    console.error("Non è un gettone: servono due segmenti separati da un punto.");
    process.exit(1);
  }
  try {
    const carico = JSON.parse(Buffer.from(pezzi[0]!, "base64url").toString("utf8"));
    // «Ispeziona» NON verifica, e lo dice: leggere un gettone senza la chiave
    // risponde a «cosa ho mandato a quel cliente?», non a «è valido?».
    console.log(JSON.stringify(carico, null, 2));
    console.log(`\nscade: ${new Date(carico.exp).toISOString()} (${carico.exp < Date.now() ? "SCADUTO" : "valido"})`);
    console.log("Attenzione: la firma NON è stata verificata. Questo comando legge, non convalida.");
  } catch {
    console.error("Il carico non è JSON leggibile.");
    process.exit(1);
  }
}

switch (comando) {
  case "chiavi": chiavi(); break;
  case "conia": conia(); break;
  case "ispeziona": ispeziona(); break;
  default:
    console.log(`Coniare una licenza.

  scripts/licenza.ts chiavi
      genera una coppia Ed25519 (la privata la stampa, non la scrive)

  TOPICS_LICENSE_PRIVKEY=<base64url> scripts/licenza.ts conia <installationId> [posti] [giorni]
      emette un gettone per quella installazione (default 5 posti, 365 giorni)

  scripts/licenza.ts ispeziona <gettone>
      legge un gettone senza verificarlo
`);
}
