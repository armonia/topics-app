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
 */

import { describe, expect, it } from "bun:test";
import {
  closeBackgroundShell,
  listBackgroundShells,
  noteBackgroundShellOutput,
  registerBackgroundShell,
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
