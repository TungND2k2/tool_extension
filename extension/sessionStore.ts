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

// ── ~/.milo/sessions/ — central session storage (never inside the workspace) ──
const MILO_DIR = path.join(os.homedir(), ".milo");
const MILO_SESSIONS_DIR = path.join(MILO_DIR, "sessions");

/**
 * Find the session directory for a workspace by scanning for workspace-path.txt files.
 * The Rust binary writes `workspace-path.txt` inside each slug dir when it creates it,
 * so TypeScript doesn't need to replicate the Rust hash algorithm.
 * Falls back to creating a new dir using a simple slug if Rust hasn't run yet.
 */
function miloSessionsDir(workspaceAbsPath: string): string {
  try { fs.mkdirSync(MILO_SESSIONS_DIR, { recursive: true }); } catch { /* ignore */ }

  // Try to find an existing slug dir that Rust already created for this workspace
  try {
    for (const slug of fs.readdirSync(MILO_SESSIONS_DIR)) {
      const slugDir = path.join(MILO_SESSIONS_DIR, slug);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      const marker = path.join(slugDir, "workspace-path.txt");
      if (fs.existsSync(marker)) {
        const stored = fs.readFileSync(marker, "utf-8").trim();
        if (stored === workspaceAbsPath) return slugDir;
      }
    }
  } catch { /* ignore */ }

  // Rust hasn't created one yet — create a placeholder dir and write the marker
  // so Rust can find it (Rust checks for existing dirs before creating new ones).
  const name = path.basename(workspaceAbsPath);
  // Use a simple counter-based slug to avoid hash algorithm mismatches
  const slug = `${name}-ts`;
  const dir = path.join(MILO_SESSIONS_DIR, slug);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, "workspace-path.txt");
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, workspaceAbsPath);
    }
  } catch { /* ignore */ }
  return dir;
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

// ── SessionStore — reads Rust binary sessions from ~/.milo/sessions/<workspace-slug>/ ──

export class SessionStore {
  private workspaceDir: string | null = null;
  private currentSessionId: string | null = null;

  setWorkspace(dir: string): void {
    this.workspaceDir = dir;
    this.currentSessionId = null;
    // Ensure the sessions dir exists for this workspace
    miloSessionsDir(dir);
  }

  private sessionsDir(): string {
    const base = this.workspaceDir ?? process.cwd();
    return miloSessionsDir(base);
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * List sessions for the CURRENT workspace only, newest first.
   * Like Claude: each project has its own isolated chat history.
   */
  listSessions(): SessionMeta[] {
    const dir = this.sessionsDir();
    const workspacePath = this.workspaceDir ?? process.cwd();
    const workspaceName = path.basename(workspacePath);

    if (!fs.existsSync(dir)) return [];

    const sessions: SessionMeta[] = [];

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    for (const f of files) {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      const sessionId = f.replace(".jsonl", "");
      // slug is derived from the dir name (last path segment)
      const slug = path.basename(dir);
      const id = `${slug}::${sessionId}`;

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
      sessions.push({
        id,
        createdAt: new Date(createdMs).toISOString(),
        updatedAt: new Date(updatedMs).toISOString(),
        messageCount,
        preview,
        filePath,
        workspacePath,
        workspaceName,
      });
    }

    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /** Resolve filePath from composite id (slug::sessionId) or plain sessionId */
  private resolveFilePath(sessionId: string): string {
    if (sessionId.includes("::")) {
      const sep = sessionId.indexOf("::");
      const slug = sessionId.slice(0, sep);
      const sid = sessionId.slice(sep + 2);
      return path.join(MILO_SESSIONS_DIR, slug, `${sid}.jsonl`);
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
