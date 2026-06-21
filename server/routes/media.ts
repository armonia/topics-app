import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { AppContext, RouteHandler } from "../types";

/**
 * Media + file/upload I/O endpoints — serving project media and handling
 * file/base64/context uploads. Split out of the topics.ts chat god-file: pure
 * filesystem I/O, fully self-contained on ctx members (json/readJSON, the
 * UPLOADS_DIR/CONTEXT_DIR/ALLOWED_UPLOAD_MIMES config, the path allowlist
 * helpers, getTopicById/saveSingleTopic) + stdlib. No chat/provider coupling.
 */
export function createMediaRouter(ctx: AppContext): RouteHandler {
  const {
    json, readJSON, getTopicById, saveSingleTopic,
    isPathAllowed, resolveProjectPath, getMimeType,
    UPLOADS_DIR, CONTEXT_DIR, ALLOWED_UPLOAD_MIMES,
  } = ctx;

  return async function mediaRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Media serving ---
    if (method === "GET" && pathname === "/api/media") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "path parameter required" }, 400);
      // Prefer the media allowlist for cacheable project media; fall back to
      // resolveProjectPath so sibling images of any openable MD file load.
      // Symmetric with /api/files/content which also uses resolveProjectPath.
      let resolved = isPathAllowed(resolve(filePath)) ? resolve(filePath) : resolveProjectPath(filePath);
      if (!resolved) return json({ error: "forbidden: invalid path" }, 403);
      if (!existsSync(resolved)) return new Response("Not Found", { status: 404 });
      const file = Bun.file(resolved);
      const contentType = getMimeType(resolved);
      return new Response(file, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" } });
    }

    // --- Base64 image upload ---
    if (method === "POST" && pathname === "/api/upload-image") {
      try {
        const body = await readJSON(req);
        if (!body?.dataUrl || !body?.mimeType) return json({ error: "dataUrl and mimeType required" }, 400);
        const { dataUrl, mimeType } = body;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return json({ error: "Invalid data URL format" }, 400);
        const ext = mimeType === "image/png" ? "png" : "jpg";
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${Date.now()}-paste.${ext}`;
        const filepath = join(UPLOADS_DIR, filename);
        // Cap the payload like /api/upload and /api/context-upload do (10MB) —
        // this base64 path had no size limit, so a huge dataUrl was decoded into
        // memory and written straight to disk (asymmetric memory/disk-fill).
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
        const b64 = match[2];
        // base64 inflates ~4:3 — cheap pre-decode guard before buffering.
        if (b64.length > MAX_UPLOAD_SIZE * 1.4) return json({ error: "Image too large. Maximum size is 10MB." }, 413);
        const buffer = Buffer.from(b64, "base64");
        if (buffer.byteLength > MAX_UPLOAD_SIZE) return json({ error: "Image too large. Maximum size is 10MB." }, 413);
        writeFileSync(filepath, buffer);
        return json({ url: filepath });
      } catch (err: any) { return json({ error: "Image upload failed: " + err.message }, 500); }
    }

    // --- File upload ---
    if (method === "POST" && pathname === "/api/upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    // --- Context file deletion ---
    if (method === "DELETE" && pathname === "/api/context-file") {
      const body = await readJSON(req);
      if (!body?.topicId || !body?.filePath) return json({ error: "topicId and filePath required" }, 400);
      const topic = getTopicById(body.topicId);
      if (!topic) return json({ error: "not found" }, 404);
      topic.contextFiles = (topic.contextFiles || []).filter(f => f !== body.filePath);
      topic.updatedAt = new Date().toISOString();
      saveSingleTopic(topic);
      return json({ ok: true });
    }

    // --- Context file upload ---
    if (method === "POST" && pathname === "/api/context-upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        const topicId = formData.get("topicId") as string;
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        if (!topicId) return json({ error: "topicId required" }, 400);
        const fileType = (file as File).type;
        if (!ALLOWED_UPLOAD_MIMES.has(fileType)) return json({ error: `File type not allowed: ${fileType}. Allowed types: text, documents, images, audio.` }, 400);
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
        if ((file as File).size > MAX_UPLOAD_SIZE) return json({ error: "File too large. Maximum size is 10MB." }, 400);
        const topicDir = join(CONTEXT_DIR, topicId);
        mkdirSync(topicDir, { recursive: true });
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(topicDir, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        const topic = getTopicById(topicId);
        if (topic) {
          if (!topic.contextFiles) topic.contextFiles = [];
          topic.contextFiles.push(filepath);
          topic.updatedAt = new Date().toISOString();
          saveSingleTopic(topic);
        }
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    return null;
  };
}
