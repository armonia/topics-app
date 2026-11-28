/** Shared setup of the agent tests: a database with the schedule migrations, an engine on a fake clock, a fake chat door. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentAction, scheduledJobClientMessageId, type AgentChatDoor } from "./agent-action";
import { createScheduleEngine } from "./engine";
import { freshDb } from "../services/tasks-test-db";
import type { RunRow } from "./store";

const MIGRATIONS = join(import.meta.dir, "../db/migrations");

export function migratedDb(): Database {
  const db = freshDb();
  for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261121160000-scheduled-job-command-output.sql"]) db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  return db;
}

export interface FakeTurn { open: boolean; text: string | null; resentAs?: string }

/** A chat door with nothing real behind it: the test says when a turn opens, closes, and what it answered. */
export function fakeChatDoor() {
  const chats = new Map<string, Map<string, FakeTurn>>(); // sessionKey -> clientMessageId -> turn
  const archived = new Set<string>();
  const openQuestions = new Set<string>();
  const sent: Array<{ sessionKey: string; clientMessageId: string; prompt: string }> = [];
  let nextSession = 0;
  let busyOnce = false;

  const door: AgentChatDoor = {
    route(req) {
      return req.json().then((body: { sessionKey: string; clientMessageId: string; messages: Array<{ content: string }> }) => {
        const turns = chats.get(body.sessionKey) ?? new Map();
        chats.set(body.sessionKey, turns);
        if (turns.has(body.clientMessageId)) {
          return new Response(JSON.stringify({ error: "message already accepted", code: "duplicate_message" }), { status: 409 });
        }
        if (busyOnce) {
          busyOnce = false;
          return new Response(JSON.stringify({ error: "a response is already streaming for this session", code: "stream_in_flight" }), { status: 409 });
        }
        sent.push({ sessionKey: body.sessionKey, clientMessageId: body.clientMessageId, prompt: body.messages.at(-1)?.content ?? "" });
        turns.set(body.clientMessageId, { open: true, text: null });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as never;
    },
    createChat(job) {
      const sessionKey = `s-${job.id}-${++nextSession}`;
      chats.set(sessionKey, new Map());
      return sessionKey;
    },
    turnOpen(sessionKey) {
      for (const turn of chats.get(sessionKey)?.values() ?? []) if (turn.open) return true;
      return false;
    },
    sent(sessionKey, clientMessageId) {
      return chats.get(sessionKey)?.has(clientMessageId) ?? false;
    },
    finalText(sessionKey, clientMessageId) {
      const turns = chats.get(sessionKey);
      let turn = turns?.get(clientMessageId);
      if (!turn) return undefined;
      // Follow a boot resume's copy forward to its terminal turn.
      while (turn?.resentAs) turn = turns?.get(turn.resentAs);
      if (!turn || turn.open) return undefined;
      return turn.text;
    },
    hasOpenQuestions(sessionKey) {
      return openQuestions.has(sessionKey);
    },
    archiveChat(sessionKey) {
      archived.add(sessionKey);
    },
  };

  return {
    door, sent, archived, openQuestions,
    /** The test ends the turn under this key, with this final text. */
    answer(sessionKey: string, clientMessageId: string, text: string) {
      const turn = chats.get(sessionKey)?.get(clientMessageId);
      if (turn) { turn.open = false; turn.text = text; }
    },
    /** A boot resume writes a fresh copy of the row under a NEW key: the original's turn is the one an outage cut. */
    resumeCopy(sessionKey: string, clientMessageId: string, copyKey: string) {
      const turns = chats.get(sessionKey)!;
      const original = turns.get(clientMessageId)!;
      original.open = false;
      original.resentAs = copyKey;
      turns.set(copyKey, { open: true, text: null });
    },
    /** The turn closed (an outage cut it) with nothing readable left behind. */
    cutWithNoOutcome(sessionKey: string, clientMessageId: string) {
      const turn = chats.get(sessionKey)?.get(clientMessageId);
      if (turn) { turn.open = false; turn.text = null; }
    },
    /** The very next send on this door answers 409 `stream_in_flight` instead of going through. */
    makeNextSendBusy() { busyOnce = true; },
  };
}

export function buildAgentEngine(db: Database, chat: AgentChatDoor, clock: { now: Date }) {
  const door = { closeIfOpen: (...args: Parameters<ReturnType<typeof createScheduleEngine>["closeIfOpen"]>) => engine.closeIfOpen(...args) };
  const action = createAgentAction(db, door, { chat });
  const engine = createScheduleEngine(db, { executors: { agent: action.executor }, now: () => clock.now });
  return { engine, action };
}

export function addAgentJob(db: Database, clock: { now: Date }, id: string, patch: { schedule?: unknown; action?: Record<string, unknown>; policy?: unknown; nextRunAt?: string } = {}) {
  const action = { kind: "agent", prompt: "Do the thing.", chatMode: "fresh", ...patch.action };
  db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, policy_json, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, id, JSON.stringify(patch.schedule ?? { kind: "every", minutes: 10 }), JSON.stringify(action), JSON.stringify(patch.policy ?? {}),
      patch.nextRunAt ?? clock.now.toISOString(), clock.now.toISOString(), clock.now.toISOString());
}

export const runsOf = (db: Database, jobId: string) => db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY created_at, occurrence_key").all(jobId) as RunRow[];
export { scheduledJobClientMessageId };
