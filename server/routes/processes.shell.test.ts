/**
 * Il registro delle shell in background (3.5).
 *
 * Quello che questi test difendono non è il formato di una riga: è che una
 * shell lasciata dall'agente resti UNA cosa sola nel pannello — non sparisca
 * quando l'agente la ri-annuncia, non resti «running» dopo essere morta, e non
 * dichiari «conclusa» qualcosa che è uscito con un errore.
 *
 * Ogni caso usa una sessionKey sua: il registro è un singleton di processo, e
 * due test che si contendono la stessa chiave si romperebbero a vicenda.
 * @covers BGSHELL-02
 */

import { describe, expect, it } from "bun:test";
import { shellProcessKey } from "../../shared/background-shell-registry";
import {
  closeBackgroundShell,
  listBackgroundShells,
  noteBackgroundShellOutput,
  registerBackgroundShell,
  getScriptsSnapshot,
} from "./processes";

let n = 0;
function freshSession(): string {
  return `test-shell-session-${++n}`;
}

function shellOf(sessionKey: string, shellId: string) {
  return listBackgroundShells().find(s => s.sessionKey === sessionKey && s.shellId === shellId);
}

describe("registro delle shell in background", () => {
  it("registra una shell come processo vivo, con l'etichetta accorciata", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey,
      topicId: "topic-1",
      shellId: "bash_1",
      command: "bun run dev:server",
      cwd: "/tmp/proj",
      ownerPid: 4242,
    });

    const sh = shellOf(sessionKey, "bash_1");
    expect(sh?.status).toBe("running");
    expect(sh?.command).toBe("bun run dev:server");
    expect(sh?.topicId).toBe("topic-1");
    // Nessun pid finché non lo si trova nell'albero: una voce senza pid vale
    // comunque più di nessuna voce.
    expect(sh?.pid).toBe(null);
  });

  it("ri-registrare la stessa shell non ne azzera l'output", () => {
    const sessionKey = freshSession();
    const base = { sessionKey, topicId: null, shellId: "bash_2", command: "tail -f log", cwd: "/tmp" };
    registerBackgroundShell({ ...base, ownerPid: 100 });
    noteBackgroundShellOutput(sessionKey, "bash_2", { output: "riga importante" });

    registerBackgroundShell({ ...base, ownerPid: 200 });

    const sh = shellOf(sessionKey, "bash_2");
    expect(sh?.output.join("\n")).toContain("riga importante");
    expect(sh?.status).toBe("running");
  });

  it("accoda l'output di un BashOutput senza chiudere la shell", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_3",
      command: "vite build --watch", cwd: "/tmp", ownerPid: 1,
    });
    noteBackgroundShellOutput(sessionKey, "bash_3", { output: "built in 200ms", status: "running" });

    const sh = shellOf(sessionKey, "bash_3");
    expect(sh?.status).toBe("running");
    expect(sh?.output.join("\n")).toContain("built in 200ms");
  });

  it("uno stato terminale la sposta fra i conclusi con il suo exit code", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_4",
      command: "bun test", cwd: "/tmp", ownerPid: 1,
    });
    noteBackgroundShellOutput(sessionKey, "bash_4", { output: "ok", status: "completed", exitCode: 0 });

    const sh = shellOf(sessionKey, "bash_4");
    expect(sh?.status).toBe("done");
    expect(sh?.exitCode).toBe(0);
  });

  it("un fallimento resta un fallimento, non una conclusione", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_5",
      command: "bun run build", cwd: "/tmp", ownerPid: 1,
    });
    noteBackgroundShellOutput(sessionKey, "bash_5", { status: "failed", exitCode: 2 });

    const sh = shellOf(sessionKey, "bash_5");
    expect(sh?.status).toBe("error");
    expect(sh?.exitCode).toBe(2);
  });

  it("KillShell la chiude come terminata", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_6",
      command: "sleep 9999", cwd: "/tmp", ownerPid: 1,
    });
    closeBackgroundShell(sessionKey, "bash_6", "killed");

    const sh = shellOf(sessionKey, "bash_6");
    expect(sh?.status).toBe("error");
    expect(sh?.output.join("\n")).toContain("terminata");
  });

  it("chiudere due volte non riscrive l'esito già registrato", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_7",
      command: "bun x serve", cwd: "/tmp", ownerPid: 1,
    });
    closeBackgroundShell(sessionKey, "bash_7", "completed", 0);
    closeBackgroundShell(sessionKey, "bash_7", "killed");

    const sh = shellOf(sessionKey, "bash_7");
    expect(sh?.status).toBe("done");
    expect(sh?.exitCode).toBe(0);
  });

  it("un id sconosciuto non inventa una shell", () => {
    const sessionKey = freshSession();
    noteBackgroundShellOutput(sessionKey, "bash_mai_visto", { output: "boh" });
    closeBackgroundShell(sessionKey, "bash_mai_visto", "completed");

    expect(shellOf(sessionKey, "bash_mai_visto")).toBeUndefined();
  });
});

/**
 * Lo snapshot che viaggia sulla WS è ciò che arriva PER PRIMO quando una shell
 * nasce o cambia stato: la risposta HTTP arriva al prossimo poll, cioè fino a
 * 15s dopo. La card della chat cerca la sua shell per chiave, quindi se la
 * chiave manca dallo snapshot la card resta ferma proprio nel momento in cui
 * c'era qualcosa da mostrare — e nessun test lo vedrebbe, perché l'HTTP la
 * chiave ce l'ha sempre avuta.
 */
describe("snapshot broadcast delle shell", () => {
  it("porta la chiave del processo, lo shellId e la topic", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: "topic-broadcast", shellId: "bash_ws",
      command: "bun run dev", cwd: "/tmp/proj", ownerPid: 7,
    });

    const row = getScriptsSnapshot().find((s: any) => s.processId === shellProcessKey(sessionKey, "bash_ws"));
    expect(row).toBeDefined();
    expect(row.shellId).toBe("bash_ws");
    expect(row.topicId).toBe("topic-broadcast");
    expect(row.source).toBe("shell");
    expect(row.status).toBe("running");
  });

  it("una shell finita resta nello snapshot con il suo esito", () => {
    const sessionKey = freshSession();
    registerBackgroundShell({
      sessionKey, topicId: null, shellId: "bash_ws2",
      command: "bun test", cwd: "/tmp/proj", ownerPid: 8,
    });
    noteBackgroundShellOutput(sessionKey, "bash_ws2", { status: "completed", exitCode: 0 });

    const row = getScriptsSnapshot().find((s: any) => s.processId === shellProcessKey(sessionKey, "bash_ws2"));
    expect(row?.shellId).toBe("bash_ws2");
    expect(row?.status).toBe("done");
    expect(row?.exitCode).toBe(0);
  });

  it("un processo che non è una shell non si porta dietro uno shellId", () => {
    const rows = getScriptsSnapshot().filter((s: any) => s.source !== "shell");
    for (const r of rows) expect(r.shellId).toBeUndefined();
  });
});
