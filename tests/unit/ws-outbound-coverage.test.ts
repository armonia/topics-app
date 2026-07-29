/**
 * Il registro degli schemi WS in uscita deve COPRIRE quello che il server
 * emette davvero.
 *
 * `validateOutbound` fa passthrough sui tipi che non conosce: è la scelta che
 * ha reso possibile migrare a pezzi, ma è anche il motivo per cui un tipo nuovo
 * non fa MAI rumore — nessuno se ne accorge finché un client non esplode su un
 * payload malformato. Questo test chiude il buco dalla parte dell'autore:
 * scansiona i punti di emissione reali e fallisce se un tipo emesso non ha uno
 * schema, e viceversa se uno schema descrive un messaggio che il server non
 * manda più (contratto di finzione).
 *
 * Lo scan è statico, quindi vede solo le emissioni con il tipo scritto come
 * LETTERALE. Un tipo costruito da una variabile gli sfugge: quel buco lo chiude
 * la tipizzazione di `broadcast` (fase B), non questo test.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGISTERED_OUTBOUND_TYPES } from "../../shared/ws-outbound";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Tipi con uno schema ma nessuna emissione nel sorgente. Ognuno va motivato:
 * un'entrata senza motivo è un contratto morto che nessuno ha ancora tolto.
 */
const DORMANT: Record<string, string> = {
  // Il client li ASCOLTA ancora (usePanelLifecycle, useTabNotifications): lo
  // schema resta come contratto di ciò che quel gestore si aspetta, finché
  // qualcuno decide se togliere il gestore o ripristinare l'emissione.
  "agent:escalation": "gestito da useTabNotifications, emissione server assente",
  "agent:heartbeat": "dichiarato in client/types, emissione server assente",
  "browser:force-open": "gestito da usePanelLifecycle, emissione server assente",
  "topic:switch:complete": "gestito da usePanelLifecycle, emissione server assente",
  // Superati da `topic:*` in v3: nessuno li manda e nessuno li ascolta più.
  // Restano solo per non rompere un client vecchissimo che li parsi ancora.
  "chat:created": "legacy pre-v3, sostituito da topic:created",
  "chat:updated": "legacy pre-v3, sostituito da topic:updated",
  "chat:archived": "legacy pre-v3, sostituito da topic:archived",
  "chat:deleted": "legacy pre-v3, sostituito da topic:deleted",
  // Il picker legge lo snapshot (`providers:snapshot`), non questi due.
  "provider:current": "sostituito da providers:snapshot",
  "provider:changed": "sostituito da providers:snapshot",
  "agent:status": "sostituito da agents:sessions",
};

/** Sorgenti del server: quelli che possono emettere. Test e schemi esclusi. */
function serverSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "schemas") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) serverSources(p, out);
    else if (/\.(ts|mjs)$/.test(p) && !/\.(test|fixture)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * I punti di emissione: un literal `type: "x"` in testa a un oggetto (che sia
 * passato inline al broadcast o assegnato a una variabile), e gli helper
 * `emit("x", payload)` che ogni router si definisce in cima al file.
 */
const EMISSION_PATTERNS = [
  /\btype:\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
  /\bemit\w*\(\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
  /\bbroadcast\w*\(\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
];

function scanEmitted(): Map<string, Set<string>> {
  const files = [...serverSources(join(ROOT, "server")), join(ROOT, "server.ts")];
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const re of EMISSION_PATTERNS) {
      for (const m of src.matchAll(re)) {
        const type = m[1]!;
        // Un `type` senza `:` è quasi sempre un discriminante di dominio
        // (`type: "shell"`, `type: "text"`), non un messaggio WS. I pochi
        // messaggi senza namespace sono già tutti nel registro, quindi
        // filtrare così non perde nulla e toglie centinaia di falsi positivi.
        if (!type.includes(":") && !REGISTERED_OUTBOUND_TYPES.includes(type)) continue;
        if (!found.has(type)) found.set(type, new Set());
        found.get(type)!.add(file.slice(ROOT.length + 1));
      }
    }
  }
  return found;
}

const emitted = scanEmitted();

describe("copertura del registro ws-outbound", () => {
  test("ogni tipo EMESSO dal server ha uno schema", () => {
    const missing = [...emitted.entries()]
      .filter(([type]) => !REGISTERED_OUTBOUND_TYPES.includes(type))
      .map(([type, files]) => `${type} (${[...files].sort().join(", ")})`)
      .sort();

    // Il messaggio elenca i colpevoli col file: chi aggiunge un broadcast nuovo
    // sa esattamente dove mettere lo schema, senza cercarlo.
    expect(missing).toEqual([]);
  });

  test("ogni tipo DICHIARATO è emesso, o è dormiente con una motivazione", () => {
    const fiction = REGISTERED_OUTBOUND_TYPES
      .filter((type) => !emitted.has(type) && !(type in DORMANT))
      .sort();

    expect(fiction).toEqual([]);
  });

  test("la lista dei dormienti non contiene tipi tornati vivi", () => {
    const resurrected = Object.keys(DORMANT).filter((type) => emitted.has(type)).sort();

    expect(resurrected).toEqual([]);
  });

  test("lo scan trova davvero le emissioni (guardia anti-test-vuoto)", () => {
    // Se un refactor sposta i broadcast e i pattern smettono di matchare, i
    // test sopra passerebbero tutti a vuoto. Questa soglia lo impedisce.
    expect(emitted.size).toBeGreaterThan(60);
    expect(emitted.get("stream:end")?.size).toBeGreaterThan(0);
  });
});
