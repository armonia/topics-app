/**
 * Pezzi di schema che PIÙ harness di test devono creare a mano.
 *
 * Gli harness della board costruiscono un DB in memoria con una DDL scritta a
 * mano — una copia per file, una decina di copie in tutto. Finché ogni tabella
 * la toccava un test solo, la duplicazione costava poco. `task_labels`
 * (migration 097) no: `rowToTask` la legge per OGNI riga, quindi la sua assenza
 * non fa fallire il test delle etichette — fa fallire ogni test che legga un
 * task, in ogni harness, con un `no such table` a 500. La prima volta sono state
 * 194 asserzioni rosse in dieci file.
 *
 * Quindi questa tabella si dichiara QUI, una volta, e gli harness la importano.
 * La copia canonica resta la migration: questa deve restarle identica, e il test
 * accanto (`test-schema.test.ts`) lo verifica leggendo il file `.sql`.
 */

/** `task_labels` — identica alla 097, meno i commenti. */
export const TASK_LABELS_DDL = `CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('derived', 'human', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, label)
)`;
