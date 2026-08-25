/**
 * Cricchetto anti-specchio: nessun tipo nuovo dichiarato DUE volte, una per lato.
 *
 * Il motivo per cui esiste. Fino al 29/07 il client riscriveva a mano decine di
 * tipi che il server già dichiarava, con sopra un commento tipo "Mirrors
 * server/types.ts:Topic — KEEP IN SYNC". Il commento non ha mai tenuto niente
 * in sync: `Topic.mcpPolicy` e `Topic.browserState` non sono mai arrivati al
 * client, `BoardSettings` lato client non conosceva `dispatchRetryCap` (una
 * PATCH costruita da quel tipo li avrebbe azzerati), lo schema `resize` del
 * browser aveva i vincoli solo lato server e lo specchio accettava `width: -1`.
 * La scusa era sempre la stessa — "TS6307 vieta l'import fra i due progetti" —
 * e valeva per ogni cartella TRANNE `shared/`, che entrambi possono includere.
 *
 * Cosa impedisce. Che qualcuno dichiari un tipo con lo STESSO NOME sia sotto
 * `client/src/**` sia sotto `server/**`+`shared/**`. Il posto giusto è
 * `shared/`, con entrambi i lati che ri-esportano: un `export type { X } from
 * '…'` non è una dichiarazione e infatti non viene contato qui, nemmeno con un
 * alias (`export type { X as Y }`) — che è la via d'uscita quando i due lati
 * vogliono chiamarlo diversamente.
 *
 * Cosa NON impedisce. Due tipi con lo stesso nome che sono davvero due cose
 * diverse: quelli stanno in ALLOWLIST, uno per uno, col motivo scritto. La
 * lista è anche un cricchetto al contrario — se una voce smette di essere un
 * duplicato il test fallisce lo stesso, così l'allowlist non marcisce.
 *
 * Euristica, non un compilatore: confronta NOMI, non forme. Un tipo dichiarato
 * una volta sola in un posto sbagliato non lo vede nessuno. È il costo di un
 * controllo che gira in mezzo secondo su tutto il repo.
  * @covers GATE-08
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/**
 * Nomi legittimamente omonimi sui due lati: concetti diversi che per sfortuna
 * si chiamano uguale. Ogni voce porta il motivo — se serve aggiungerne una,
 * il motivo è la parte che conta, non la riga.
 */
const ALLOWED: Record<string, string> = {
  AppSettings:
    'Client = preferenze della UI (fontSize, densità, larghezza sidebar, toggle). ' +
    'Server (services/app-settings.ts) = configurazione dei provider AI (modello, ' +
    'max tokens, effort). Nessun campo in comune, nessuno dei due attraversa il filo ' +
    "come l'altro: è solo un nome sfortunato preso due volte.",
  ContextUsage:
    'Client = la forma appiattita che la UI renderizza, prodotta in locale da ' +
    '`useRealContext.flatten(ContextUpdatePayload)`. Server (usage/context-window.ts) ' +
    '= il risultato intermedio di `classifyContext`, che non esce mai dal processo. ' +
    'Il tipo che attraversa davvero il filo è `ContextUpdatePayload`, ed è uno solo.',
};
// Nessuna voce per `StreamEvent`: le DUE dichiarazioni omonime sono state
// rimosse il 31/07, perché nessuna delle due aveva un lettore. Lato server il
// protocollo vero è `StreamHandler` (callback), lato client sono i membri
// `stream:*` dell'unione `WSMessage`. L'allowlist è un cricchetto al contrario —
// se il duplicato sparisce, la voce deve sparire con lui.

const DECLARATION = /^\s*export\s+(?:declare\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** nome dichiarato → file (relativi a ROOT) che lo dichiarano. */
function declarationsIn(dirs: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of dirs) {
    for (const file of walk(join(ROOT, dir))) {
      for (const match of readFileSync(file, 'utf8').matchAll(DECLARATION)) {
        const name = match[1]!;
        const files = found.get(name) ?? [];
        files.push(relative(ROOT, file));
        found.set(name, files);
      }
    }
  }
  return found;
}

const client = declarationsIn(['client/src']);
const backend = declarationsIn(['server', 'shared']);
const duplicates = [...client.keys()].filter((n) => backend.has(n)).sort();

describe('nessuno specchio di tipi fra client e server', () => {
  test("il repo non ha specchi nuovi (se ne aggiungi uno: mettilo in shared/, non ricopiarlo)", () => {
    const unexpected = duplicates.filter((n) => !(n in ALLOWED));
    const detail = unexpected
      .map((n) => `  ${n}\n    client: ${client.get(n)!.join(', ')}\n    server: ${backend.get(n)!.join(', ')}`)
      .join('\n');
    expect(
      unexpected,
      unexpected.length
        ? `Tipi dichiarati su ENTRAMBI i lati:\n${detail}\n\n` +
          'Sposta la dichiarazione in shared/ e ri-esportala dai due lati ' +
          "(`export type { X } from '…/shared/…'` — se il client ha bisogno di un " +
          "altro nome, usa un alias). Se invece sono davvero due concetti diversi, " +
          'aggiungi il nome ad ALLOWED qui sotto col motivo.'
        : '',
    ).toEqual([]);
  });

  test("l'allowlist non contiene voci morte", () => {
    const stale = Object.keys(ALLOWED).filter((n) => !duplicates.includes(n));
    expect(
      stale,
      stale.length
        ? `Non sono più duplicati — togli la voce da ALLOWED: ${stale.join(', ')}`
        : '',
    ).toEqual([]);
  });

  test('ogni voce di ALLOWED spiega perché', () => {
    for (const [name, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `ALLOWED.${name} deve dire perché i due tipi sono diversi`).toBeGreaterThan(60);
    }
  });

  test('lo scanner vede qualcosa (guardia contro un walk che gira a vuoto)', () => {
    expect(client.size).toBeGreaterThan(200);
    expect(backend.size).toBeGreaterThan(200);
  });
});
