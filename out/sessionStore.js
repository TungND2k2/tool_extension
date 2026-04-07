"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
function extractText(blocks) {
    return blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
}
/** Like extractText but strips workspace context prefix for clean previews */
function extractUserTextFromBlocks(blocks) {
    const raw = extractText(blocks);
    const marker = "## Workspace Structure";
    const idx = raw.indexOf(marker);
    if (idx === -1)
        return raw;
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
function miloSessionsDir(workspaceAbsPath) {
    try {
        fs.mkdirSync(MILO_SESSIONS_DIR, { recursive: true });
    }
    catch { /* ignore */ }
    // Try to find an existing slug dir that Rust already created for this workspace
    try {
        for (const slug of fs.readdirSync(MILO_SESSIONS_DIR)) {
            const slugDir = path.join(MILO_SESSIONS_DIR, slug);
            if (!fs.statSync(slugDir).isDirectory())
                continue;
            const marker = path.join(slugDir, "workspace-path.txt");
            if (fs.existsSync(marker)) {
                const stored = fs.readFileSync(marker, "utf-8").trim();
                if (stored === workspaceAbsPath)
                    return slugDir;
            }
        }
    }
    catch { /* ignore */ }
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
    }
    catch { /* ignore */ }
    return dir;
}
// ── SessionStore — reads Rust binary sessions from ~/.milo/sessions/<workspace-slug>/ ──
class SessionStore {
    workspaceDir = null;
    currentSessionId = null;
    setWorkspace(dir) {
        this.workspaceDir = dir;
        this.currentSessionId = null;
        // Ensure the sessions dir exists for this workspace
        miloSessionsDir(dir);
    }
    sessionsDir() {
        const base = this.workspaceDir ?? process.cwd();
        return miloSessionsDir(base);
    }
    getCurrentSessionId() {
        return this.currentSessionId;
    }
    /**
     * List sessions for the CURRENT workspace only, newest first.
     * Like Claude: each project has its own isolated chat history.
     */
    listSessions() {
        const dir = this.sessionsDir();
        const workspacePath = this.workspaceDir ?? process.cwd();
        const workspaceName = path.basename(workspacePath);
        if (!fs.existsSync(dir))
            return [];
        const sessions = [];
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
                    if (!line.trim())
                        continue;
                    const entry = JSON.parse(line);
                    if (entry.type === "session_meta") {
                        const m = entry;
                        createdMs = m.created_at_ms;
                        updatedMs = m.updated_at_ms;
                    }
                    else if (entry.type === "message") {
                        const msg = entry.message;
                        messageCount++;
                        if (!preview && msg.role === "user") {
                            preview = extractUserTextFromBlocks(msg.blocks).slice(0, 80);
                        }
                    }
                }
            }
            catch { /* ignore */ }
            if (messageCount === 0)
                continue;
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
        return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    /** Resolve filePath from composite id (slug::sessionId) or plain sessionId */
    resolveFilePath(sessionId) {
        if (sessionId.includes("::")) {
            const sep = sessionId.indexOf("::");
            const slug = sessionId.slice(0, sep);
            const sid = sessionId.slice(sep + 2);
            return path.join(MILO_SESSIONS_DIR, slug, `${sid}.jsonl`);
        }
        return path.join(this.sessionsDir(), `${sessionId}.jsonl`);
    }
    /** Load messages from a session (for UI replay) */
    load(sessionId) {
        const filePath = this.resolveFilePath(sessionId);
        if (!fs.existsSync(filePath))
            return [];
        const messages = [];
        try {
            for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
                if (!line.trim())
                    continue;
                const entry = JSON.parse(line);
                if (entry.type === "message") {
                    const msg = entry.message;
                    const text = extractText(msg.blocks);
                    if (text) {
                        messages.push({
                            role: msg.role,
                            content: [{ type: "text", text }],
                        });
                    }
                }
            }
        }
        catch { /* ignore */ }
        this.currentSessionId = sessionId;
        return messages;
    }
    /** Delete a session file */
    delete(sessionId) {
        const filePath = this.resolveFilePath(sessionId);
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
        if (this.currentSessionId === sessionId) {
            this.currentSessionId = null;
        }
    }
    newSession() {
        this.currentSessionId = null;
        return "";
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=sessionStore.js.map