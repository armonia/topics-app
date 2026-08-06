/**
 * Il testo che la CLI INIETTA in un evento `type:"user"`.
 *
 * Quando il modello chiama il tool `Skill`, la CLI manda PRIMA il `tool_result`
 * («Launching skill: <nome>») e SUBITO DOPO un secondo evento `user`, marcato
 * `isSynthetic: true`, con un blocco `text` che contiene il corpo della skill.
 * Quel testo non è una risposta del modello: sono le istruzioni che gli vengono
 * messe in mano. Inoltrarlo come testo assistant lo incollava dentro la
 * risposta a schermo — nel turno reale il prompt di `/recap` compariva prima
 * della risposta, senza nemmeno uno spazio in mezzo.
 *
 * Le due forme di skill mandano DUE payload diversi, registrati sul wire:
 *
 *   skill a cartella (`.claude/skills/<n>/SKILL.md`)
 *     "Base directory for this skill: /…/skills/zzprobe\n\n<corpo>"
 *   comando (`.claude/commands/<n>.md`) — ed è la forma di `/recap`
 *     "<corpo>"                                   ← nessun prefisso
 *
 * Per questo il riconoscimento NON può appendersi al prefisso: la correlazione
 * vera è posizionale (`isSynthetic` subito dopo il `tool_result` di una Skill),
 * e il prefisso, quando c'è, è solo un metadato da staccare.
 */

/** Il prefisso che la CLI antepone al corpo delle skill a cartella. */
const BASE_DIR_RE = /^Base directory for this skill:[ \t]*([^\n]*)\r?\n\r?\n([\s\S]*)$/;

/**
 * Il corpo della skill, ripulito dall'intestazione tecnica se ce l'ha.
 *
 * Torna `null` quando non resta niente da mostrare: una card che apre su un
 * riquadro vuoto è peggio di una card che non apre.
 */
export function skillBodyFromInjectedText(text: string): { baseDir?: string; body: string } | null {
  const m = BASE_DIR_RE.exec(text);
  const body = (m ? m[2] : text).trim();
  if (!body) return null;
  const baseDir = m ? m[1].trim() : "";
  return baseDir ? { baseDir, body } : { body };
}
