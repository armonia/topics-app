/**
 * Rigenera il titolo delle card in review che ce l'hanno ancora mozzato.
 *
 * PERCHÉ UNO SCRIPT E NON UNA MIGRATION. Il titolo lo deve scrivere un modello,
 * non uno `UPDATE`: una migration può spostare dati, non capire che «potremmo
 * fare una roba figa» è il preambolo e «omologare la cronologia delle tab» è il
 * punto. E perché è un'operazione da fare UNA volta su quello che c'era già:
 * dalle card nuove ci pensa il server da solo, alla nascita
 * (`routes/tasks.ts`, la `create`).
 *
 * Usa `titoloMigliore` — la STESSA funzione del server, non una copia — quindi
 * le guardie sono quelle: un titolo corto non si tocca, una risposta storta si
 * scarta, senza modello non succede niente.
 *
 *     bun run scripts/retitle-review-cards.ts            # mostra e basta
 *     bun run scripts/retitle-review-cards.ts --scrivi   # applica
 */
import { Database } from "bun:sqlite";
import { titoloMigliore } from "../server/services/task-title";
import { registerProvider, tryGetProvider } from "../server/providers";

const WRITE = process.argv.includes("--scrivi");

const db = new Database("data/topics.db");
const righe = db.query(
  `SELECT id, text, description FROM tasks
    WHERE archived = 0 AND status = 'review' AND (text LIKE '%…' OR text LIKE '%...')`,
).all() as Array<{ id: string; text: string; description: string | null }>;

if (!righe.length) {
  console.log("Nessuna card in review col titolo mozzato.");
  process.exit(0);
}

registerProvider({ type: "native" } as never);
const prov = tryGetProvider("topics");
if (!prov) {
  console.error("Nessun provider disponibile: senza modello non c'è titolo da ricavare.");
  process.exit(1);
}

console.log(`${righe.length} card da guardare${WRITE ? "" : "  (prova: niente viene scritto)"}\n`);
for (const r of righe) {
  const migliore = await titoloMigliore(prov, { text: r.text, description: r.description });
  if (!migliore) {
    console.log(`${r.id.slice(0, 8)}  nessun titolo migliore — lasciata com'era`);
    continue;
  }
  console.log(`${r.id.slice(0, 8)}`);
  console.log(`   prima: ${r.text}`);
  console.log(`   dopo : ${migliore}`);
  if (WRITE) {
    db.run("UPDATE tasks SET text = ?, updated_at = ? WHERE id = ?", [migliore, new Date().toISOString(), r.id]);
  }
}
if (!WRITE) console.log("\nNiente scritto. Ripeti con --scrivi per applicare.");
db.close();
