import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Message } from "./apiClient";

// ── Rust binary session JSONL format ──
// Line 1: {"type":"session_meta","session_id":"...","created_at_ms":N,"updated_at_ms":N,"version":1}
// Further: {"type":"message","message":{"role":"user"|"assistant","blocks":[{"type":"text","text":"..."}|{"type":"tool_use",...}|...]}}

interface RustSessionMeta {
  type: "session_meta";
  session_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  version: number;
}

interface RustBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface RustMessage {
  type: "message";
  message: {
    role: string;
    blocks: RustBlock[];
  };
}

type RustEntry = RustSessionMeta | RustMessage | { type: string };

function extractText(blocks: RustBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

/** Like extractText but strips workspace context prefix for clean previews */
function extractUserTextFromBlocks(blocks: RustBlock[]): string {
  const raw = extractText(blocks);
  const marker = "## Workspace Structure";
  const idx = raw.indexOf(marker);
  if (idx === -1) return raw;
  const afterCtx = raw.indexOf("\n\n", idx + marker.length);
  return afterCtx === -1 ? raw : raw.slice(afterCtx + 2).trim();
}

// ── Workspace registry — persists all known workspaces in ~/.milo/workspaces.json ──
const MILO_DIR = path.join(os.homedir(), ".milo");
const WORKSPACES_FILE = path.join(MILO_DIR, "workspaces.json");

function registerWorkspace(dir: string): void {
  let list: string[] = [];
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      list = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8")) as string[];
    }
  } catch { /* ignore */ }
  const idx = list.indexOf(dir);
  if (idx !== -1) list.splice(idx, 1);
  list.unshift(dir); // Most recent first
  list = list.slice(0, 50);
  try {
    if (!fs.existsSync(MILO_DIR)) fs.mkdirSync(MILO_DIR, { recursive: true });
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2));
  } catch { /* ignore */ }
}

function getRegisteredWorkspaces(): string[] {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      return (JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8")) as string[])
        .filter((d) => fs.existsSync(d));
    }
  } catch { /* ignore */ }
  return [];
}

// ── Public types ──

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  filePath: string;
  workspacePath: string;
  workspaceName: string;
}

// ── SessionStore — reads Rust binary sessions from <workspace>/.claw/sessions/ ──

export class SessionStore {
  private workspaceDir: string | null = null;
  private currentSessionId: string | null = null;

  setWorkspace(dir: string): void {
    this.workspaceDir = dir;
    this.currentSessionId = null;
    registerWorkspace(dir);
  }

  private sessionsDir(): string {
    if (this.workspaceDir) {
      return path.join(this.workspaceDir, ".claw", "sessions");
    }
    // Fallback — try to find via cwd
    return path.join(process.cwd(), ".claw", "sessions");
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** List all sessions from all known workspaces, newest first */
  listSessions(): SessionMeta[] {
    // Always include current workspace + all registered ones
    const allWorkspaces = getRegisteredWorkspaces();
    if (this.workspaceDir && !allWorkspaces.includes(this.workspaceDir)) {
      allWorkspaces.unshift(this.workspaceDir);
    }

    const allSessions: SessionMeta[] = [];

    for (const wsDir of allWorkspaces) {
      const dir = path.join(wsDir, ".claw", "sessions");
      if (!fs.existsSync(dir)) continue;
      const workspaceName = path.basename(wsDir);

      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const f of files) {
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const id = `${wsDir}::${f.replace(".jsonl", "")}`;  // unique across workspaces

        let preview = "";
        let messageCount = 0;
        let createdMs = stat.birthtimeMs;
        let updatedMs = stat.mtimeMs;

        try {
          for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
            if (!line.trim()) continue;
            const entry = JSON.parse(line) as RustEntry;
            if (entry.type === "session_meta") {
              const m = entry as RustSessionMeta;
              createdMs = m.created_at_ms;
              updatedMs = m.updated_at_ms;
            } else if (entry.type === "message") {
              const msg = (entry as RustMessage).message;
              messageCount++;
              if (!preview && msg.role === "user") {
                preview = extractUserTextFromBlocks(msg.blocks).slice(0, 80);
              }
            }
          }
        } catch { /* ignore */ }

        if (messageCount === 0) continue;
        allSessions.push({
          id,
          createdAt: new Date(createdMs).toISOString(),
          updatedAt: new Date(updatedMs).toISOString(),
          messageCount,
          preview,
          filePath,
          workspacePath: wsDir,
          workspaceName,
        });
      }
    }

    // Sort all sessions newest first
    return allSessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /** Resolve filePath from composite id (wsDir::sessionId) or plain sessionId */
  private resolveFilePath(sessionId: string): string {
    if (sessionId.includes("::")) {
      const sep = sessionId.indexOf("::");
      const wsDir = sessionId.slice(0, sep);
      const sid = sessionId.slice(sep + 2);
      return path.join(wsDir, ".claw", "sessions", `${sid}.jsonl`);
    }
    return path.join(this.sessionsDir(), `${sessionId}.jsonl`);
  }

  /** Load messages from a session (for UI replay) */
  load(sessionId: string): Message[] {
    const filePath = this.resolveFilePath(sessionId);
    if (!fs.existsSync(filePath)) return [];

    const messages: Message[] = [];
    try {
      for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as RustEntry;
        if (entry.type === "message") {
          const msg = (entry as RustMessage).message;
          const text = extractText(msg.blocks);
          if (text) {
            messages.push({
              role: msg.role as "user" | "assistant",
              content: [{ type: "text", text }],
            });
          }
        }
      }
    } catch { /* ignore */ }

    this.currentSessionId = sessionId;
    return messages;
  }

  /** Delete a session file */
  delete(sessionId: string): void {
    const filePath = this.resolveFilePath(sessionId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  newSession(): string {
    this.currentSessionId = null;
    return "";
  }
}
