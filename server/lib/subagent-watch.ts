/**
 * Il recapito dei risultati dei sub-agent nella chat che li ha lanciati.
 *
 * ── Perché è un modulo ──────────────────────────────────────────────────────
 * Viveva dentro la closure di `createTopicsRouter`: trecento righe con uno
 * STATO PROPRIO (la mappa delle sessioni osservate, il timer del polling, il
 * cursore in byte per file) in un file di rotte, senza avere niente a che fare
 * col routing. Chiuso lì dentro non era testabile in nessun modo — non si
 * poteva far avanzare un giro di polling, né dargli un transcript finto, né
 * verificare le guardie di rotazione. Ed è codice che vive proprio di quelle:
 * cursore incrementale, cambio di inode, troncamento, riscrittura a pari
 * dimensione, riga finale a metà da riavvolgere. Roba che si rompe in silenzio
 * e si scopre da un messaggio che non arriva.
 *
 * ── Le due strade ───────────────────────────────────────────────────────────
 * Un sub-agent può finire in due modi diversi, e servono entrambi:
 *
 *  A. **Task() nativo del gateway** — il gateway scrive un «[Internal task
 *     completion event]» nel JSONL della sessione PADRE. Qui lo si scopre
 *     leggendo quel file a intervalli, solo i byte nuovi.
 *
 *  B. **`spawn_agent` via MCP** — è un PTY `claude` separato, col SUO
 *     transcript: nel JSONL del padre non compare mai niente, quindi la strada
 *     A non lo vedrebbe. Quando quel PTY esce, `terminal.ts` chiama
 *     `deliverExit`, e la chat padre riceve comunque il risultato invece di
 *     restare appesa a una promessa che nessuno può mantenere.
 *
 * La registrazione dell'handler della strada B resta a carico del chiamante
 * (`setSubAgentExitHandler`), così questo modulo non importa `routes/terminal`
 * e il confine resta a senso unico.
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Topic, StoredMessage } from "../types";
import type { AIProvider } from "../providers";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { formatSubAgentExitMessage, formatSubAgentExitBody, type SubAgentExitInfo } from "../routes/subagent-exit";

/** Una sessione padre sorvegliata, col cursore di lettura del suo transcript. */
interface WatchedSession {
  topicId: string;
  /** e.g. "topic:d1428015" */
  sessionKey: string;
  /** path del file JSONL; "" finché non lo si trova */
  jsonlPath: string;
  /** byte già consumati (cursore incrementale) */
  byteOffset: number;
  /** inode all'ultima lettura (guardia di rotazione) */
  lastIno: number;
  /** mtime all'ultima lettura (guardia di riscrittura a pari dimensione) */
  lastMtimeMs: number;
  createdAt: number;
  /** session_key dei risultati già recapitati */
  deliveredEvents: Set<string>;
}

export interface SubagentWatchDeps {
  gatewayUrl: string;
  gatewayToken: string;
  getTopicById: (id: string) => Topic | null;
  getTopicBySessionKey: (sessionKey: string) => Topic | null;
  saveSingleTopic: (topic: Topic) => void;
  appendLocalMessage: (
    sessionKey: string,
    role: "user" | "assistant",
    content: string,
  ) => StoredMessage;
  broadcastToAll: (message: OutboundMessage) => void;
  bumpUnread: (topicId: string) => void;
  resolveProvider: (topic?: Topic | null) => AIProvider;
  /** Cartella dei transcript. Iniettabile perché i test ne usino una finta. */
  transcriptDir?: string;
  /** Intervallo del polling. Iniettabile per non far aspettare 5s a un test. */
  pollIntervalMs?: number;
  /** Dopo quanto si smette di sorvegliare una sessione. */
  watchTimeoutMs?: number;
}

export interface SubagentWatcher {
  /** Comincia a sorvegliare il transcript di una sessione padre (strada A). */
  watch: (topicId: string, sessionKey: string) => void;
  /** Recapita il risultato di un PTY figlio appena uscito (strada B). */
  deliverExit: (info: SubAgentExitInfo) => void;
  /** Un giro di polling, subito: è il gancio con cui i test scavalcano il timer. */
  pollOnce: () => void;
  /** Quante sessioni sono sorvegliate ora. */
  watchedCount: () => number;
  /** Ferma il timer (shutdown, e fine di un test). */
  stop: () => void;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WATCH_TIMEOUT_MS = 30 * 60_000;

/** Il testo di un `content` che può essere una stringa o un array di blocchi. */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string }) => c?.type === "text")
      .map((c: { text?: string }) => c?.text ?? "")
      .join("\n");
  }
  return "";
}

export function createSubagentWatcher(deps: SubagentWatchDeps): SubagentWatcher {
  const transcriptDir = deps.transcriptDir ?? join(homedir(), ".openclaw", "agents", "main", "sessions");
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const watchTimeoutMs = deps.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;

  const watchedSessions = new Map<string, WatchedSession>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(): void {
    if (pollTimer) return;
    console.log(`[SubagentPoll] Starting JSONL polling (${watchedSessions.size} watched sessions)`);
    pollTimer = setInterval(poll, pollIntervalMs);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    console.log(`[SubagentPoll] Stopped polling`);
  }

  /**
   * Il JSONL di una sessione. I file si chiamano `<sessionId>-<slug>.jsonl`,
   * quindi il match sul nome è la strada veloce; il ripiego apre i dieci più
   * recenti e ne guarda la prima riga, per quando il nome non porta lo slug.
   */
  function findSessionJSONL(sessionKey: string): string | null {
    if (!existsSync(transcriptDir)) return null;
    const keySlug = sessionKey.replace(/:/g, "-");
    const files = readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl") && f.includes(keySlug));
    if (files.length > 0) return join(transcriptDir, files[0]);
    const recent = readdirSync(transcriptDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(transcriptDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);
    for (const f of recent) {
      try {
        const first = readFileSync(join(transcriptDir, f.name), "utf-8").split("\n")[0];
        if (first.includes(sessionKey)) return join(transcriptDir, f.name);
      } catch { /* file sparito fra readdir e read */ }
    }
    return null;
  }

  function poll(): void {
    for (const [sk, watched] of watchedSessions.entries()) {
      if (Date.now() - watched.createdAt > watchTimeoutMs) {
        console.log(`[SubagentPoll] Timeout watching ${sk}`);
        watchedSessions.delete(sk);
        continue;
      }
      if (!watched.jsonlPath) {
        const found = findSessionJSONL(sk);
        if (found) watched.jsonlPath = found;
        else continue;
      }
      if (!existsSync(watched.jsonlPath)) continue;

      try {
        // Lettura incrementale: solo i byte aggiunti dall'ultimo giro, così il
        // costo è O(dati nuovi) e non O(transcript intero) a ogni tick.
        let st: ReturnType<typeof statSync>;
        try { st = statSync(watched.jsonlPath); } catch { continue; }
        // Rotazione/troncamento: inode diverso, dimensione scesa sotto il
        // cursore, oppure riscrittura a dimensione uguale-o-minore con mtime
        // più recente → si riparte da 0.
        const inoChanged = watched.lastIno !== 0 && st.ino !== watched.lastIno;
        const truncated = st.size < watched.byteOffset;
        const rewriteSameSize =
          watched.lastMtimeMs !== 0 && st.mtimeMs > watched.lastMtimeMs && st.size <= watched.byteOffset;
        if (inoChanged || truncated || rewriteSameSize) watched.byteOffset = 0;
        watched.lastIno = st.ino;
        watched.lastMtimeMs = st.mtimeMs;
        if (st.size === watched.byteOffset) continue; // niente di nuovo

        const length = st.size - watched.byteOffset;
        const buf = Buffer.alloc(length);
        let fd: number | null = null;
        try {
          fd = openSync(watched.jsonlPath, "r");
          readSync(fd, buf, 0, length, watched.byteOffset);
        } finally {
          if (fd != null) { try { closeSync(fd); } catch { /* già chiuso */ } }
        }
        watched.byteOffset = st.size;
        const text = buf.toString("utf-8");
        const newLines = text.split("\n");
        // Una riga finale a metà (senza newline) si riavvolge, così al giro
        // dopo si rilegge intera invece di darla in pasto a JSON.parse monca.
        if (newLines.length > 0 && !text.endsWith("\n")) {
          const partial = newLines.pop()!;
          watched.byteOffset -= Buffer.byteLength(partial, "utf-8");
        }

        for (const line of newLines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry.message || entry;
            const textContent = extractTextContent(msg.content);
            if (!textContent.includes("[Internal task completion event]")) continue;

            const skMatch = textContent.match(/session_key:\s*(agent:\S+)/);
            const childSk = skMatch?.[1] || textContent.slice(0, 50);
            if (watched.deliveredEvents.has(childSk)) continue;
            watched.deliveredEvents.add(childSk);

            const resultMatch = textContent.match(
              /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>([\s\S]*?)<<<END_UNTRUSTED_CHILD_RESULT>>>/,
            );
            const result = resultMatch?.[1]?.trim() || "(sub-agent completed, no output recovered)";
            const taskMatch = textContent.match(/task:\s*(.+)/);
            const task = taskMatch?.[1]?.trim() || "";

            console.log(`[SubagentPoll] Found completion event for ${childSk.slice(0, 40)} in ${sk}`);
            // L'evento è già nel contesto del gateway: basta innescare un turno
            // perché l'AI legga il risultato e lo presenti all'utente.
            void triggerGatewayInference(watched, result, task);
          } catch { /* riga non-JSON o senza i campi attesi */ }
        }
      } catch (err) {
        console.warn(`[SubagentPoll] Error reading ${watched.jsonlPath}:`, err);
      }
    }
    if (watchedSessions.size === 0) stopPolling();
  }

  async function triggerGatewayInference(watched: WatchedSession, result: string, task: string): Promise<void> {
    const topic = deps.getTopicById(watched.topicId);
    const provider = deps.resolveProvider(topic);
    if (provider.name !== "openclaw") {
      // `/api/inference/chat` è specifico di OpenClaw: con gli altri provider si
      // consegna il risultato grezzo, che è comunque meglio del silenzio.
      deliverRawResult(watched, result, task);
      return;
    }
    try {
      const resp = await fetch(`${deps.gatewayUrl}/api/inference/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.gatewayToken}`,
          "x-openclaw-scopes": "operator.read,operator.write",
        },
        body: JSON.stringify({
          sessionKey: watched.sessionKey,
          messages: [
            { role: "user", content: `[System: sub-agent completed. Present the result to the user naturally.]` },
          ],
        }),
      });
      if (!resp.ok) {
        console.warn(`[SubagentPoll] Gateway inference failed (${resp.status}), delivering raw result`);
        deliverRawResult(watched, result, task);
        return;
      }
      const reader = resp.body?.getReader();
      if (!reader) { deliverRawResult(watched, result, task); return; }

      let fullContent = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
          } catch { /* keep-alive o frame non-JSON */ }
        }
      }

      if (fullContent) {
        deliverMessage(watched.sessionKey, watched.topicId, fullContent, fullContent.slice(0, 100));
        console.log(`[SubagentPoll] ✓ Delivered AI-formatted result → topic ${watched.topicId.slice(0, 8)}`);
      } else {
        deliverRawResult(watched, result, task);
      }
    } catch (err) {
      console.warn(`[SubagentPoll] Inference error:`, err);
      deliverRawResult(watched, result, task);
    }
  }

  function deliverRawResult(watched: WatchedSession, result: string, task: string): void {
    const msgContent = `📋 **Sub-agent result${task ? ` (${task.slice(0, 80)})` : ""}:**\n\n${result}`;
    deliverMessage(watched.sessionKey, watched.topicId, msgContent, result.slice(0, 100));
    console.log(`[SubagentPoll] ✓ Delivered raw result → topic ${watched.topicId.slice(0, 8)}`);
  }

  /** Appende, annuncia, e conta il non-letto: i tre passi sono sempre insieme. */
  function deliverMessage(sessionKey: string, topicId: string, content: string, preview: string): void {
    const stored = deps.appendLocalMessage(sessionKey, "assistant", content);
    deps.broadcastToAll({
      type: "message:new",
      sessionKey,
      topicId,
      role: "assistant",
      messageId: stored.id,
      content,
      preview,
    } as OutboundMessage);
    deps.bumpUnread(topicId);
  }

  function watch(topicId: string, sessionKey: string): void {
    const already = watchedSessions.get(sessionKey);
    if (already) {
      already.createdAt = Date.now(); // rimanda la scadenza
      return;
    }
    const jsonlPath = findSessionJSONL(sessionKey) || "";
    // Si parte dalla fine del file: la storia già scritta non va riprocessata,
    // solo ciò che arriva da adesso in poi.
    let byteOffset = 0, lastIno = 0, lastMtimeMs = 0;
    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        const st = statSync(jsonlPath);
        byteOffset = st.size; lastIno = st.ino; lastMtimeMs = st.mtimeMs;
      } catch { /* sparito fra l'esistenza e lo stat */ }
    }
    watchedSessions.set(sessionKey, {
      topicId, sessionKey, jsonlPath, byteOffset, lastIno, lastMtimeMs,
      createdAt: Date.now(), deliveredEvents: new Set(),
    });
    console.log(
      `[SubagentPoll] Watching ${sessionKey} for sub-agent completions ` +
        `(JSONL: ${jsonlPath ? "found" : "pending"}, offset: ${byteOffset})`,
    );
    startPolling();
  }

  const deliveredExits = new Set<string>(); // childId, contro le uscite doppie

  function deliverExit(info: SubAgentExitInfo): void {
    if (!info.parentSessionKey.startsWith("topic:")) return;
    if (deliveredExits.has(info.childId)) return;
    deliveredExits.add(info.childId);
    const topic = deps.getTopicBySessionKey(info.parentSessionKey);
    if (!topic) return;
    const body = formatSubAgentExitBody(info);
    const content = formatSubAgentExitMessage(info);
    // NON si usa `deliverMessage` qui: l'ordine dei broadcast è quello
    // originale e va tenuto — `unread:updated` arriva DOPO `topic:updated`, non
    // prima. Sono due messaggi che il client applica in sequenza, e invertirli
    // è il genere di modifica che si scopre da un badge che non compare.
    const stored = deps.appendLocalMessage(info.parentSessionKey, "assistant", content);
    deps.broadcastToAll({
      type: "message:new",
      sessionKey: info.parentSessionKey,
      topicId: topic.id,
      role: "assistant",
      messageId: stored.id,
      content,
      preview: body.slice(0, 100),
    } as OutboundMessage);
    // Rinfresca `lastActivity` nella sidebar, così la riga non sembra congelata
    // — stessa finalizzazione che fanno i turni di chat.
    topic.updatedAt = new Date().toISOString();
    deps.saveSingleTopic(topic);
    deps.broadcastToAll({ type: "topic:updated", topic } as OutboundMessage);
    deps.bumpUnread(topic.id);
    console.log(`[SubagentExit] Delivered result of "${info.name}" → topic ${topic.id.slice(0, 8)}`);
  }

  return {
    watch,
    deliverExit,
    pollOnce: poll,
    watchedCount: () => watchedSessions.size,
    stop: stopPolling,
  };
}
