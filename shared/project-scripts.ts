/**
 * Uno script rilevato in un progetto — la forma che attraversa il filo.
 *
 * Sta qui e non su un lato perché lo stesso oggetto lo produce il server
 * (`server/lib/project-scripts.ts`, leggendo i manifest) e lo consuma il client
 * (`ScriptRunner`, che disegna le righe e lancia). Dichiararlo due volte è la
 * cosa che `tests/unit/no-type-mirrors.test.ts` impedisce, e per una ragione
 * misurata: i commenti "KEEP IN SYNC" non hanno mai tenuto in sync niente.
 *
 * `id` è `<manifest>#<nome>` ed è la chiave con cui si lancia. Il nome da solo
 * non basta: lo stesso nome può stare in due manifest — `test` in
 * `package.json` e `test` nel Makefile sono due comandi diversi — e con la sola
 * chiave `nome` uno dei due sarebbe irraggiungibile.
 */
export interface DetectedScript {
  /** Unico: `<manifest>#<nome>`. È la chiave con cui si lancia. */
  id: string;
  /** Come si legge nella lista. */
  name: string;
  /** Cosa fa, per il tooltip: il comando dichiarato nel manifest. */
  detail: string;
  /** Cosa si esegue davvero. */
  argv: string[];
  /** Da quale file viene: `package.json`, `Makefile`, `Cargo.toml`… */
  from: string;
}
