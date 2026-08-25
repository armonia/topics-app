/**
 * deriveToolDetail — unit tests.
 *
 * Validates the provider-boundary normalizer that translates raw tool
 * names + args into the typed ToolCallDetail union the renderer
 * branches on. Pure function; trivial to test exhaustively.
 * @covers MONITOR-01, BGSHELL-01
 */

import { describe, expect, test } from "bun:test";
import { deriveToolDetail, deriveToolDetailFromCall } from "./tool-detail";

describe("deriveToolDetail", () => {
  test("shell aliases all collapse to type=shell", () => {
    for (const name of ["Bash", "bash", "shell", "SHELL", "exec_command", "run_command", "Terminal"]) {
      const d = deriveToolDetail(name, { command: "ls" });
      expect(d.type).toBe("shell");
      if (d.type === "shell") expect(d.command).toBe("ls");
    }
  });

  test("shell — picks command from cmd/input fallback", () => {
    expect((deriveToolDetail("Bash", { cmd: "pwd" }) as any).command).toBe("pwd");
    expect((deriveToolDetail("Bash", { input: "echo hi" }) as any).command).toBe("echo hi");
  });

  test("shell — captures cwd + output when provided", () => {
    const d = deriveToolDetail("Bash", { command: "ls", cwd: "/tmp" }, "file1\nfile2");
    expect(d.type).toBe("shell");
    if (d.type === "shell") {
      expect(d.cwd).toBe("/tmp");
      expect(d.output).toBe("file1\nfile2");
    }
  });

  test("read variants → type=read with filePath", () => {
    for (const name of ["Read", "read", "read_file", "view_file", "view"]) {
      const d = deriveToolDetail(name, { file_path: "/foo.ts" });
      expect(d.type).toBe("read");
      if (d.type === "read") expect(d.filePath).toBe("/foo.ts");
    }
  });

  test("read — filePath fallbacks (file_path | filePath | path)", () => {
    expect((deriveToolDetail("Read", { filePath: "a.ts" }) as any).filePath).toBe("a.ts");
    expect((deriveToolDetail("Read", { path: "b.ts" }) as any).filePath).toBe("b.ts");
  });

  test("read — captures offset/limit when present", () => {
    const d = deriveToolDetail("Read", { file_path: "f.ts", offset: 10, limit: 50 }, "...");
    if (d.type === "read") {
      expect(d.offset).toBe(10);
      expect(d.limit).toBe(50);
      expect(d.content).toBe("...");
    }
  });

  test("edit variants → type=edit", () => {
    for (const name of ["Edit", "edit", "apply_patch", "apply_diff", "str_replace_editor", "str_replace"]) {
      const d = deriveToolDetail(name, { file_path: "f.ts", old_string: "a", new_string: "b" });
      expect(d.type).toBe("edit");
      if (d.type === "edit") {
        expect(d.filePath).toBe("f.ts");
        expect(d.oldString).toBe("a");
        expect(d.newString).toBe("b");
      }
    }
  });

  test("MultiEdit → type=edit with first edit + tail marker", () => {
    const d = deriveToolDetail("MultiEdit", {
      file_path: "f.ts",
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
        { old_string: "m", new_string: "n" },
      ],
    });
    expect(d.type).toBe("edit");
    if (d.type === "edit") {
      expect(d.oldString).toContain("x");
      expect(d.oldString).toContain("2 more edit");
      expect(d.newString).toContain("y");
    }
  });

  test("write variants → type=write", () => {
    for (const name of ["Write", "write", "write_file", "create_file"]) {
      const d = deriveToolDetail(name, { file_path: "new.ts", content: "// hi" });
      expect(d.type).toBe("write");
      if (d.type === "write") {
        expect(d.filePath).toBe("new.ts");
        expect(d.content).toBe("// hi");
      }
    }
  });

  test("grep → type=search with toolName=grep + mode normalization", () => {
    const d = deriveToolDetail("Grep", { pattern: "TODO", output_mode: "files_with_matches" });
    expect(d.type).toBe("search");
    if (d.type === "search") {
      expect(d.toolName).toBe("grep");
      expect(d.query).toBe("TODO");
      expect(d.mode).toBe("files_with_matches");
    }
  });

  test("glob → type=search with toolName=glob", () => {
    const d = deriveToolDetail("Glob", { pattern: "**/*.ts" });
    if (d.type === "search") {
      expect(d.toolName).toBe("glob");
      expect(d.query).toBe("**/*.ts");
    }
  });

  test("websearch → type=search with toolName=web_search", () => {
    const d = deriveToolDetail("WebSearch", { query: "latest react news" });
    if (d.type === "search") {
      expect(d.toolName).toBe("web_search");
      expect(d.query).toBe("latest react news");
    }
  });

  test("WebFetch → type=fetch with url + prompt + result", () => {
    const d = deriveToolDetail("WebFetch", { url: "https://x.com", prompt: "summarize" }, "result body");
    expect(d.type).toBe("fetch");
    if (d.type === "fetch") {
      expect(d.url).toBe("https://x.com");
      expect(d.prompt).toBe("summarize");
      expect(d.result).toBe("result body");
    }
  });

  test("TodoWrite → type=todo with status mapped per item", () => {
    const d = deriveToolDetail("TodoWrite", {
      todos: [
        { content: "do A", status: "pending", activeForm: "Doing A" },
        { content: "do B", status: "in_progress" },
        { content: "do C", status: "completed" },
      ],
    });
    expect(d.type).toBe("todo");
    if (d.type === "todo") {
      expect(d.items.length).toBe(3);
      expect(d.items[0].status).toBe("pending");
      expect(d.items[0].activeForm).toBe("Doing A");
      expect(d.items[1].status).toBe("in_progress");
      expect(d.items[2].status).toBe("completed");
    }
  });

  test("ExitPlanMode → type=plan", () => {
    const d = deriveToolDetail("ExitPlanMode", { plan: "## Plan\n1. step 1\n2. step 2" });
    expect(d.type).toBe("plan");
    if (d.type === "plan") expect(d.text).toContain("step 1");
  });

  test("Task → type=sub_agent with subAgentType + description", () => {
    const d = deriveToolDetail("Task", {
      subagent_type: "Explore",
      description: "find auth code",
      prompt: "...",
    });
    expect(d.type).toBe("sub_agent");
    if (d.type === "sub_agent") {
      expect(d.subAgentType).toBe("Explore");
      expect(d.description).toBe("find auth code");
      expect(d.actions).toEqual([]);
    }
  });

  test("MCP tool name → type=mcp with namespace stripping", () => {
    const d = deriveToolDetail("mcp__omega-memory__omega_query", { query: "auth" }, "result");
    expect(d.type).toBe("mcp");
    if (d.type === "mcp") {
      expect(d.server).toBe("omega-memory");
      expect(d.tool).toBe("omega_query");
      expect(d.args?.query).toBe("auth");
      expect(d.result).toBe("result");
    }
  });

  test("MCP — tool name with multiple __ joins remainder", () => {
    const d = deriveToolDetail("mcp__server__nested__tool", {});
    if (d.type === "mcp") {
      expect(d.server).toBe("server");
      expect(d.tool).toBe("nested__tool");
    }
  });

  test("unknown tool name → type=unknown with raw args/result", () => {
    const d = deriveToolDetail("CompletelyMadeUpTool", { foo: "bar" }, "ret");
    expect(d.type).toBe("unknown");
    if (d.type === "unknown") {
      expect(d.raw.args?.foo).toBe("bar");
      expect(d.raw.result).toBe("ret");
    }
  });

  test("undefined args → safe defaults", () => {
    const d = deriveToolDetail("Bash", undefined);
    if (d.type === "shell") expect(d.command).toBe("");
  });

  test("null args → no crash", () => {
    const d = deriveToolDetail("Read", null as any);
    if (d.type === "read") expect(d.filePath).toBe("");
  });

  test("array args → coerced to empty record", () => {
    // The function should treat non-record args as missing, not crash.
    const d = deriveToolDetail("Read", [1, 2, 3] as any);
    if (d.type === "read") expect(d.filePath).toBe("");
  });

  test("deriveToolDetailFromCall — convenience wrapper", () => {
    const d = deriveToolDetailFromCall({
      id: "x",
      name: "Bash",
      args: { command: "echo hi" },
      result: "hi",
      status: "success",
    });
    if (d.type === "shell") {
      expect(d.command).toBe("echo hi");
      expect(d.output).toBe("hi");
    }
  });

  test("case-insensitive name matching", () => {
    expect(deriveToolDetail("BASH", { command: "x" }).type).toBe("shell");
    expect(deriveToolDetail("Read", { file_path: "x" }).type).toBe("read");
    expect(deriveToolDetail("EDIT", { file_path: "x" }).type).toBe("edit");
  });

  // ── Long-lived / background / harness tools (previously `unknown`) ──────────

  test("background Bash — run_in_background sets background flag", () => {
    const d = deriveToolDetail("Bash", { command: "npm run dev", run_in_background: true });
    expect(d.type).toBe("shell");
    if (d.type === "shell") {
      expect(d.background).toBe(true);
      expect(d.command).toBe("npm run dev");
    }
    // Foreground bash never carries the flag.
    const fg = deriveToolDetail("Bash", { command: "ls" });
    if (fg.type === "shell") expect(fg.background).toBeUndefined();
  });

  test("Monitor → type=monitor with description + ws url", () => {
    const d = deriveToolDetail("Monitor", { description: "errors in deploy.log", ws: { url: "wss://x/stream" }, persistent: true }, "hit");
    expect(d.type).toBe("monitor");
    if (d.type === "monitor") {
      expect(d.description).toBe("errors in deploy.log");
      expect(d.wsUrl).toBe("wss://x/stream");
      expect(d.persistent).toBe(true);
      expect(d.result).toBe("hit");
    }
  });

  test("Monitor → command source when no ws", () => {
    const d = deriveToolDetail("Monitor", { description: "tail", command: "tail -f log" });
    if (d.type === "monitor") {
      expect(d.command).toBe("tail -f log");
      expect(d.wsUrl).toBeUndefined();
      expect(d.persistent).toBeUndefined();
    }
  });

  test("wait_for_process → type=wait, con l'id per ritrovare il processo vivo", () => {
    const d = deriveToolDetail(
      "mcp__topics__wait_for_process",
      { process_id: "p-7", until: "listening on", timeout_ms: 60000 },
      "STILL RUNNING",
    );
    expect(d.type).toBe("wait");
    if (d.type === "wait") {
      expect(d.processId).toBe("p-7");
      expect(d.until).toBe("listening on");
      expect(d.timeoutMs).toBe(60000);
      expect(d.result).toBe("STILL RUNNING");
    }
  });

  test("gli altri tool MCP restano type=mcp", () => {
    expect(deriveToolDetail("mcp__topics__list_processes", {}).type).toBe("mcp");
  });

  test("BashOutput → type=bash_output with shellId from bash_id", () => {
    const d = deriveToolDetail("BashOutput", { bash_id: "sh_42", filter: "ERROR" }, "line1");
    expect(d.type).toBe("bash_output");
    if (d.type === "bash_output") {
      expect(d.shellId).toBe("sh_42");
      expect(d.filter).toBe("ERROR");
      expect(d.output).toBe("line1");
    }
  });

  test("KillShell / KillBash → type=kill_shell", () => {
    for (const name of ["KillShell", "KillBash", "kill_shell"]) {
      const d = deriveToolDetail(name, { shell_id: "sh_7" });
      expect(d.type).toBe("kill_shell");
      if (d.type === "kill_shell") expect(d.shellId).toBe("sh_7");
    }
  });

  test("NotebookEdit → type=notebook_edit", () => {
    const d = deriveToolDetail("NotebookEdit", { notebook_path: "/a.ipynb", cell_id: "c1", edit_mode: "insert", cell_type: "code" });
    expect(d.type).toBe("notebook_edit");
    if (d.type === "notebook_edit") {
      expect(d.notebookPath).toBe("/a.ipynb");
      expect(d.cellId).toBe("c1");
      expect(d.editMode).toBe("insert");
      expect(d.cellType).toBe("code");
    }
  });

  test("Skill → type=skill", () => {
    const d = deriveToolDetail("Skill", { skill: "deploy", args: "--prod" }, "ok");
    expect(d.type).toBe("skill");
    if (d.type === "skill") {
      expect(d.skill).toBe("deploy");
      expect(d.args).toBe("--prod");
      expect(d.result).toBe("ok");
    }
  });

  test("SlashCommand → type=slash_command", () => {
    const d = deriveToolDetail("SlashCommand", { command: "/review" });
    expect(d.type).toBe("slash_command");
    if (d.type === "slash_command") expect(d.command).toBe("/review");
  });

  test("LSP → type=lsp with operation + symbol", () => {
    const d = deriveToolDetail("LSP", { operation: "goToDefinition", file_path: "/x.ts", query: "foo" });
    expect(d.type).toBe("lsp");
    if (d.type === "lsp") {
      expect(d.operation).toBe("goToDefinition");
      expect(d.filePath).toBe("/x.ts");
      expect(d.symbol).toBe("foo");
    }
  });

  test("unknown tools still fall through to type=unknown", () => {
    const d = deriveToolDetail("SomeRandomTool", { foo: 1 });
    expect(d.type).toBe("unknown");
  });
});

// ── TaskCreate / TaskUpdate (CLI 2.1.220) ──────────────────────────────────
//
// Il confine dello stream è QUI: se la todo non viene riconosciuta a questo
// punto, al client arriva un tool generico e a schermo si vede JSON grezzo.
describe("deriveToolDetail — TaskCreate / TaskUpdate", () => {
  test("TaskCreate diventa una voce todo `pending`", () => {
    expect(deriveToolDetail("TaskCreate", { subject: "Sistemare il parser", description: "lungo…" }))
      .toEqual({ type: "todo", items: [{ content: "Sistemare il parser", status: "pending" }] });
  });

  test("TaskUpdate con subject e status porta QUELLO stato", () => {
    expect(deriveToolDetail("TaskUpdate", { taskId: "1", subject: "Sistemare il parser", status: "completed" }))
      .toEqual({ type: "todo", items: [{ content: "Sistemare il parser", status: "completed" }] });
  });

  test("TaskUpdate senza subject non finge una voce vuota", () => {
    // Il caso più comune (`{taskId, status}`): una riga di todo senza todo
    // sarebbe peggio del tool generico.
    expect(deriveToolDetail("TaskUpdate", { taskId: "1", status: "in_progress" })?.type).not.toBe("todo");
  });

  test('status "deleted" non si traveste da completato', () => {
    expect(deriveToolDetail("TaskUpdate", { taskId: "1", subject: "Roba", status: "deleted" })?.type).not.toBe("todo");
  });

  test("non ruba il caso `Task` (sub-agent)", () => {
    expect(deriveToolDetail("Task", { subagent_type: "Explore", description: "cerca" })?.type).toBe("sub_agent");
  });
});
