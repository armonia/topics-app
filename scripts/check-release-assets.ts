#!/usr/bin/env bun
/**
 * I DODICI ASSET DI UNA RELEASE COMPLETA, e la domanda «questa si può pubblicare?».
 *
 * PERCHE' ESISTE. Il job `publish` di `tauri-release.yml` dipendeva da
 * `needs: [create-release, build]`, cioè dall'EXIT CODE dei tre job di build.
 * Il 2026-08-14 la tauri-v2.2.131 ha caricato tutti e dodici i suoi asset — dmg
 * universale, exe+msi+sig Windows, deb+rpm+sig Linux, app.tar.gz+sig,
 * latest.json — e poi il job Windows ha preso un `##[error]Server Error`
 * dall'API di GitHub **undici secondi dopo l'ultimo upload riuscito**.
 * tauri-action è uscito non-zero, `publish` è stato saltato, e una build
 * completa su tre sistemi operativi è rimasta in draft per sempre: nessun tag,
 * un buco nella catena delle versioni, e l'auto-updater fermo.
 *
 * L'exit code risponde a «il processo è finito bene», che NON è la domanda.
 * La domanda è «c'è tutto quello che serve a un utente per aggiornare», e a
 * quella risponde l'elenco degli asset sulla release.
 *
 * IL VERSO IN CUI SBAGLIARE, ed è il motivo per cui questo file conta gli asset
 * invece di limitarsi a `if: always()`. Il gate vecchio proteggeva da una cosa
 * vera: una release PARZIALE che va live è peggio di una mancata, perché
 * l'updater la serve a tutti e chi la scarica trova metà dei formati. Quindi
 * qui non si allenta niente: si cambia solo COSA si misura. Dodici su dodici
 * pubblica, undici su dodici no — e il nome di quello che manca finisce nel
 * log, perché «incompleta» senza dire cosa manca è una diagnosi che nessuno
 * può usare.
 */

/**
 * I dodici, come SUFFISSI e non come nomi interi: il nome porta dentro la
 * versione (`Topics_2.2.155_universal.dmg`), quindi confrontare nomi interi
 * vorrebbe dire ricostruire la stringa di versione qui — una seconda copia
 * della regola di naming di tauri, che è esattamente il genere di duplicato che
 * va in deriva al primo cambio di bundler.
 *
 * Il `.sig` di ogni bundle NON è un dettaglio: è la firma che l'updater
 * verifica prima di installare. Un asset senza la sua firma è un aggiornamento
 * che l'utente non può applicare, quindi conta come mancante.
 */
export const ASSET_SUFFIXES: readonly string[] = [
  // macOS: il dmg che si scarica a mano, e l'app.tar.gz(+sig) che usa l'updater.
  "_universal.dmg",
  "_universal.app.tar.gz",
  "_universal.app.tar.gz.sig",
  // Windows: setup exe e msi, ognuno con la sua firma.
  "_x64-setup.exe",
  "_x64-setup.exe.sig",
  "_x64_en-US.msi",
  "_x64_en-US.msi.sig",
  // Linux: deb e rpm, ognuno con la sua firma.
  "_amd64.deb",
  "_amd64.deb.sig",
  ".x86_64.rpm",
  ".x86_64.rpm.sig",
  // Il manifesto che l'updater legge per primo: senza, gli altri undici non
  // vengono mai chiesti da nessuno.
  "latest.json",
];

export type AssetVerdict =
  | { complete: true; found: number }
  | { complete: false; found: number; missing: string[] };

/**
 * Puro: prende i nomi degli asset presenti e dice se la release è pubblicabile.
 *
 * Puro e separato dalla chiamata di rete apposta — è la stessa forma di
 * `memoryTooTight` e `machineTooLoaded`: il caso che conta («manca un pezzo»)
 * si prova senza far fallire una release vera, che si potrebbe provare solo
 * aspettando il prossimo blip dell'API di GitHub.
 */
export function assetVerdict(names: readonly string[]): AssetVerdict {
  const missing = ASSET_SUFFIXES.filter((suffix) => !names.some((n) => n.endsWith(suffix)));
  const found = ASSET_SUFFIXES.length - missing.length;
  return missing.length === 0 ? { complete: true, found } : { complete: false, found, missing };
}

/**
 * `latest.json` a parte: e' l'unico che l'updater legge PER PRIMO, e una
 * release senza gli altri undici ma con lui manderebbe ogni client a chiedere
 * file che non ci sono. Serve a dare al log una diagnosi piu' precisa di
 * «mancano 11 asset».
 */
export function isUpdaterManifestMissing(names: readonly string[]): boolean {
  return !names.some((n) => n.endsWith("latest.json"));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Uso: bun run scripts/check-release-assets.ts <release-id>
// Esce 0 se la release e' completa (pubblicabile), 1 se le manca qualcosa, 2 se
// non si e' potuto misurare. Il 2 e' diverso dall'1 di proposito: «non lo so»
// non e' «no», ed e' chi chiama a decidere se un'API muta debba fermare una
// pubblicazione.
if (import.meta.main) {
  const id = process.argv[2];
  const repo = process.env.REPO;
  if (!id || !repo) {
    console.error("uso: REPO=owner/name bun run scripts/check-release-assets.ts <release-id>");
    process.exit(2);
  }
  const proc = Bun.spawnSync(["gh", "api", `repos/${repo}/releases/${id}`, "--jq", ".assets[].name"]);
  if (proc.exitCode !== 0) {
    console.error(`[assets] non misurabile: gh api e' uscito ${proc.exitCode}`);
    console.error(new TextDecoder().decode(proc.stderr));
    process.exit(2);
  }
  const names = new TextDecoder().decode(proc.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
  const v = assetVerdict(names);
  if (v.complete) {
    console.log(`[assets] ${v.found}/${ASSET_SUFFIXES.length} presenti: la release e' completa.`);
    process.exit(0);
  }
  console.error(`[assets] ${v.found}/${ASSET_SUFFIXES.length} presenti. MANCANO:`);
  for (const m of v.missing) console.error(`  - *${m}`);
  console.error(
    "\nUna release parziale non si pubblica: l'updater la servirebbe a tutti e\n" +
      "chi la scarica troverebbe meta' dei formati. Rilanciare il job di build del\n" +
      "sistema operativo che manca — gli asset gia' caricati restano.",
  );
  process.exit(1);
}
