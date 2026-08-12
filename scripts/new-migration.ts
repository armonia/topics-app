#!/usr/bin/env bun
/**
 * scripts/new-migration.ts — crea una migration il cui numero NON può collidere.
 *
 * Il problema che chiude: con un contatore (`101-…`) il numero si sceglie alla
 * NASCITA della migration e si verifica all'ATTERRAGGIO, e in mezzo passano ore
 * in cui le altre card atterrano. Nella notte del 11-12/08 è successo TRE volte
 * (097, 100, 101): ogni volta il numero era libero quando l'agente ha scritto il
 * file e occupato quando l'ha consegnato. Con sei agenti in parallelo non è la
 * distrazione di qualcuno, è l'esito normale.
 *
 * La cura è togliere di mezzo la risorsa condivisa: il prefisso è un TIMESTAMP
 * UTC `YYYYMMDDHHMMSS`, non un contatore. Due agenti non si contendono niente,
 * perché nessuno dei due deve guardare cosa hanno preso gli altri.
 *
 *   bun run migration:new notification-log
 *   → server/db/migrations/20260812050317-notification-log.sql
 *
 * PERCHÉ SOLE CIFRE e non `20260812T0500-`: ogni lettore delle migration filtra
 * con `/^\d+-.+\.sql$/` e ordina con `parseInt` (server/db.ts, il manifest, il
 * cancello). Con le sole cifre continuano tutti a funzionare senza toccarli, e
 * `20260812050317` > `101` quindi l'ordine legacy → nuove è giusto per
 * costruzione. Con una lettera in mezzo, un lettore che non avessimo trovato
 * avrebbe SALTATO la migration in silenzio: esattamente il guasto della 089.
 *
 * UTC e non ora locale: il prefisso è un ordinamento globale fra macchine, e due
 * agenti in due fusi diversi devono ordinarsi fra loro, non ciascuno con sé.
 *
 * I secondi ci sono perché una dispatch wave avvia sei agenti insieme: allo
 * stesso MINUTO ci si arriva davvero, allo stesso secondo no. E se ci si
 * arrivasse, `check:migrations` lo vede e il runner applica comunque entrambe in
 * ordine deterministico (server/db.ts).
 *
 * Le migration già numerate NON si toccano: sono applicate sui database vivi e
 * rinominarle le farebbe rieseguire. Le due ere convivono, ordinate dal numero.
 */
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

/** Il prefisso delle migration nuove: 14 cifre, `YYYYMMDDHHMMSS`. */
export const STAMP_FILE = /^(\d{14})-.+\.sql$/;

/** `notification-log` sì; `Notification Log`, `--x`, `log_` no. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `YYYYMMDDHHMMSS` in UTC. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Il primo stamp libero da `date` in avanti, un secondo per volta.
 *
 * Serve solo al caso locale (due `migration:new` nello stesso secondo dalla
 * stessa macchina): fra worktree diversi nessuno può guardare i file degli
 * altri, ed è il punto — la garanzia lì è la granularità al secondo, non un
 * lock.
 */
export function freeStamp(existing: string[], date: Date): string {
  const presi = new Set(existing.map(f => f.match(STAMP_FILE)?.[1]).filter(Boolean));
  const t = new Date(date.getTime());
  let stamp = stampOf(t);
  while (presi.has(stamp)) {
    t.setUTCSeconds(t.getUTCSeconds() + 1);
    stamp = stampOf(t);
  }
  return stamp;
}

/** L'intestazione del file nuovo: la migration è vuota, la prosa no. */
export function template(stamp: string, slug: string): string {
  return (
    `-- ${stamp}-${slug}.sql\n` +
    `--\n` +
    `-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello\n` +
    `-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.\n` +
    `--\n` +
    `-- Scrivi qui SOTTO cosa cambia e perché. Poi:\n` +
    `--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)\n` +
    `--   bun run check:migrations\n` +
    `\n`
  );
}

if (import.meta.main) {
  const slug = process.argv[2]?.trim();
  if (!slug || !SLUG.test(slug)) {
    console.error(
      `Uso: bun run migration:new <slug-in-kebab-case>\n` +
        `  es. bun run migration:new notification-log\n` +
        (slug ? `\n"${slug}" non è un slug: solo minuscole, cifre e trattini singoli.` : ""),
    );
    process.exit(1);
  }

  const repoRoot = join(import.meta.dir, "..");
  const dir = join(repoRoot, "server", "db", "migrations");
  if (!existsSync(dir)) {
    console.error(`✘ cartella migration assente: ${dir}`);
    process.exit(1);
  }

  const stamp = freeStamp(readdirSync(dir), new Date());
  const name = `${stamp}-${slug}.sql`;
  const path = join(dir, name);
  if (existsSync(path)) {
    console.error(`✘ esiste già: ${path}`);
    process.exit(1);
  }
  writeFileSync(path, template(stamp, slug));

  // Il manifest embedded deve elencare anche questa, o il binario compilato
  // parte con uno schema vecchio (CONTRIBUTING, "DB migrations"). Rigenerarlo
  // qui è ciò che rende il passo impossibile da dimenticare.
  const gen = Bun.spawnSync(["bun", "run", join(repoRoot, "scripts", "gen-migrations-manifest.ts")], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (gen.exitCode !== 0) {
    console.error(`✘ manifest non rigenerato: lancia \`bun run scripts/gen-migrations-manifest.ts\``);
    process.exit(1);
  }

  console.log(`✓ server/db/migrations/${name}`);
}
