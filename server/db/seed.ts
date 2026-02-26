/**
 * Seed script: Migrate existing JSON file data into SQLite.
 *
 * Usage: bun run server/db/seed.ts
 *
 * This reads topics.json, unread.json, messages/*.json, data/usage/*.json,
 * and tasks/*.json, then inserts them into the SQLite database.
 *
 * Original files are renamed to *.migrated as backup.
 * Set FALLBACK_TO_JSON=1 to skip migration (for rollback).
 */

import { readFileSync, existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { initDatabase } from "../db";

const baseDir = join(import.meta.dir, "../..");

if (process.env.FALLBACK_TO_JSON === "1") {
  console.log("[Seed] FALLBACK_TO_JSON=1 — skipping migration");
  process.exit(0);
}

console.log("[Seed] Starting JSON → SQLite migration...");
console.log(`[Seed] Base directory: ${baseDir}`);

const db = initDatabase(baseDir);

// ============================================================
// 1. Migrate topics.json
// ============================================================
const topicsFile = join(baseDir, "topics.json");
if (existsSync(topicsFile)) {
  console.log("[Seed] Migrating topics.json...");
  try {
    const data = JSON.parse(readFileSync(topicsFile, "utf-8"));
    const topics = data.topics || {};

    const insertTopic = db.prepare(`
      INSERT OR IGNORE INTO topics (id, name, slug, parent_id, session_key, color, icon, system_prompt, project_path, sort_order, autonomy_level, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLink = db.prepare(`INSERT OR IGNORE INTO topic_links (source_id, target_id) VALUES (?, ?)`);
    const insertContextFile = db.prepare(`INSERT OR IGNORE INTO topic_context_files (topic_id, file_path) VALUES (?, ?)`);
    const insertPinnedMsg = db.prepare(`INSERT OR IGNORE INTO topic_pinned_messages (topic_id, message_id) VALUES (?, ?)`);
    const insertDisabledSource = db.prepare(`INSERT OR IGNORE INTO topic_disabled_sources (topic_id, source_id) VALUES (?, ?)`);
    db.transaction(() => {
      let count = 0;
      for (const [id, topic] of Object.entries(topics) as [string, any][]) {
        insertTopic.run(
          id, topic.name, topic.slug, topic.parentId || null,
          topic.sessionKey, topic.color || '#6366f1', topic.icon || 'MessageSquare',
          topic.systemPrompt || null, topic.projectPath || null,
          topic.sortOrder ?? 0, topic.autonomyLevel || 'ask',
          topic.archived ? 1 : 0, topic.createdAt, topic.updatedAt
        );

        // Links
        if (Array.isArray(topic.links)) {
          for (const targetId of topic.links) {
            insertLink.run(id, targetId);
          }
        }

        // Context files
        if (Array.isArray(topic.contextFiles)) {
          for (const fp of topic.contextFiles) {
            insertContextFile.run(id, fp);
          }
        }

        // Pinned messages
        if (Array.isArray(topic.pinnedMessages)) {
          for (const msgId of topic.pinnedMessages) {
            insertPinnedMsg.run(id, msgId);
          }
        }

        // Disabled sources
        if (Array.isArray(topic.disabledContextSources)) {
          for (const src of topic.disabledContextSources) {
            insertDisabledSource.run(id, src);
          }
        }

        count++;
      }
      console.log(`[Seed] Migrated ${count} topics`);
    })();

    renameSync(topicsFile, topicsFile + ".migrated");
    console.log("[Seed] topics.json → topics.json.migrated");
  } catch (err) {
    console.error("[Seed] Error migrating topics:", err);
  }
} else {
  console.log("[Seed] No topics.json found, skipping");
}

// ============================================================
// 2. Migrate unread.json
// ============================================================
const unreadFile = join(baseDir, "unread.json");
if (existsSync(unreadFile)) {
  console.log("[Seed] Migrating unread.json...");
  try {
    const data = JSON.parse(readFileSync(unreadFile, "utf-8"));
    const insertUnread = db.prepare(`
      INSERT OR IGNORE INTO unread (topic_id, last_read_at, unread_count)
      VALUES (?, ?, ?)
    `);

    db.transaction(() => {
      let count = 0;
      for (const [topicId, entry] of Object.entries(data) as [string, any][]) {
        // Only insert if the topic exists in the DB
        const topicExists = db.query("SELECT 1 FROM topics WHERE id = ?").get(topicId);
        if (topicExists) {
          insertUnread.run(topicId, entry.lastReadAt, entry.unreadCount);
          count++;
        }
      }
      console.log(`[Seed] Migrated ${count} unread entries`);
    })();

    renameSync(unreadFile, unreadFile + ".migrated");
    console.log("[Seed] unread.json → unread.json.migrated");
  } catch (err) {
    console.error("[Seed] Error migrating unread:", err);
  }
} else {
  console.log("[Seed] No unread.json found, skipping");
}

// ============================================================
// 3. Migrate messages/*.json
// ============================================================
const messagesDir = join(baseDir, "messages");
if (existsSync(messagesDir)) {
  console.log("[Seed] Migrating messages...");
  try {
    const files = readdirSync(messagesDir).filter(f => f.endsWith(".json") && !f.includes(".migrated"));
    const insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messages (id, session_key, role, content, thinking, tool_calls, media, partial, streamed_at, plan_status, timestamp, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalMessages = 0;
    for (const file of files) {
      const sessionKey = file.replace(".json", "");
      try {
        const msgs = JSON.parse(readFileSync(join(messagesDir, file), "utf-8"));
        if (!Array.isArray(msgs)) continue;

        db.transaction(() => {
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            insertMessage.run(
              msg.id || crypto.randomUUID(),
              sessionKey,
              msg.role,
              msg.content || '',
              msg.thinking || null,
              msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
              msg.media ? JSON.stringify(msg.media) : null,
              msg.partial ? 1 : 0,
              msg.streamedAt || null,
              msg.planStatus || null,
              msg.timestamp,
              i
            );
            totalMessages++;
          }
        })();

        renameSync(join(messagesDir, file), join(messagesDir, file + ".migrated"));
      } catch (err) {
        console.warn(`[Seed] Error migrating messages/${file}:`, err);
      }
    }
    console.log(`[Seed] Migrated ${totalMessages} messages from ${files.length} files`);
  } catch (err) {
    console.error("[Seed] Error migrating messages:", err);
  }
} else {
  console.log("[Seed] No messages directory found, skipping");
}

// ============================================================
// 4. Migrate tasks/*.json
// ============================================================
const tasksDir = join(baseDir, "tasks");
if (existsSync(tasksDir)) {
  console.log("[Seed] Migrating tasks...");
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith(".json") && !f.includes(".migrated"));
    const insertTask = db.prepare(`
      INSERT OR IGNORE INTO tasks (id, project_id, text, status, kanban_order, chat_id, created_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalTasks = 0;
    for (const file of files) {
      const projectId = file.replace(".json", "");
      try {
        const tasks = JSON.parse(readFileSync(join(tasksDir, file), "utf-8"));
        if (!Array.isArray(tasks)) continue;

        db.transaction(() => {
          for (const task of tasks) {
            // Map old status names to new ones
            let status = task.status || 'todo';
            if (status === 'active') status = 'in_progress';
            if (!['backlog', 'todo', 'in_progress', 'review', 'done'].includes(status)) {
              status = 'todo';
            }

            insertTask.run(
              task.id,
              projectId,
              task.text,
              status,
              task.kanbanOrder ?? 0,
              task.chatId || null,
              task.createdAt || new Date().toISOString(),
              task.completedAt || null,
              task.updatedAt || task.createdAt || new Date().toISOString()
            );
            totalTasks++;
          }
        })();

        renameSync(join(tasksDir, file), join(tasksDir, file + ".migrated"));
      } catch (err) {
        console.warn(`[Seed] Error migrating tasks/${file}:`, err);
      }
    }
    console.log(`[Seed] Migrated ${totalTasks} tasks from ${files.length} files`);
  } catch (err) {
    console.error("[Seed] Error migrating tasks:", err);
  }
} else {
  console.log("[Seed] No tasks directory found, skipping");
}

// ============================================================
// 5. Migrate usage data (data/usage/*.json)
// ============================================================
const usageDir = join(baseDir, "data", "usage");
if (existsSync(usageDir)) {
  console.log("[Seed] Migrating usage records...");
  try {
    const files = readdirSync(usageDir).filter(f => f.endsWith(".json") && f !== "summary.json" && !f.includes(".tmp.") && !f.includes(".migrated"));
    const insertUsage = db.prepare(`
      INSERT OR IGNORE INTO usage_records (id, timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalRecords = 0;
    for (const file of files) {
      try {
        const records = JSON.parse(readFileSync(join(usageDir, file), "utf-8"));
        if (!Array.isArray(records)) continue;

        db.transaction(() => {
          for (const r of records) {
            insertUsage.run(
              crypto.randomUUID(),
              r.timestamp,
              r.sessionKey,
              r.topicId || null,
              r.model,
              r.inputTokens || 0,
              r.outputTokens || 0,
              r.totalTokens || 0,
              r.costUsd || 0
            );
            totalRecords++;
          }
        })();

        renameSync(join(usageDir, file), join(usageDir, file + ".migrated"));
      } catch (err) {
        console.warn(`[Seed] Error migrating usage/${file}:`, err);
      }
    }

    // Also rename summary.json since it'll be computed from DB now
    const summaryFile = join(usageDir, "summary.json");
    if (existsSync(summaryFile)) {
      renameSync(summaryFile, summaryFile + ".migrated");
    }

    console.log(`[Seed] Migrated ${totalRecords} usage records from ${files.length} files`);
  } catch (err) {
    console.error("[Seed] Error migrating usage:", err);
  }
} else {
  console.log("[Seed] No usage directory found, skipping");
}

console.log("[Seed] Migration complete!");
console.log("[Seed] Original files renamed to *.migrated");
console.log("[Seed] Set FALLBACK_TO_JSON=1 to restore JSON mode if needed");
