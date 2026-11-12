import { repeatedRowMarks, userRowMarks } from "../lib/user-row-marks";
import { keyTakenBy } from "../lib/client-message-key";
import { noteResendCopy } from "../lib/resend-count";
import { resolveTurnCheckpointsEnabled } from "../services/app-settings";
import { captureTurnCheckpoint } from "../services/turn-checkpoints";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { scaffoldNewProject } from "../services/project-path-resolver";
import { homedir } from "os";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Persists the message of a turn, with the answers it carries, before the turn starts. */
export async function prepareTurnMessages(turn: ChatTurnScope): Promise<Response | undefined> {
  const { WORKSPACE_DIR, appendLocalMessage, authorFor, bindTopicToProject, body, broadcastToAll, bumpTopicActivity, chatIdempotency, ctx, dispatched, dispatchedFor, getWorkspaceProjects, idempotencyKey, idempotencySlot, json, knownProjectPaths, lastUserMsg, matchedTopic, nativeChildChat, req, resolveProjectRef, resumeAttempt, sentByPerson, sessionKey, supersedeOpenQuestions } = turn;
  if (lastUserMsg?.role === "user" && lastUserMsg?.content) {
    // L'AUTORE si stampa QUI, ed è l'unico posto in cui un prompt umano
    // entra nel database: `appendLocalMessage` da qualunque altro
    // chiamante (import di transcript, sotto-agenti) non ha un'identità di
    // richiesta da cui ricavarlo, e quelle righe restano senza autore —
    // che è la risposta giusta, non una mancanza.
    // A ROW NOBODY TYPED SAYS SO, and which rows those are is decided in
    // `lib/user-row-marks.ts`: the goal continuation and the dispatcher's
    // envelope are `user` rows because that is the only role a provider
    // answers, and the mark is what stops the transcript from showing the
    // person saying words they never wrote.
    let storedUserMsg: ReturnType<typeof appendLocalMessage>;
    try {
      storedUserMsg = appendLocalMessage(
        sessionKey, "user", lastUserMsg.content,
        authorFor(req),
        userRowMarks({
          goalNudge: body.goalNudge, dispatched, commentIds: dispatchedFor, processExit: body.processExit, subagentResults: body.subagentResults,
          repeats: repeatedRowMarks(ctx.db, sessionKey, lastUserMsg.content),
        }),
        idempotencyKey ?? undefined,
      );
    } catch (err) {
      // Another request stored this key first: the unique index refused the second row.
      const taken = keyTakenBy(err, ctx.db, sessionKey, idempotencyKey);
      if (!taken) throw err;
      return json({ error: "message already accepted", code: "duplicate_message", messageId: taken }, 409);
    }
    // ADESSO il messaggio esiste, e da adesso una ripetizione è un doppione.
    // Non un istante prima: la riga è la prova, e finché non c'è, ripetere è
    // l'unica cosa giusta da fare.
    if (idempotencySlot) chatIdempotency.remember(idempotencySlot, storedUserMsg.id);
    // A resend of the resume sweep: this copy of the message leads the next
    // sweep back to its count, written in the same tick as the row.
    if (resumeAttempt > 0 && typeof body.resendOf === "string") noteResendCopy(ctx.db, sessionKey, body.resendOf, storedUserMsg.id);
    if (matchedTopic) {
      // The marks travel WITH the frame (without them every other window
      // drew the goal continuation as the person's own bubble until a
      // reload, 23/09), and so does the send's key: the window that sent
      // it renames its bubble to this row (`hooks/ownBubble.ts`, client).
      broadcastToAll({
        type: "message:new", topicId: matchedTopic.id, sessionKey, role: "user",
        messageId: storedUserMsg.id, content: lastUserMsg.content, preview: lastUserMsg.content.slice(0, 100),
        ...(storedUserMsg.blocks?.length ? { blocks: storedUserMsg.blocks } : {}),
        ...(idempotencyKey ? { clientMessageId: idempotencyKey } : {}),
      });
      // Bump the topic's own timestamp on every real message, not just
      // metadata edits (rename/archive/autoname/…). Without this the
      // sidebar's lastActivity (topicTimestamp) freezes at whatever
      // administrative touch happened last — a chat can be actively in use
      // for hours and still show its row from a day-old rename.
      bumpTopicActivity(matchedTopic);
    }
    // The relayed answer to one question (`lib/answer-relay.ts`) is the
    // person's words, but not a choice to skip their OTHER open questions;
    // another agent's message (`send_chat_message`) is not the person's.
    if (sentByPerson && !body.questionAnswer && !body.fromAgent) supersedeOpenQuestions(sessionKey, matchedTopic?.id);

    // THE AUTOMATIC CHECKPOINT, and this is the only moment it can be taken.
    //
    // The snapshot has to be of the tree BEFORE the agent writes anything,
    // so it goes here - after the user's message exists (the checkpoint is
    // labelled with it) and before the provider is started. It is AWAITED
    // rather than fired off: a snapshot racing the agent's first write is
    // not a safety net, it is a lie about one.
    //
    // Off unless somebody turned it on, and never fatal: if git refuses for
    // any reason the turn proceeds. A failed checkpoint must not cost the
    // user their turn - it costs them the undo, which is the smaller loss.
    if (
      !lastUserMsg.content.trim().startsWith("/") &&
      matchedTopic?.projectPath &&
      resolveTurnCheckpointsEnabled()
    ) {
      turn.turnCheckpointMark = {
        projectPath: matchedTopic.projectPath,
        label: lastUserMsg.content.trim().slice(0, 72).replace(/\s+/g, " "),
      };
      try {
        await captureTurnCheckpoint(turn.turnCheckpointMark.projectPath, sessionKey, turn.turnCheckpointMark.label);
      } catch (err) {
        console.warn(`[Chat] automatic checkpoint failed for ${sessionKey}:`, err);
      }
    }

    // Handle board chat control commands (/ prefixed)
    if (lastUserMsg.content.trim().startsWith("/") && !nativeChildChat) {
      const cmdText = lastUserMsg.content.trim();
      const cmdMatch = cmdText.match(/^\/(\w+)\s*(.*)/);
      if (cmdMatch) {
        const [, cmd, rest] = cmdMatch;
        let response: string | null = null;

        try {
          if (cmd === "project") {
            // The registered global coordinator is deliberately an
            // unbound Topic. Do this at the chat-command boundary too:
            // this legacy interceptor creates directories before it tries
            // to bind, and a failed bind must not become a false success.
            if (matchedTopic && isGlobalOrchestratorTopic(ctx.db, matchedTopic.id)) {
              response = "Project controls are unavailable in the global Kanban coordinator. It remains unbound and coordinates work through the global board tools.";
            } else {
              const subMatch = rest.match(/^(\w+)\s*(.*)/);
              const sub = subMatch ? subMatch[1] : "";
              const arg = subMatch ? subMatch[2].trim() : "";

              if (sub === "create" && arg) {
                // Sanitize name: only alphanumeric, hyphens, underscores
                const safeName = arg.replace(/[^a-zA-Z0-9_-]/g, "");
                if (!safeName) {
                  response = `Invalid project name. Use alphanumeric characters, hyphens, and underscores.`;
                } else {
                  const { dir: targetDir, exists } = scaffoldNewProject(safeName, {
                    workspaceDir: WORKSPACE_DIR, homeDir: homedir(), knownDirs: knownProjectPaths?.() ?? [], projectStore: ctx.projectStore,
                  });
                  if (exists) {
                    response = `Project **${safeName}** already exists at \`${targetDir}\`. Use \`/project open ${safeName}\` to bind it.`;
                  } else {
                    // Bind to current topic + open the project window.
                    if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
                    response = `Created project **${safeName}** at \`${targetDir}\` and bound to this topic.`;
                  }
                }
              } else if (sub === "open" && arg) {
                // Resolve against the user's real Topics projects, not just the workspace.
                // Explicit local user command → raw absolute/~ paths are trusted.
                const targetDir = resolveProjectRef(arg, { trustRawPaths: true });
                if (!targetDir) {
                  response = `Project not found: \`${arg}\``;
                } else {
                  const projectName = targetDir.split("/").pop() || arg;
                  if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
                  response = `Opened project **${projectName}**. It is now bound to this topic.`;
                }
              } else {
                // No subcommand: show current + list
                const lines: string[] = [];
                if (matchedTopic?.projectPath) {
                  lines.push(`**Current project:** \`${matchedTopic.projectPath}\``);
                } else {
                  lines.push("No project bound to this topic.");
                }
                const wsProjects = getWorkspaceProjects();
                if (wsProjects.length > 0) {
                  lines.push("", "**Workspace projects:**");
                  for (const p of wsProjects) {
                    const name = p.split("/").pop();
                    lines.push(`- \`${name}\` · ${p}`);
                  }
                }
                response = lines.join("\n");
              }
            }
          }
        } catch (err: any) {
          console.warn("[ChatCommand] Error handling command:", err);
          response = `Command error: ${err.message}`;
        }

        // If a command produced a response, inject it as a synthetic assistant message
        if (response) {
          const storedCmdMsg = appendLocalMessage(sessionKey, "assistant", response);
          if (matchedTopic) {
            broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedCmdMsg.id, content: response, preview: response.slice(0, 100) });
          }
          // Return the response as an SSE payload so the client displays it
          const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(response)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
          return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
      }
    }
  }
}
