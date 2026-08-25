/**
 * I permessi del runtime nativo.
 *
 * Perché contano più qui che altrove: il runtime nativo esegue i tool DA SÉ.
 * Con una CLI in mezzo c'era un secondo programma che applicava le sue regole
 * anche quando le nostre erano incomplete; qui non c'è nessuno dopo di noi.
 *
 * Quello che questi test NON provano, detto per non illudersi: che un agente
 * ostile sia contenuto. Non lo è, e non può esserlo — un comando shell esce da
 * qualunque perimetro. Provano che l'ERRORE si ferma, che è la cosa che succede
 * davvero: un `rm -rf` con il percorso sbagliato, un `reset --hard` su lavoro
 * non committato.
  * @covers RT-07
 */
import { describe, expect, test } from "bun:test";
import { decide, levelFor, DEFAULT_AUTONOMY } from "./permissions";

describe("il livello di autonomia", () => {
  test("il default NON è `yolo`", () => {
    // Le CLI partivano in bypass e Topics ne aveva ereditato il default; ma
    // quel default descriveva un programma altrui. Qui l'esecuzione è nostra.
    expect(DEFAULT_AUTONOMY).toBe("auto-apply");
  });

  test("un valore sconosciuto cade sul default, non su `yolo`", () => {
    expect(levelFor("banana")).toBe("auto-apply");
    expect(levelFor(null)).toBe("auto-apply");
    expect(levelFor(undefined)).toBe("auto-apply");
  });

  test("i tre livelli veri si riconoscono", () => {
    expect(levelFor("ask")).toBe("ask");
    expect(levelFor("auto-apply")).toBe("auto-apply");
    expect(levelFor("yolo")).toBe("yolo");
  });
});

describe("`ask`: propone e non tocca", () => {
  test("leggere e cercare si può sempre", () => {
    expect(decide("read_file", { path: "a.txt" }, "ask").allow).toBe(true);
    expect(decide("grep", { pattern: "x" }, "ask").allow).toBe(true);
    expect(decide("glob", { pattern: "*" }, "ask").allow).toBe(true);
  });

  test("scrivere ed eseguire no, con un motivo che l'agente può usare", () => {
    const w = decide("write_file", { path: "a.txt" }, "ask");
    expect(w.allow).toBe(false);
    // Il testo torna all'agente come risultato del tool: deve dirgli cosa fare
    // invece, o ritenterà uguale.
    expect(w.allow === false && w.reason).toContain("chiedi prima");

    expect(decide("edit_file", {}, "ask").allow).toBe(false);
    expect(decide("bash", { command: "ls" }, "ask").allow).toBe(false);
  });
});

describe("`auto-apply`: lavora, ma non fa danni irreversibili", () => {
  test("il lavoro normale passa", () => {
    expect(decide("write_file", { path: "a.txt" }, "auto-apply").allow).toBe(true);
    expect(decide("edit_file", {}, "auto-apply").allow).toBe(true);
    expect(decide("bash", { command: "bun test" }, "auto-apply").allow).toBe(true);
    expect(decide("bash", { command: "git commit -m x" }, "auto-apply").allow).toBe(true);
    expect(decide("bash", { command: "rm nota.txt" }, "auto-apply").allow).toBe(true);
  });

  // IL TEST CHE GIUSTIFICA IL FILE. Ognuna di queste righe è una cosa che non
  // si annulla, ed è l'unico criterio con cui la lista cresce.
  test("le operazioni che non si annullano vengono fermate", () => {
    const bloccati = [
      "rm -rf build",
      "rm -fr /tmp/x",
      "git reset --hard HEAD~3",
      "git clean -fd",
      "git push --force origin main",
      "git push -f",
      "git branch -D main",
      "chmod -R 777 .",
      "dd if=/dev/zero of=/dev/disk2",
    ];
    for (const cmd of bloccati) {
      const d = decide("bash", { command: cmd }, "auto-apply");
      expect(d.allow, `doveva essere bloccato: ${cmd}`).toBe(false);
      expect(d.allow === false && d.reason).toContain("non si annulla");
    }
  });

  test("il caso peggiore: rm sulla radice o sulla home", () => {
    expect(decide("bash", { command: "rm -rf /" }, "auto-apply").allow).toBe(false);
    expect(decide("bash", { command: "rm -rf ~" }, "auto-apply").allow).toBe(false);
    expect(decide("bash", { command: "rm -rf $HOME" }, "auto-apply").allow).toBe(false);
  });

  // La rete non deve essere così larga da rendere l'agente inutile: un
  // permesso che blocca il lavoro normale viene disattivato, e allora non
  // protegge più niente.
  test("i falsi positivi che renderebbero il livello inservibile", () => {
    const ok = [
      "git reset HEAD~1",          // senza --hard: si recupera
      "git push origin main",       // senza force
      "npm run format",
      "grep -rf pattern .",         // -rf, ma non è rm
      "echo 'rm -rf' >> note.md",   // lo NOMINA, non lo esegue... vedi sotto
    ];
    for (const cmd of ok.slice(0, 4)) {
      expect(decide("bash", { command: cmd }, "auto-apply").allow, `doveva passare: ${cmd}`).toBe(true);
    }
  });

  /**
   * Un limite VERO, scritto invece che nascosto: il filtro guarda il testo del
   * comando, quindi un `echo 'rm -rf /'` in un file viene bloccato pur essendo
   * innocuo. È il verso giusto in cui sbagliare (si nega qualcosa di innocuo
   * invece di permettere qualcosa di distruttivo) e chi ha davvero bisogno di
   * scrivere quella stringa usa `write_file`, che non passa da qui.
   */
  test("il filtro è sul TESTO: un falso positivo è possibile, e va saputo", () => {
    expect(decide("bash", { command: "echo 'rm -rf /' > note.md" }, "auto-apply").allow).toBe(false);
    // La via d'uscita esiste ed è ovvia.
    expect(decide("write_file", { path: "note.md", content: "rm -rf /" }, "auto-apply").allow).toBe(true);
  });
});

describe("`yolo`: chi lo sceglie sa cosa sta dicendo", () => {
  test("passa tutto, anche l'irreversibile", () => {
    expect(decide("bash", { command: "rm -rf build" }, "yolo").allow).toBe(true);
    expect(decide("bash", { command: "git reset --hard" }, "yolo").allow).toBe(true);
    expect(decide("write_file", {}, "yolo").allow).toBe(true);
  });
});
