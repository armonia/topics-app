#!/usr/bin/env bun
/**
 * Coniare una licenza. È il pezzo che mancava per poter VENDERE davvero.
 *
 * ── PERCHÉ SERVE UNO SCRIPT E NON UN SERVIZIO ───────────────────────────────
 * Il servizio delle licenze non esiste ancora, e per i primi clienti non serve:
 * si incassa a mano (bonifico, fattura, Stripe in un secondo momento) e si
 * emette un gettone a mano. Questo strumento è ciò che rende quel giro
 * possibile OGGI invece che dopo il piano di controllo — e resta utile dopo,
 * perché è la stessa funzione che il servizio chiamerà.
 *
 * Senza di lui la macchina delle licenze è completa e INERTE: `CHIAVI_INTEGRATE`
 * è vuota, quindi nessun gettone può essere verificato, quindi tutto resta sul
 * piano gratuito per sempre. Verificabile: `verificaGettone` risponde
 * `no_verification_key` prima ancora di guardare la firma.
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
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";

const [, , comando, ...resto] = process.argv;

/** Il `kid` non decide niente (la verifica prova comunque tutte le chiavi), ma
 *  dice QUALE chiave ha firmato quando un giorno ce ne sarà più di una. */
const KID = process.env.TOPICS_LICENSE_KID || "armonia-1";

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
  const grezza = (process.env.TOPICS_LICENSE_PRIVKEY ?? "").trim();
  if (!grezza) {
    console.error("Serve TOPICS_LICENSE_PRIVKEY. Generala con: scripts/licenza.ts chiavi");
    process.exit(1);
  }
  const [iid, postiRaw, giorniRaw] = resto;
  if (!iid) {
    console.error(`Serve l'installationId del cliente. Lo legge da sé: curl -sk https://…/api/license`);
    process.exit(1);
  }
  const posti = Number(postiRaw ?? 5);
  const giorni = Number(giorniRaw ?? 365);
  if (!Number.isInteger(posti) || posti < 1 || posti > 10_000) {
    console.error("I posti devono essere un intero fra 1 e 10000.");
    process.exit(1);
  }
  if (!Number.isFinite(giorni) || giorni <= 0) {
    console.error("I giorni devono essere un numero positivo.");
    process.exit(1);
  }

  // I 32 byte grezzi tornano una chiave privata solo col prefisso PKCS#8 di
  // Ed25519 davanti: `node:crypto` non accetta il seed nudo.
  const seed = Buffer.from(grezza, "base64url");
  if (seed.length !== 32) {
    console.error(`La chiave privata deve essere 32 byte in base64url (letti: ${seed.length}).`);
    process.exit(1);
  }
  const privata = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });

  const adesso = Date.now();
  const carico = {
    v: 1 as const,
    iid,
    plan: "team" as const,
    seats: posti,
    // La scadenza è OBBLIGATORIA nel formato, e non è una formalità: un gettone
    // senza scadenza sopravvive alla fine dell'abbonamento e a chi l'ha emesso.
    exp: adesso + Math.round(giorni * 86_400_000),
    iat: adesso,
    kid: KID,
  };

  const pCarico = Buffer.from(JSON.stringify(carico), "utf8").toString("base64url");
  // Si firma il SEGMENTO in ascii, non i byte del JSON: è ciò che `verificaGettone`
  // ricostruisce con `Buffer.from(pCarico, "ascii")`. Firmare l'altra cosa dà un
  // gettone che non verifica, e l'errore sarebbe indistinguibile da una chiave
  // sbagliata.
  const firma = sign(null, Buffer.from(pCarico, "ascii"), privata);
  const gettone = `${pCarico}.${firma.toString("base64url")}`;

  console.log(`
── GETTONE ──────────────────────────────────────────────────────────────────
installazione : ${iid}
posti         : ${posti}
scade         : ${new Date(carico.exp).toISOString().slice(0, 10)}

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
