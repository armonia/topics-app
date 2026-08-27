import { join, dirname } from "path";
import { existsSync, statSync } from "fs";
import { homedir } from "os";

/**
 * Indovinare la cartella di progetto di una chat leggendo i suoi messaggi.
 *
 * Serve perché una chat nata da fuori — dal router Discord/Telegram, da una
 * sessione cloud — non porta con sé nessun progetto: se ne parla soltanto. Il
 * legame si prova a dedurlo dal testo invece di chiedere un giro di modello in
 * più.
 *
 * ── Il difetto che ha insegnato la regola ───────────────────────────────────
 * Il ripiego «la cartella non esiste ancora» restituiva il primo candidato
 * SENZA nessun controllo. Un messaggio che diceva
 *
 *     il CLI `discord` NON è nel PATH, sta in ~/.claude/jarvis/router/scripts/discord
 *
 * ha legato la chat a un ESEGUIBILE da 16 KB, e nella barra laterale è comparso
 * un progetto fantasma chiamato «discord» — il basename del file. Il primo giro
 * quel path l'aveva già guardato e scartato, perché `isDirectory()` è falso; il
 * ripiego lo ripescava contraddicendo quella decisione.
 *
 * La regola, in una riga: **il ripiego non può contraddire il primo giro**. Vale
 * solo per i path che NON esistono, che è il caso per cui è stato scritto.
 *
 * Le funzioni del filesystem sono iniettabili perché questo modulo si possa
 * provare senza toccare il disco vero.
 */

export interface FsProbe {
  esiste(p: string): boolean;
  eCartella(p: string): boolean;
}

const REAL_FS: FsProbe = {
  esiste: (p) => existsSync(p),
  eCartella: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
};

/**
 * I modi in cui una frase nomina un percorso.
 *
 * Nuovi in fondo: l'ordine è la priorità, e il primo che aggancia vince.
 */
const MODELLI = [
  /(?:in|to|at|from|create|mkdir|cd)\s+(\/(?:tmp|Users|home|var|opt|srv)\/[\w./-]+)/gi,
  /(?:in|to|at|from|create|mkdir|cd)\s+(~\/[\w./-]+)/gi,
  /(?:project|app|directory|folder|dir)\s+(?:at|in|is)?\s*(\/[\w./-]+)/gi,
];

/** I candidati nudi di un testo, espansi e ripuliti. */
function candidatesIn(testo: string, home: string): string[] {
  const out: string[] = [];
  for (const modello of MODELLI) {
    modello.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = modello.exec(testo)) !== null) {
      let p = m[1].replace(/[.,;:!?)]+$/, ""); // via la punteggiatura in coda
      if (p.startsWith("~/")) p = join(home, p.slice(2));
      // Meno di due livelli non è un progetto: è `/tmp`, `/Users`, una radice.
      if (p.split("/").filter(Boolean).length >= 2) out.push(p);
    }
  }
  return out;
}

export interface Messaggio { role: string; content: string }

export function detectProjectPath(
  messages: Messaggio[],
  fs: FsProbe = REAL_FS,
  home: string = homedir(),
): string | null {
  // Primo giro, su TUTTO il testo: una cartella che esiste davvero.
  for (const c of candidatesIn(messages.map(m => m.content).join("\n"), home)) {
    if (fs.esiste(c) && fs.eCartella(c)) return c;
  }

  // Ripiego, solo sui messaggi dell'UTENTE: la cartella che sta per nascere.
  // «Creami un progetto in ~/progetti/nuovo» va legato prima che esista.
  const textUser = messages.filter(m => m.role === "user").map(m => m.content).join("\n");
  for (const c of candidatesIn(textUser, home)) {
    // Se esiste, il primo giro l'ha già giudicato: non esiste modo che sia una
    // cartella (l'avrebbe restituita) e rioffrirlo qui e' contraddirsi.
    if (fs.esiste(c)) continue;
    // E il posto che la conterrà deve esserci: senza, un path inventato a metà
    // frase diventa un progetto che non nascerà mai.
    if (!fs.eCartella(dirname(c))) continue;
    return c;
  }
  return null;
}
