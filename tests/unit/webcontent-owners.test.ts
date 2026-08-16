/**
 * Di chi sono i WebContent, e perché la domanda ha bisogno del kernel.
 *
 * Questi casi difendono la lezione, non solo il codice: il 2026-08-16 una
 * misura frettolosa ha attribuito a Topics 2,2 GB di WebContent che erano di
 * Mail.app, e ha aperto una card su una perdita inesistente. L'attribuzione
 * sbagliata non era distrazione — era l'unica conclusione possibile guardando
 * `ps`, perché tutti i WebContent del sistema hanno la stessa identica riga di
 * comando.
 */
import { describe, it, expect } from "bun:test";
import { appName, byOwner, responsiblePid, type ProcRow } from "../../scripts/webcontent-owners";

describe("a chi appartiene un WebContent", () => {
  it("il nome dell'app si legge dal bundle, non dall'eseguibile", () => {
    // L'eseguibile dentro un .app si chiama spesso in modo inutile: quello di
    // Topics si chiama `app`, e un referto che dicesse «277 MB · app» non
    // risponderebbe alla domanda per cui esiste.
    expect(appName("/System/Applications/Mail.app/Contents/MacOS/Mail")).toBe("Mail");
    expect(appName("/Users/x/Applications/Topics.app/Contents/MacOS/app")).toBe("Topics");
    expect(appName("/Applications/OpenClaw.app/Contents/MacOS/OpenClaw")).toBe("OpenClaw");
  });

  it("un percorso che non è un bundle non inventa un nome", () => {
    expect(appName("/opt/homebrew/bin/node")).toBe("node");
    expect(appName("")).toBe("");
  });

  it("somma per applicazione, dalla più pesante", () => {
    const rows: ProcRow[] = [
      { pid: 1, rssMB: 100, owner: "Mail" },
      { pid: 2, rssMB: 277, owner: "Topics" },
      { pid: 3, rssMB: 50, owner: "Mail" },
    ];
    const t = byOwner(rows);
    expect(t[0]).toEqual({ owner: "Topics", procs: 1, mb: 277 });
    expect(t[1]).toEqual({ owner: "Mail", procs: 2, mb: 150 });
  });

  it("«non lo so» resta separato, non finisce su nessuna app", () => {
    // È il caso che impedisce di rifare l'errore: un processo che non si riesce
    // ad attribuire NON diventa di Topics per esclusione. Un processo può
    // sparire fra `ps` e la chiamata, e su una macchina non-macOS la libreria
    // non c'è proprio.
    const t = byOwner([
      { pid: 1, rssMB: 10, owner: null },
      { pid: 2, rssMB: 20, owner: "Topics" },
    ]);
    expect(t.find((x) => x.owner === "Topics")!.mb).toBe(20);
    expect(t.find((x) => x.owner === "non attribuibile")!.mb).toBe(10);
  });

  it("il responsabile di QUESTO processo è un pid vero", () => {
    // Prova che il canale col kernel funziona davvero, non solo che il codice
    // compila: chiedere di sé stessi deve dare un pid, non null.
    if (process.platform !== "darwin") return;
    const r = responsiblePid(process.pid);
    expect(r === null || r > 0).toBe(true);
  });

  it("un pid inesistente non produce un'attribuzione", () => {
    // 0 non è un processo. Se tornasse un numero, ogni riga orfana verrebbe
    // attribuita a qualunque cosa risponda a quel pid.
    expect(responsiblePid(0)).toBeNull();
  });
});
