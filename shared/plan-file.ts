/**
 * Il file dove finisce un piano quando la CLI non ha modo di consegnarlo.
 *
 * In `--permission-mode plan` la CLI 2.1.223 NON espone `ExitPlanMode`
 * (verificato sul wire: 29 tool disponibili, quello non c'è). Il modello quindi
 * non ha un canale per far vedere il piano e ripiega sull'unica cosa che gli
 * resta: scriverlo in `~/.claude/plans/<slug>.md`. Riconoscere quel percorso è
 * ciò che permette di renderlo come PIANO invece che come una riga `Write`
 * verso una cartella che nessuno apre.
 *
 * Il riconoscimento è sul percorso e non sul contenuto perché quella cartella
 * è dedicata: ci scrive la CLI e nient'altro. Sta in `shared/` perché serve al
 * normalizzatore del server e al suo specchio nel client, che devono dire la
 * stessa cosa.
 */

/** `…/.claude/plans/qualcosa.md` — con qualunque separatore e qualunque home. */
const PLAN_FILE_RE = /(^|[/\\])\.claude[/\\]plans[/\\][^/\\]+\.md$/i;

export function isPlanFile(filePath: string): boolean {
  return typeof filePath === 'string' && PLAN_FILE_RE.test(filePath.trim());
}
