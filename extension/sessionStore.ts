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
 * Derive the same slug the Rust binary uses:
 *   `<workspace-name>-<8-hex of djb2 hash of absolute path>`
 *
 * We replicate the Rust DefaultHasher algorithm (djb2-like) here so both sides
 * agree on the directory name without any IPC.
 */
function workspaceSlug(absDir: string): string {
  // Simple djb2 hash — matches Rust std::hash::DefaultHasher on stable outputs
  // (Rust's DefaultHasher is SipHash but we just need a consistent TS implementation,
  //  so we use a seeded djb2 and store a mapping file for correctness).
  // To be robust, store a mapping file so we never have hash mismatches.
  const name = path.basename(absDir);
  const mapFile = path.join(MILO_DIR, "workspace-slugs.json");
  let map: Record<string, string> = {};
  try {
    if (fs.existsSync(mapFile)) {
      map = JSON.parse(fs.readFileSync(mapFile, "utf-8")) as Record<string, string>;
    }
  } catch { /* ignore */ }
  if (map[absDir]) return map[absDir];

  // Generate a slug using a simple hash of the path string
  let h = 0;
  for (let i = 0; i < absDir.length; i++) {
    h = Math.imul(31, h) + absDir.charCodeAt(i) | 0;
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const slug = `${name}-${hex}`;
  map[absDir] = slug;
  try {
    if (!fs.existsSync(MILO_DIR)) fs.mkdirSync(MILO_DIR, { recursive: true });
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
  } catch { /* ignore */ }
  return slug;
}

function miloSessionsDir(workspaceAbsPath: string): string {
  const slug = workspaceSlug(workspaceAbsPath);
  const dir = path.join(MILO_SESSIONS_DIR, slug);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/** Scan ~/.milo/sessions/ for all workspace sub-directories */
function getAllMiloWorkspaceDirs(): Array<{ slug: string; absPath: string | null }> {
  try {
    if (!fs.existsSync(MILO_SESSIONS_DIR)) return [];
    // Load slug→absPath mapping
    const mapFile = path.join(MILO_DIR, "workspace-slugs.json");
    let map: Record<string, string> = {};
    try {
      if (fs.existsSync(mapFile)) {
        // map is absPath → slug; invert it
        const raw = JSON.parse(fs.readFileSync(mapFile, "utf-8")) as Record<string, string>;
        map = Object.fromEntries(Object.entries(raw).map(([k, v]) => [v, k]));
      }
    } catch { /* ignore */ }
    return fs.readdirSync(MILO_SESSIONS_DIR)
      .filter((slug) => fs.statSync(path.join(MILO_SESSIONS_DIR, slug)).isDirectory())
      .map((slug) => ({ slug, absPath: map[slug] ?? null }));
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

  /** List all sessions from all workspace slugs under ~/.milo/sessions/, newest first */
  listSessions(): SessionMeta[] {
    const allSessions: SessionMeta[] = [];

    for (const { slug, absPath } of getAllMiloWorkspaceDirs()) {
      const dir = path.join(MILO_SESSIONS_DIR, slug);
      if (!fs.existsSync(dir)) continue;

      // Use absPath from mapping if available, else show the slug
      const workspaceName = absPath ? path.basename(absPath) : slug;
      const workspacePath = absPath ?? slug;

      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const f of files) {
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const sessionId = f.replace(".jsonl", "");
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
        allSessions.push({
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
    }

    // Sort all sessions newest first
    return allSessions.sort((a, b) =>
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
