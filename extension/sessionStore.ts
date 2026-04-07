import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Message } from "./apiClient";

const MILO_DIR = path.join(os.homedir(), ".milo");
const SESSIONS_DIR = path.join(MILO_DIR, "sessions");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nowMs(): number {
  return Date.now();
}

// ── Session entry types (each line in .jsonl) ──

interface SessionHeader {
  type: "session";
  session_id: string;
  version: number;
  created_at: number;
}

interface MessageEntry {
  type: "message";
  role: string;
  content: unknown[];
  timestamp: number;
}

interface ToolResultEntry {
  type: "tool_result";
  tool_use_id: string;
  tool_name: string;
  output: string;
  is_error: boolean;
  timestamp: number;
}

type SessionEntry = SessionHeader | MessageEntry | ToolResultEntry;

// ── Public types ──

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  filePath: string;
}

// ── SessionStore ──

export class SessionStore {
  private currentSessionId: string | null = null;
  private currentFilePath: string | null = null;

  /** Start a new session */
  newSession(): string {
    ensureDir(SESSIONS_DIR);
    this.currentSessionId = generateId();
    this.currentFilePath = path.join(SESSIONS_DIR, `${this.currentSessionId}.jsonl`);

    // Write session header
    const header: SessionHeader = {
      type: "session",
      session_id: this.currentSessionId,
      version: 1,
      created_at: nowMs(),
    };
    fs.writeFileSync(this.currentFilePath, JSON.stringify(header) + "\n", "utf-8");

    return this.currentSessionId;
  }

  /** Append a single message to the current session */
  appendMessage(message: Message): void {
    if (!this.currentFilePath) {
      this.newSession();
    }

    const entry: MessageEntry = {
      type: "message",
      role: message.role,
      content: message.content,
      timestamp: nowMs(),
    };

    fs.appendFileSync(this.currentFilePath!, JSON.stringify(entry) + "\n", "utf-8");
  }

  /** Append tool results */
  appendToolResults(results: { tool_use_id: string; tool_name: string; output: string; is_error: boolean }[]): void {
    if (!this.currentFilePath) return;

    for (const r of results) {
      const entry: ToolResultEntry = {
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        tool_name: r.tool_name,
        output: r.output.slice(0, 5000), // cap output size
        is_error: r.is_error,
        timestamp: nowMs(),
      };
      fs.appendFileSync(this.currentFilePath!, JSON.stringify(entry) + "\n", "utf-8");
    }
  }

  /** Load messages from a session file (for resume) */
  load(sessionId: string): Message[] {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, "utf-8");
    const messages: Message[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type === "message") {
          messages.push({
            role: entry.role as "user" | "assistant",
            content: entry.content as Message["content"],
          });
        }
      } catch { /* skip */ }
    }

    this.currentSessionId = sessionId;
    this.currentFilePath = filePath;
    return messages;
  }

  /** List all saved sessions, newest first */
  listSessions(): SessionMeta[] {
    ensureDir(SESSIONS_DIR);
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    return files.map((f) => {
      const filePath = path.join(SESSIONS_DIR, f);
      const stat = fs.statSync(filePath);
      const id = f.replace(".jsonl", "");

      let preview = "";
      let messageCount = 0;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (entry.type === "message") {
            messageCount++;
            if (!preview && entry.role === "user" && entry.content?.[0]?.text) {
              preview = entry.content[0].text.slice(0, 80);
            }
          }
        }
      } catch { /* ignore */ }

      return { id, createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), messageCount, preview, filePath };
    });
  }

  /** Delete a session */
  delete(sessionId: string): void {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
      this.currentFilePath = null;
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }
}
