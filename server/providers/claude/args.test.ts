/**
 * L'argv delle CLI come CONTRATTO.
 *
 * Questi non sono test di logica: sono fotografie. Il valore sta tutto nel
 * fatto che, se qualcuno tocca una flag, il rosso arriva QUI e non in
 * produzione al primo turno — che è com'è andata finora, visto che nessun test
 * del repo nominava `--include-partial-messages` o `--setting-sources`.
 *
 * Quando un cambio è voluto si aggiorna la fotografia, e il diff del commit
 * mostra esattamente cosa si è deciso di cambiare. Quando non lo è, il rosso è
 * la domanda giusta al momento giusto.
 */
import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, buildClaudeOneshotArgs, resolveToolTrim, TRIMMED_TOOLS_CHAT, TRIMMED_TOOLS_DISPATCHED } from "./args";
import { buildCodexArgs, buildCodexOneshotArgs } from "../codex/args";

const BASE = {
  permissionMode: "acceptEdits",
  model: "claude-opus-5[1m]",
  mcpConfigPath: "/tmp/topics-mcp/topic-7.json",
  mcpStrict: true,
  permissionPromptTool: "mcp__topics__approval_prompt",
  appendSystemPrompt: "<prompt di sistema>",
  claudeSessionId: "11111111-2222-3333-4444-555555555555",
  isNewSession: true,
} as const;

describe("buildClaudeArgs — il deferral degli schemi MCP", () => {
  // Non è una preferenza: è la voce più grossa del prefisso. Con la flotta
  // reale (161 tool) il prefisso passa da 127.073 a 36.167 token — e il
  // prefisso lo ripaga OGNI richiesta del turno. Se qualcuno toglie questa
  // flag, ogni chat torna a pagare 90.906 token per richiesta in silenzio.
  test("`--settings` porta ENABLE_TOOL_SEARCH, e viene PRIMA del prompt di sistema", () => {
    const args = buildClaudeArgs({ ...BASE, toolSearch: "1" });
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1])).toEqual({ env: { ENABLE_TOOL_SEARCH: "1" } });
    expect(i).toBeLessThan(args.indexOf("--append-system-prompt"));
  });

  test("va su `--settings` e NON sull'ambiente: `--setting-sources user` farebbe vincere il file dell'utente", () => {
    // Misurato: con `ENABLE_TOOL_SEARCH=1` nell'ambiente di processo il
    // prefisso resta byte-identico (cache_read pieno). L'unico canale che
    // scavalca `~/.claude/settings.json` è questa flag.
    const args = buildClaudeArgs({ ...BASE, toolSearch: "1" });
    expect(args).toContain("--setting-sources");
    expect(args.join(" ")).toContain('"ENABLE_TOOL_SEARCH":"1"');
  });

  test("null non emette la flag: la CLI resta ai suoi settings", () => {
    expect(buildClaudeArgs({ ...BASE, toolSearch: null })).not.toContain("--settings");
  });
});

describe("buildClaudeArgs — il cancello sulle immagini nel contesto", () => {
  // La voce di spesa piu' grossa misurata il 10/08 sugli agenti dispacciati: il
  // 95% del volume dei transcript sono tool_result, il 97% di quelli e' Read, e
  // i Read grossi sono SCREENSHOT (~132 kB l'uno). 7 task su 12, il 25% del
  // volume totale. Il prompt lo vietava gia' (per il browser) e non e' bastato.
  function guard(opts: Record<string, unknown>) {
    const args = buildClaudeArgs({ ...BASE, ...opts } as never);
    const i = args.indexOf("--settings");
    return i < 0 ? null : JSON.parse(args[i + 1]!);
  }

  test("acceso: hook PreToolUse su Read, e il deferral NON viene perso", () => {
    const s = guard({ toolSearch: "1", blockImageReads: true });
    expect(s.hooks.PreToolUse[0].matcher).toBe("Read");
    // Un solo `--settings` (la CLI prende l'ultimo): il deferral vale -71,5% di
    // prefisso, perderlo per il cancello sarebbe uno scambio in perdita.
    expect(s.env.ENABLE_TOOL_SEARCH).toBe("1");
    expect(buildClaudeArgs({ ...BASE, toolSearch: "1", blockImageReads: true })
      .filter((a) => a === "--settings").length).toBe(1);
  });

  test("spento per le chat: nessun hook quando non e' un agente del board", () => {
    // Una persona in chat puo' volere aprire un'immagine; un agente che consegna
    // una prova di review no, gli basta il path.
    expect(guard({ toolSearch: "1", blockImageReads: false })?.hooks).toBeUndefined();
  });

  test("il comando dell'hook rifiuta le immagini e lascia passare il codice", async () => {
    // Un cancello che non ha mai detto di no non e' un cancello: qui si esegue
    // davvero, con l'argv vero.
    const cmd = guard({ blockImageReads: true }).hooks.PreToolUse[0].hooks[0].command;
    const run = async (path: string) => {
      const p = Bun.spawn(["sh", "-c", cmd], { stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { file_path: path } })), stdout: "pipe", stderr: "pipe" });
      return await p.exited;
    };
    expect(await run("/x/shot.png")).toBe(2);
    expect(await run("/x/clip.webm")).toBe(2);
    expect(await run("/x/server.ts")).toBe(0);
    expect(await run("")).toBe(0);
    expect(buildClaudeArgs({ ...BASE })).not.toContain("--settings");
  });
});

describe("buildClaudeArgs — gli schemi dei tool che il differimento non tocca", () => {
  // Decomposto per ablazione appaiata il 11/08/2026 (CLI 2.1.227, HOME reale,
  // rumore di fondo 0-4 token): dei 34.845 token di prefisso su opus-5[1m],
  // `Workflow` da solo ne vale 7.856 — il 22,5%, più di CLAUDE.md e del
  // catalogo skill messi insieme — ed è un tool che la sua stessa descrizione
  // vieta senza un consenso umano esplicito, che a un agente dispacciato non
  // arriva. I quattro insieme: −13.176 a ogni richiesta.
  test("dispacciato: UN argomento a virgole, non un variadico", () => {
    const args = buildClaudeArgs({ ...BASE, toolTrim: "dispatched" } as never);
    const i = args.indexOf("--disallowed-tools");
    expect(i).toBeGreaterThan(-1);
    // Il valore è UNA stringa sola. `--disallowed-tools A B C` è variadico e in
    // mezzo all'argv si mangerebbe la flag successiva.
    expect(args[i + 1]).toBe("Workflow,Artifact,ReportFindings,ListAgents");
    expect(args[i + 2]).toStartWith("--");
  });

  test("chat: le tre voci irraggiungibili, e `Workflow` NO", () => {
    // Il criterio è lo stesso dei bracci del board — «questa sessione non lo
    // può usare comunque» — ma su `Workflow` dà l'esito opposto: la sua
    // descrizione lo vieta senza un consenso esplicito dell'umano, e in una
    // chat l'umano c'è. Toglierlo non risparmierebbe, toglierebbe una leva.
    const args = buildClaudeArgs({ ...BASE, toolTrim: "chat" } as never);
    const i = args.indexOf("--disallowed-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("Artifact,ReportFindings,ListAgents");
    expect(args[i + 1]).not.toContain("Workflow");
    expect(args[i + 2]).toStartWith("--");
  });

  test("i nomi sono esportati: il banco confronta il registro dei bracci con QUESTE liste", () => {
    // Se qualcuno aggiunge un nome qui senza che il banco lo sappia, il
    // cancello «stesso registro nei due bracci» diventa rosso — che è il modo
    // giusto di accorgersene.
    expect([...TRIMMED_TOOLS_CHAT]).toEqual(["Artifact", "ReportFindings", "ListAgents"]);
    expect([...TRIMMED_TOOLS_DISPATCHED]).toEqual(["Workflow", "Artifact", "ReportFindings", "ListAgents"]);
    // La chat è un SOTTOINSIEME PROPRIO: due liste che divergessero su altro
    // sarebbero due criteri, non due livelli dello stesso criterio.
    for (const t of TRIMMED_TOOLS_CHAT) expect(TRIMMED_TOOLS_DISPATCHED).toContain(t);
    expect(TRIMMED_TOOLS_CHAT).not.toContain("Workflow" as never);
  });

  test("spento: nessuna deny, il registro resta intero", () => {
    expect(buildClaudeArgs({ ...BASE })).not.toContain("--disallowed-tools");
    expect(buildClaudeArgs({ ...BASE, toolTrim: null } as never)).not.toContain("--disallowed-tools");
  });

  test("chi decide il taglio: dispacciato → quattro, chat → tre, `off` → nessuno", () => {
    // La scelta stava inline nello spawn, dentro un metodo privato che prende
    // solo un `sessionKey`: il braccio «dispacciato» si poteva controllare
    // guardando l'argv di un agente vivo, quello della CHAT solo se una chat
    // stava girando in quel momento. Provato per venti minuti, non ne è partita
    // nessuna. Qui la decisione è raggiungibile, quindi verificata.
    expect(resolveToolTrim({ dispatched: true, env: {} })).toBe("dispatched");
    expect(resolveToolTrim({ dispatched: false, env: {} })).toBe("chat");
    // La via d'uscita vale per tutti e due i bracci: un cancello che spegne solo
    // meta' dei casi e' peggio di nessun cancello, perche' sembra spento.
    expect(resolveToolTrim({ dispatched: true, env: { TOPICS_TOOL_TRIM: "off" } })).toBeNull();
    expect(resolveToolTrim({ dispatched: false, env: { TOPICS_TOOL_TRIM: "off" } })).toBeNull();
    // Un valore qualsiasi NON spegne: solo la parola `off`.
    expect(resolveToolTrim({ dispatched: false, env: { TOPICS_TOOL_TRIM: "0" } })).toBe("chat");
  });

  test("dalla decisione all'argv, senza anelli scoperti: una chat vede tre nomi", () => {
    // L'assertion che chiude il giro: la stessa funzione che lo spawn chiama,
    // infilata nella stessa funzione che costruisce l'argv.
    const chat = buildClaudeArgs({ ...BASE, toolTrim: resolveToolTrim({ dispatched: false, env: {} }) } as never);
    expect(chat[chat.indexOf("--disallowed-tools") + 1]).toBe("Artifact,ReportFindings,ListAgents");
    const agente = buildClaudeArgs({ ...BASE, toolTrim: resolveToolTrim({ dispatched: true, env: {} }) } as never);
    expect(agente[agente.indexOf("--disallowed-tools") + 1]).toBe("Workflow,Artifact,ReportFindings,ListAgents");
    const spento = buildClaudeArgs({ ...BASE, toolTrim: resolveToolTrim({ dispatched: true, env: { TOPICS_TOOL_TRIM: "off" } }) } as never);
    expect(spento).not.toContain("--disallowed-tools");
  });

  test("`Task` e `Read` NON sono in nessuna delle due liste: sono ciò che rende capace l'agente", () => {
    // Il criterio del taglio non è «pesa tanto» — `Task` vale quanto
    // `Artifact` — è «l'agente non lo può usare comunque». Un agente del board
    // i sotto-agenti li usa per le ricerche larghe.
    for (const lista of [TRIMMED_TOOLS_CHAT, TRIMMED_TOOLS_DISPATCHED]) {
      expect(lista).not.toContain("Task" as never);
      expect(lista).not.toContain("Read" as never);
    }
  });
});

describe("buildClaudeArgs — il catalogo delle skill fuori dal prefisso", () => {
  // Misurato il 10/08/2026 con l'argv del dispatch vero (CLI 2.1.226, opus,
  // stessa cwd e stesso config MCP): l'elenco delle skill dell'utente pesa
  // 14.067 byte e vale 4.210 token di PREFISSO — che un task da ~40 turni
  // ripaga ogni volta, per una lista che l'agente non usa.
  function settings(opts: Record<string, unknown>) {
    const args = buildClaudeArgs({ ...BASE, ...opts } as never);
    const i = args.indexOf("--settings");
    return i < 0 ? null : JSON.parse(args[i + 1]!);
  }

  test("acceso: soli NOMI nell'elenco, e il deferral resta nello STESSO `--settings`", () => {
    const s = settings({ toolSearch: "1", slimSkillListing: true });
    expect(s.skillListingMaxDescChars).toBe(1);
    // La CLI prende l'ULTIMO `--settings`: un secondo flag farebbe sparire in
    // silenzio il deferral degli schemi (-71,5% di prefisso).
    expect(buildClaudeArgs({ ...BASE, toolSearch: "1", slimSkillListing: true })
      .filter((a) => a === "--settings").length).toBe(1);
    expect(s.env.ENABLE_TOOL_SEARCH).toBe("1");
  });

  test("1 e non 0: lo zero la CLI lo ignora e l'elenco resta intero", () => {
    // Misurato: `skillListingMaxDescChars: 0` lascia l'attachment `skill_listing`
    // identico al default (9.096 B), `1` lo porta a 2.130.
    expect(settings({ slimSkillListing: true })!.skillListingMaxDescChars).toBe(1);
  });

  test("da sola accende `--settings`: non dipende dal deferral", () => {
    const s = settings({ slimSkillListing: true });
    expect(s).toEqual({ skillListingMaxDescChars: 1 });
  });

  test("spento per le chat: una persona le skill le sceglie leggendo cosa fanno", () => {
    expect(settings({ toolSearch: "1", slimSkillListing: false })).toEqual({ env: { ENABLE_TOOL_SEARCH: "1" } });
    expect(buildClaudeArgs({ ...BASE })).not.toContain("--settings");
  });

  test("il tetto ai risultati MCP viaggia nello STESSO `--settings`, accanto al deferral", () => {
    // Default della CLI: 25.000 token (~100 kB) per singolo risultato — una
    // soglia che nella pratica non scatta mai. Misurato sui 15.464 risultati
    // MCP dei transcript reali: a 4.000 il volume cala del 73,6% e finisce su
    // file una chiamata su undici (a 25.000 il taglio è −27,8%).
    const s = settings({ toolSearch: "1", mcpOutputTokens: 4000 });
    expect(s.env).toEqual({ ENABLE_TOOL_SEARCH: "1", MAX_MCP_OUTPUT_TOKENS: "4000" });
    // Un solo `--settings`: la CLI prende l'ultimo, e perdere il deferral
    // (−71,5% di prefisso) per il tetto sarebbe uno scambio in perdita.
    expect(buildClaudeArgs({ ...BASE, toolSearch: "1", mcpOutputTokens: 4000 })
      .filter((a) => a === "--settings").length).toBe(1);
  });

  test("il tetto da solo accende `--settings`, e non porta con sé il deferral", () => {
    expect(settings({ mcpOutputTokens: 2500 })).toEqual({ env: { MAX_MCP_OUTPUT_TOKENS: "2500" } });
  });

  test("null/assente: nessun tetto imposto, e il gate può essere visto FALLIRE", () => {
    // `TOPICS_MCP_OUTPUT_TOKENS=off` deve poter riportare la sessione al
    // comportamento della CLI: senza questa via d'uscita la misura "prima"
    // non si può rifare.
    expect(settings({ toolSearch: "1", mcpOutputTokens: null })).toEqual({ env: { ENABLE_TOOL_SEARCH: "1" } });
    expect(buildClaudeArgs({ ...BASE, mcpOutputTokens: null })).not.toContain("--settings");
  });

  test("stringa e non numero: la CLI legge il blocco `env`, dove i valori sono testo", () => {
    const args = buildClaudeArgs({ ...BASE, mcpOutputTokens: 4000 });
    expect(args.join(" ")).toContain('"MAX_MCP_OUTPUT_TOKENS":"4000"');
  });

  test("le skill NON spariscono: `--disable-slash-commands` non compare", () => {
    // Il cambio toglie il CATALOGO, non la capacità: i nomi restano nell'elenco
    // e `Skill` resta chiamabile.
    expect(buildClaudeArgs({ ...BASE, slimSkillListing: true })).not.toContain("--disable-slash-commands");
    expect(buildClaudeArgs({ ...BASE, slimSkillListing: true })).not.toContain("--bare");
  });
});

describe("buildClaudeArgs — la fotografia", () => {
  test("sessione NUOVA, effort e strict attivi", () => {
    expect(buildClaudeArgs({ ...BASE, effort: "xhigh" })).toEqual([
      "--print",
      "--permission-mode", "acceptEdits",
      "--verbose",
      "--model", "claude-opus-5[1m]",
      "--effort", "xhigh",
      "--setting-sources", "user,project,local",
      "--mcp-config", "/tmp/topics-mcp/topic-7.json",
      "--strict-mcp-config",
      "--permission-prompt-tool", "mcp__topics__approval_prompt",
      "--append-system-prompt", "<prompt di sistema>",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--session-id", "11111111-2222-3333-4444-555555555555",
    ]);
  });

  test("sessione RIPRESA: `--resume` al posto di `--session-id`", () => {
    const args = buildClaudeArgs({ ...BASE, effort: null, isNewSession: false });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    // La coda è la parte che decide se il modello ricorda: si guarda intera.
    expect(args.slice(-2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
  });

  test("senza effort la flag NON compare (la CLI usa il suo)", () => {
    expect(buildClaudeArgs({ ...BASE, effort: null })).not.toContain("--effort");
    expect(buildClaudeArgs({ ...BASE, effort: undefined })).not.toContain("--effort");
    expect(buildClaudeArgs({ ...BASE, effort: "" })).not.toContain("--effort");
  });

  test("senza strict il fleet MCP globale resta acceso: la flag non c'è", () => {
    const args = buildClaudeArgs({ ...BASE, effort: null, mcpStrict: false });
    expect(args).not.toContain("--strict-mcp-config");
    // …ma il file di sessione si passa comunque.
    expect(args).toContain("--mcp-config");
  });

  test("il canale di permesso c'è in OGNI modalità, bypassPermissions incluso", () => {
    // È l'invariante che il 7 agosto è costata tutti i tool MCP: un flag solo
    // non può desincronizzarsi da sé stesso solo se non è condizionato.
    for (const mode of ["bypassPermissions", "acceptEdits", "plan", "auto", "dontAsk"]) {
      const args = buildClaudeArgs({ ...BASE, effort: null, permissionMode: mode });
      const i = args.indexOf("--permission-prompt-tool");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe("mcp__topics__approval_prompt");
    }
  });

  test("ogni flag ha il suo valore subito dopo: niente coppie spaiate", () => {
    const args = buildClaudeArgs({ ...BASE, effort: "high" });
    const takesValue = new Set([
      "--permission-mode", "--model", "--effort", "--setting-sources", "--mcp-config",
      "--permission-prompt-tool", "--append-system-prompt", "--input-format",
      "--output-format", "--session-id", "--resume",
    ]);
    for (let i = 0; i < args.length; i++) {
      if (!takesValue.has(args[i]!)) continue;
      const value = args[i + 1];
      expect(value).toBeDefined();
      expect(value!.startsWith("--")).toBe(false);
      i++;
    }
  });
});

describe("buildClaudeOneshotArgs — la fotografia", () => {
  test("con il config MCP vuoto", () => {
    expect(
      buildClaudeOneshotArgs({
        permissionMode: "bypassPermissions",
        model: "claude-sonnet-5",
        emptyMcpConfigPath: "/tmp/topics-mcp/oneshot-x.json",
      }),
    ).toEqual([
      "--print",
      "--permission-mode", "bypassPermissions",
      "--model", "claude-sonnet-5",
      "--setting-sources", "user,project,local",
      "--mcp-config", "/tmp/topics-mcp/oneshot-x.json",
      "--strict-mcp-config",
      "--tools", "",
      "--output-format", "json",
    ]);
  });

  test("MAI `--verbose`: con `--output-format json` stdout diventa l'array di eventi", () => {
    const args = buildClaudeOneshotArgs({ permissionMode: "bypassPermissions", model: "m" });
    expect(args).not.toContain("--verbose");
  });

  test("scrittura del config fallita: si ripiega senza scoping, non si inventa un path", () => {
    const args = buildClaudeOneshotArgs({ permissionMode: "bypassPermissions", model: "m", emptyMcpConfigPath: null });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    // `--tools ""` resta: è quello che toglie gli schemi dei tool integrati.
    expect(args.slice(-4)).toEqual(["--tools", "", "--output-format", "json"]);
  });
});

describe("buildCodexArgs — la fotografia", () => {
  const BRIDGE = { command: "/usr/local/bin/bun", args: ["/srv/topics/mcp.ts", "--session", "topic:7"] };

  test("modello esplicito, sandbox, bridge e tier di reasoning", () => {
    expect(
      buildCodexArgs({
        model: "gpt-5-codex",
        approvalMode: "auto",
        bridge: BRIDGE,
        reasoningEffort: "high",
      }),
    ).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--model", "gpt-5-codex",
      "--sandbox", "workspace-write",
      "-c", `mcp_servers.topics.command="/usr/local/bin/bun"`,
      "-c", `mcp_servers.topics.args=["/srv/topics/mcp.ts","--session","topic:7"]`,
      "-c", `model_reasoning_effort="high"`,
    ]);
  });

  test("`full-access` scambia la sandbox col bypass, e SOLO quello esatto", () => {
    expect(buildCodexArgs({ approvalMode: "full-access" })).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Un valore scritto male non deve poter concedere l'accesso pieno…
    expect(buildCodexArgs({ approvalMode: "full_access" })).toContain("--sandbox");
    // …né toglierlo: assente = sandbox, che è il ripiego prudente.
    expect(buildCodexArgs({})).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
  });

  test("senza modello NON si passa `--model`: la CLI pesca da config.toml", () => {
    // È l'unico modo perché funzionino gli account ChatGPT.
    expect(buildCodexArgs({ model: null })).not.toContain("--model");
  });

  test("i valori dei `-c` sono TOML valido (stringa e array di stringhe)", () => {
    const args = buildCodexArgs({ bridge: { command: 'c:\\bun.exe', args: ['a "b"'] } });
    const cmd = args[args.indexOf("-c") + 1]!;
    expect(cmd).toBe('mcp_servers.topics.command="c:\\\\bun.exe"');
    expect(args[args.lastIndexOf("-c") + 1]).toBe('mcp_servers.topics.args=["a \\"b\\""]');
  });

  test("one-shot: niente `--json`, qui si legge il testo", () => {
    expect(buildCodexOneshotArgs({ model: "gpt-5" })).toEqual(["exec", "--model", "gpt-5"]);
    expect(buildCodexOneshotArgs({})).toEqual(["exec"]);
  });
});
