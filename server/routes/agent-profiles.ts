import type { AppContext, RouteHandler } from "../types";

export function createAgentProfilesRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON, matchRoute, errorResponse, broadcastToAll } = ctx;

  // --- Prepared statements ---
  const stmts = {
    listProfiles: db.prepare(`SELECT * FROM agent_profiles ORDER BY created_at DESC`),
    getProfile: db.prepare(`SELECT * FROM agent_profiles WHERE id = ?`),
    insertProfile: db.prepare(`
      INSERT INTO agent_profiles (id, name, role, model_preference, max_concurrent_tasks, capabilities, avatar_emoji, status, created_at, updated_at)
      VALUES ($id, $name, $role, $model_preference, $max_concurrent_tasks, $capabilities, $avatar_emoji, $status, $created_at, $updated_at)
    `),
    updateProfile: db.prepare(`
      UPDATE agent_profiles SET name=$name, role=$role, model_preference=$model_preference,
        max_concurrent_tasks=$max_concurrent_tasks, capabilities=$capabilities, avatar_emoji=$avatar_emoji, status=$status,
        identity_template=$identity_template, soul_template=$soul_template, is_board_lead=$is_board_lead, updated_at=$updated_at
      WHERE id=$id
    `),
    deleteProfile: db.prepare(`DELETE FROM agent_profiles WHERE id = ?`),

    // Assignments
    getAssignments: db.prepare(`SELECT * FROM agent_assignments WHERE agent_id = ?`),
    getAssignment: db.prepare(`SELECT * FROM agent_assignments WHERE agent_id = ? AND topic_id = ?`),
    insertAssignment: db.prepare(`
      INSERT INTO agent_assignments (agent_id, topic_id, role, assigned_at)
      VALUES (?, ?, ?, ?)
    `),
    deleteAssignment: db.prepare(`DELETE FROM agent_assignments WHERE agent_id = ? AND topic_id = ?`),

    // Sessions
    getSessionsByAgent: db.prepare(`SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC`),
    getSessionByKey: db.prepare(`SELECT * FROM agent_sessions WHERE session_key = ?`),
    updateSessionStatus: db.prepare(`UPDATE agent_sessions SET status = ?, last_heartbeat = ? WHERE session_key = ?`),
    updateSessionTokens: db.prepare(`UPDATE agent_sessions SET total_tokens = total_tokens + ?, last_heartbeat = ? WHERE session_key = ?`),
    countAllSessions: db.prepare(`SELECT COUNT(*) as total FROM agent_sessions`),

    // Heartbeats
    insertHeartbeat: db.prepare(`
      INSERT INTO heartbeats (session_key, timestamp, status, tokens_used, current_task)
      VALUES (?, ?, ?, ?, ?)
    `),
    cleanOldHeartbeats: db.prepare(`
      DELETE FROM heartbeats WHERE timestamp < datetime('now', '-7 days')
    `),

    // Session timeline (hoisted like everything else here — these were ad-hoc
    // db.prepare() calls inside the GET handler, recompiled per request)
    getHeartbeatsBySessionKey: db.prepare(`SELECT * FROM heartbeats WHERE session_key = ? ORDER BY timestamp ASC`),
    getActionsByAgentInRange: db.prepare(`
      SELECT * FROM agent_actions_log
      WHERE agent_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC
    `),
  };

  function rowToProfile(row: any) {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      modelPreference: row.model_preference || null,
      maxConcurrentTasks: row.max_concurrent_tasks,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      avatarEmoji: row.avatar_emoji,
      status: row.status,
      hasToken: !!row.agent_token_hash,
      isBoardLead: !!row.is_board_lead,
      identityTemplate: row.identity_template || null,
      soulTemplate: row.soul_template || null,
      lastSeenAt: row.last_seen_at || null,
      gatewaySessionId: row.gateway_session_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToAssignment(row: any) {
    return {
      agentId: row.agent_id,
      topicId: row.topic_id,
      role: row.role,
      assignedAt: row.assigned_at,
    };
  }

  function rowToSession(row: any) {
    return {
      id: row.id,
      agentId: row.agent_id,
      sessionKey: row.session_key,
      topicId: row.topic_id,
      status: row.status,
      taskId: row.task_id || null,
      startedAt: row.started_at,
      lastHeartbeat: row.last_heartbeat || null,
      completedAt: row.completed_at || null,
      totalTokens: row.total_tokens,
      errorMessage: row.error_message || null,
    };
  }

  return async function agentProfilesRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // ---- Profiles CRUD ----

    // GET /api/agents/profiles - list all profiles
    if (method === "GET" && pathname === "/api/agents/profiles") {
      const rows = stmts.listProfiles.all() as any[];
      const profiles = rows.map(rowToProfile);

      // Attach assignments to each profile
      for (const profile of profiles) {
        const assignmentRows = stmts.getAssignments.all(profile.id) as any[];
        (profile as any).assignments = assignmentRows.map(rowToAssignment);
      }

      return json({ profiles });
    }

    // POST /api/agents/profiles - create profile
    if (method === "POST" && pathname === "/api/agents/profiles") {
      const body = await readJSON(req);
      if (!body?.name) return errorResponse(400, "name is required");

      const validRoles = ['lead', 'worker', 'specialist'];
      const role = validRoles.includes(body.role) ? body.role : 'worker';

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      try {
        stmts.insertProfile.run({
          $id: id,
          $name: body.name,
          $role: role,
          $model_preference: body.modelPreference || null,
          $max_concurrent_tasks: body.maxConcurrentTasks ?? 1,
          $capabilities: body.capabilities ? JSON.stringify(body.capabilities) : '[]',
          $avatar_emoji: body.avatarEmoji || '\uD83E\uDD16',
          $status: 'available',
          $created_at: now,
          $updated_at: now,
        });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint")) {
          return errorResponse(409, "An agent with that name already exists");
        }
        throw err;
      }

      const row = stmts.getProfile.get(id) as any;
      const profile = rowToProfile(row);
      broadcastToAll({ type: "agent:profile:created", profile });
      return json(profile, 201);
    }

    // GET /api/agents/profiles/:id - get single profile
    {
      const params = matchRoute(pathname, "/api/agents/profiles/:id");
      if (params && method === "GET") {
        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");
        const profile = rowToProfile(row);
        const assignmentRows = stmts.getAssignments.all(params.id) as any[];
        (profile as any).assignments = assignmentRows.map(rowToAssignment);
        return json(profile);
      }

      // PATCH /api/agents/profiles/:id - update profile
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return errorResponse(400, "body required");

        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");

        const validRoles = ['lead', 'worker', 'specialist'];
        const validStatuses = ['available', 'busy', 'paused', 'offline'];
        const now = new Date().toISOString();

        try {
          stmts.updateProfile.run({
            $id: params.id,
            $name: body.name !== undefined ? body.name : row.name,
            $role: body.role !== undefined && validRoles.includes(body.role) ? body.role : row.role,
            $model_preference: body.modelPreference !== undefined ? (body.modelPreference || null) : row.model_preference,
            $max_concurrent_tasks: body.maxConcurrentTasks !== undefined ? body.maxConcurrentTasks : row.max_concurrent_tasks,
            $capabilities: body.capabilities !== undefined ? JSON.stringify(body.capabilities) : row.capabilities,
            $avatar_emoji: body.avatarEmoji !== undefined ? body.avatarEmoji : row.avatar_emoji,
            $status: body.status !== undefined && validStatuses.includes(body.status) ? body.status : row.status,
            $identity_template: body.identityTemplate !== undefined ? body.identityTemplate : (row.identity_template || null),
            $soul_template: body.soulTemplate !== undefined ? body.soulTemplate : (row.soul_template || null),
            $is_board_lead: body.isBoardLead !== undefined ? (body.isBoardLead ? 1 : 0) : (row.is_board_lead || 0),
            $updated_at: now,
          });
        } catch (err: any) {
          if (err.message?.includes("UNIQUE constraint")) {
            return errorResponse(409, "An agent with that name already exists");
          }
          throw err;
        }

        const updated = stmts.getProfile.get(params.id) as any;
        const profile = rowToProfile(updated);
        broadcastToAll({ type: "agent:profile:updated", profile });
        return json(profile);
      }

      // DELETE /api/agents/profiles/:id - delete profile
      if (params && method === "DELETE") {
        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");
        stmts.deleteProfile.run(params.id);
        broadcastToAll({ type: "agent:profile:deleted", profileId: params.id });
        return json({ ok: true });
      }
    }

    // POST /api/agents/profiles/:id/assign - assign to topic
    {
      const params = matchRoute(pathname, "/api/agents/profiles/:id/assign");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.topicId) return errorResponse(400, "topicId is required");

        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");

        const existing = stmts.getAssignment.get(params.id, body.topicId) as any;
        if (existing) return errorResponse(409, "Agent is already assigned to this topic");

        const validRoles = ['lead', 'worker'];
        const assignRole = validRoles.includes(body.role) ? body.role : 'worker';
        const now = new Date().toISOString();

        stmts.insertAssignment.run(params.id, body.topicId, assignRole, now);

        const assignment = { agentId: params.id, topicId: body.topicId, role: assignRole, assignedAt: now };
        broadcastToAll({ type: "agent:assigned", assignment });
        return json(assignment, 201);
      }
    }

    // POST /api/agents/profiles/:id/unassign - unassign from topic
    {
      const params = matchRoute(pathname, "/api/agents/profiles/:id/unassign");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body?.topicId) return errorResponse(400, "topicId is required");

        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");

        stmts.deleteAssignment.run(params.id, body.topicId);
        broadcastToAll({ type: "agent:unassigned", agentId: params.id, topicId: body.topicId });
        return json({ ok: true });
      }
    }

    // GET /api/agents/profiles/:id/sessions - get session history
    {
      const params = matchRoute(pathname, "/api/agents/profiles/:id/sessions");
      if (params && method === "GET") {
        const row = stmts.getProfile.get(params.id) as any;
        if (!row) return errorResponse(404, "Agent profile not found");

        const sessionRows = stmts.getSessionsByAgent.all(params.id) as any[];
        return json({ sessions: sessionRows.map(rowToSession) });
      }
    }

    // GET /api/agents/sessions/:key/timeline - get full timeline for a session
    {
      const params = matchRoute(pathname, "/api/agents/sessions/:key/timeline");
      if (params && method === "GET") {
        const sessionKey = decodeURIComponent(params.key);

        // Look up DB session (optional — may not exist for ephemeral sessions)
        const dbSession = stmts.getSessionByKey.get(sessionKey) as any;

        // Get heartbeats for this session_key
        const heartbeats = stmts.getHeartbeatsBySessionKey.all(sessionKey) as any[];

        // Get agent actions if we have an agent_id and time range
        let actions: any[] = [];
        if (dbSession?.agent_id) {
          const startedAt = dbSession.started_at;
          const endedAt = dbSession.completed_at || new Date().toISOString();
          actions = stmts.getActionsByAgentInRange.all(dbSession.agent_id, startedAt, endedAt) as any[];
        }

        // Build timeline events
        const events: any[] = [];

        // Session start
        if (dbSession) {
          events.push({
            type: "session_start",
            timestamp: dbSession.started_at,
            data: { status: "active", sessionKey },
          });
        }

        // Heartbeats
        for (const hb of heartbeats) {
          events.push({
            type: "heartbeat",
            timestamp: hb.timestamp,
            data: {
              status: hb.status,
              tokensUsed: hb.tokens_used || 0,
              currentTask: hb.current_task || null,
            },
          });
        }

        // Agent actions
        for (const act of actions) {
          events.push({
            type: "action",
            timestamp: act.created_at,
            data: {
              actionType: act.action_type,
              entityType: act.entity_type || null,
              entityId: act.entity_id || null,
              detail: act.detail ? JSON.parse(act.detail) : null,
            },
          });
        }

        // Session end
        if (dbSession?.completed_at) {
          events.push({
            type: "session_end",
            timestamp: dbSession.completed_at,
            data: { status: dbSession.status, errorMessage: dbSession.error_message || null },
          });
        }

        // Sort chronologically
        events.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return json({
          session: dbSession ? rowToSession(dbSession) : null,
          events,
          heartbeatCount: heartbeats.length,
          actionCount: actions.length,
        });
      }
    }

    // GET /api/agents/sessions/history - global session history with filters
    if (method === "GET" && pathname === "/api/agents/sessions/history") {
      const status = url.searchParams.get("status");
      const agentId = url.searchParams.get("agentId");
      const search = url.searchParams.get("search");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);

      // Build dynamic query with filters
      const conditions: string[] = [];
      const params: any[] = [];

      if (status) {
        conditions.push("s.status = ?");
        params.push(status);
      }
      if (agentId) {
        conditions.push("s.agent_id = ?");
        params.push(agentId);
      }
      if (search) {
        conditions.push("(p.name LIKE ? OR s.session_key LIKE ? OR s.error_message LIKE ?)");
        const q = `%${search}%`;
        params.push(q, q, q);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM agent_sessions s LEFT JOIN agent_profiles p ON s.agent_id = p.id ${where}`
      ).get(...params) as any;

      const rows = db.prepare(
        `SELECT s.*, p.name as agent_name, p.avatar_emoji as agent_avatar, p.role as agent_role,
                t.name as topic_name
         FROM agent_sessions s
         LEFT JOIN agent_profiles p ON s.agent_id = p.id
         LEFT JOIN topics t ON s.topic_id = t.id
         ${where}
         ORDER BY s.started_at DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];

      const sessions = rows.map((row: any) => ({
        ...rowToSession(row),
        agentName: row.agent_name || null,
        agentAvatar: row.agent_avatar || null,
        agentRole: row.agent_role || null,
        topicName: row.topic_name || null,
      }));

      return json({ sessions, total: countRow.total, limit, offset });
    }

    // POST /api/agents/sessions/:key/heartbeat - record heartbeat
    {
      const params = matchRoute(pathname, "/api/agents/sessions/:key/heartbeat");
      if (params && method === "POST") {
        const sessionKey = decodeURIComponent(params.key);
        const body = await readJSON(req);
        const now = new Date().toISOString();

        const session = stmts.getSessionByKey.get(sessionKey) as any;
        if (!session) return errorResponse(404, "Session not found");

        // Update session heartbeat. Type-guard every bound value: this is a
        // reporting endpoint hit by external agents/scripts, and bun:sqlite
        // doesn't reject bad bind types cleanly (an array is UNPACKED as extra
        // positional params → sync throw AFTER updateSessionStatus already
        // auto-committed, i.e. a half-written heartbeat + a 500).
        const status = typeof body?.status === "string" && body.status ? body.status : session.status;
        const tokensUsed =
          typeof body?.tokensUsed === "number" && Number.isFinite(body.tokensUsed) && body.tokensUsed > 0
            ? body.tokensUsed
            : 0;
        const currentTask = typeof body?.currentTask === "string" && body.currentTask ? body.currentTask : null;
        stmts.updateSessionStatus.run(status, now, sessionKey);

        // Add tokens if provided
        if (tokensUsed > 0) {
          stmts.updateSessionTokens.run(tokensUsed, now, sessionKey);
        }

        // Insert heartbeat record
        stmts.insertHeartbeat.run(
          sessionKey,
          now,
          status,
          tokensUsed,
          currentTask
        );

        // Periodically clean old heartbeats
        if (Math.random() < 0.1) {
          stmts.cleanOldHeartbeats.run();
        }

        return json({ ok: true, timestamp: now });
      }
    }

    // POST /api/agents/sessions/:key/pause - pause agent session
    {
      const params = matchRoute(pathname, "/api/agents/sessions/:key/pause");
      if (params && method === "POST") {
        const sessionKey = decodeURIComponent(params.key);
        const now = new Date().toISOString();

        const session = stmts.getSessionByKey.get(sessionKey) as any;
        if (!session) return errorResponse(404, "Session not found");
        if (session.status === 'paused') return errorResponse(400, "Session is already paused");
        if (session.status === 'completed' || session.status === 'error') {
          return errorResponse(400, "Cannot pause a finished session");
        }

        stmts.updateSessionStatus.run('paused', now, sessionKey);

        // Update the agent profile status if linked
        if (session.agent_id) {
          db.prepare(`UPDATE agent_profiles SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, session.agent_id);
          const profileRow = stmts.getProfile.get(session.agent_id) as any;
          if (profileRow) {
            broadcastToAll({ type: "agent:profile:updated", profile: rowToProfile(profileRow) });
          }
        }

        broadcastToAll({ type: "agent:session:paused", sessionKey });
        return json({ ok: true, status: 'paused' });
      }
    }

    // POST /api/agents/sessions/:key/resume - resume agent session
    {
      const params = matchRoute(pathname, "/api/agents/sessions/:key/resume");
      if (params && method === "POST") {
        const sessionKey = decodeURIComponent(params.key);
        const now = new Date().toISOString();

        const session = stmts.getSessionByKey.get(sessionKey) as any;
        if (!session) return errorResponse(404, "Session not found");
        if (session.status !== 'paused') return errorResponse(400, "Session is not paused");

        stmts.updateSessionStatus.run('active', now, sessionKey);

        // Update the agent profile status if linked
        if (session.agent_id) {
          db.prepare(`UPDATE agent_profiles SET status = 'busy', updated_at = ? WHERE id = ?`).run(now, session.agent_id);
          const profileRow = stmts.getProfile.get(session.agent_id) as any;
          if (profileRow) {
            broadcastToAll({ type: "agent:profile:updated", profile: rowToProfile(profileRow) });
          }
        }

        broadcastToAll({ type: "agent:session:resumed", sessionKey });
        return json({ ok: true, status: 'active' });
      }
    }

    return null;
  };
}
