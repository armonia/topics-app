import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

export interface SpaceMember {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  invitedAt: string;
  joinedAt?: string;
  status: 'active' | 'pending';
}

export interface SpaceInvite {
  code: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  createdAt: string;
  settings: {
    defaultModel?: string;
    theme?: 'light' | 'dark' | 'system';
  };
  members: SpaceMember[];
  invites: SpaceInvite[];
}

interface SpacesData {
  spaces: Space[];
  currentSpaceId: string;
}

function getSpacesFile(baseDir: string): string {
  return join(baseDir, "spaces.json");
}

function loadSpaces(baseDir: string): SpacesData {
  const file = getSpacesFile(baseDir);
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {}
  // Return empty — no auto-creation, user must create spaces explicitly
  return { spaces: [], currentSpaceId: "" };
}

function saveSpaces(baseDir: string, data: SpacesData): void {
  const file = getSpacesFile(baseDir);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// slugify lives in server/utils.ts and is exposed via AppContext.

export function createSpacesRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, slugify } = ctx;
  const baseDir = ctx.STATE_DIR;

  return async (req, url, pathname, method) => {
    // GET /api/spaces
    if (pathname === "/api/spaces" && method === "GET") {
      const data = loadSpaces(baseDir);
      return json(data.spaces);
    }

    // GET /api/spaces/current
    if (pathname === "/api/spaces/current" && method === "GET") {
      const data = loadSpaces(baseDir);
      const current = data.spaces.find(s => s.id === data.currentSpaceId) || data.spaces[0];
      return json({ currentSpaceId: data.currentSpaceId, space: current });
    }

    // POST /api/spaces
    if (pathname === "/api/spaces" && method === "POST") {
      const body = await readJSON(req);
      if (!body?.name) return errorResponse(400, "Name is required");
      const data = loadSpaces(baseDir);
      const space: Space = {
        id: crypto.randomUUID(),
        name: body.name,
        slug: slugify(body.name),
        logo: body.logo || undefined,
        createdAt: new Date().toISOString(),
        settings: body.settings || {},
        members: body.members || [],
        invites: [],
      };
      data.spaces.push(space);
      saveSpaces(baseDir, data);
      return json(space, 201);
    }

    // PUT /api/spaces/:id
    const putMatch = matchRoute(pathname, "/api/spaces/:id");
    if (putMatch && method === "PUT") {
      const body = await readJSON(req);
      const data = loadSpaces(baseDir);
      const space = data.spaces.find(s => s.id === putMatch.id);
      if (!space) return errorResponse(404, "Space not found");
      if (body.name) { space.name = body.name; space.slug = slugify(body.name); }
      if (body.logo !== undefined) space.logo = body.logo;
      if (body.settings) space.settings = { ...space.settings, ...body.settings };
      if (body.currentSpaceId) data.currentSpaceId = putMatch.id;
      saveSpaces(baseDir, data);
      return json(space);
    }

    // PUT /api/spaces/current (switch space)
    if (pathname === "/api/spaces/current" && method === "PUT") {
      const body = await readJSON(req);
      if (!body?.spaceId) return errorResponse(400, "spaceId is required");
      const data = loadSpaces(baseDir);
      const space = data.spaces.find(s => s.id === body.spaceId);
      if (!space) return errorResponse(404, "Space not found");
      data.currentSpaceId = body.spaceId;
      saveSpaces(baseDir, data);
      return json({ currentSpaceId: data.currentSpaceId, space });
    }

    // DELETE /api/spaces/:id
    if (putMatch && method === "DELETE") {
      const data = loadSpaces(baseDir);
      if (data.spaces.length <= 1) return errorResponse(400, "Cannot delete the last space");
      data.spaces = data.spaces.filter(s => s.id !== putMatch.id);
      if (data.currentSpaceId === putMatch.id) data.currentSpaceId = data.spaces[0].id;
      saveSpaces(baseDir, data);
      return json({ success: true });
    }

    // GET /api/spaces/:id/members
    const membersMatch = matchRoute(pathname, "/api/spaces/:id/members");
    if (membersMatch && method === "GET") {
      const data = loadSpaces(baseDir);
      const space = data.spaces.find(s => s.id === membersMatch.id);
      if (!space) return errorResponse(404, "Space not found");
      return json(space.members);
    }

    // POST /api/spaces/:id/invites
    const invitesMatch = matchRoute(pathname, "/api/spaces/:id/invites");
    if (invitesMatch && method === "POST") {
      const body = await readJSON(req);
      const data = loadSpaces(baseDir);
      const space = data.spaces.find(s => s.id === invitesMatch.id);
      if (!space) return errorResponse(404, "Space not found");
      const invite: SpaceInvite = {
        code: crypto.randomUUID().slice(0, 8),
        createdBy: body?.createdBy || "owner",
        createdAt: new Date().toISOString(),
        expiresAt: body?.expiresAt,
        maxUses: body?.maxUses,
        uses: 0,
      };
      space.invites.push(invite);
      saveSpaces(baseDir, data);
      return json(invite, 201);
    }

    // DELETE /api/spaces/:id/invites/:code
    const revokeMatch = matchRoute(pathname, "/api/spaces/:id/invites/:code");
    if (revokeMatch && method === "DELETE") {
      const data = loadSpaces(baseDir);
      const space = data.spaces.find(s => s.id === revokeMatch.id);
      if (!space) return errorResponse(404, "Space not found");
      space.invites = space.invites.filter(i => i.code !== revokeMatch.code);
      saveSpaces(baseDir, data);
      return json({ success: true });
    }

    return null;
  };
}
