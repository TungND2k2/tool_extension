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
// ── Workspace registry — persists all known workspaces in ~/.milo/workspaces.json ──
const MILO_DIR = path.join(os.homedir(), ".milo");
const WORKSPACES_FILE = path.join(MILO_DIR, "workspaces.json");
function registerWorkspace(dir) {
    let list = [];
    try {
        if (fs.existsSync(WORKSPACES_FILE)) {
            list = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8"));
        }
    }
    catch { /* ignore */ }
    const idx = list.indexOf(dir);
    if (idx !== -1)
        list.splice(idx, 1);
    list.unshift(dir); // Most recent first
    list = list.slice(0, 50);
    try {
        if (!fs.existsSync(MILO_DIR))
            fs.mkdirSync(MILO_DIR, { recursive: true });
        fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(list, null, 2));
    }
    catch { /* ignore */ }
}
function getRegisteredWorkspaces() {
    try {
        if (fs.existsSync(WORKSPACES_FILE)) {
            return JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8"))
                .filter((d) => fs.existsSync(d));
        }
    }
    catch { /* ignore */ }
    return [];
}
// ── SessionStore — reads Rust binary sessions from <workspace>/.claw/sessions/ ──
class SessionStore {
    workspaceDir = null;
    currentSessionId = null;
    setWorkspace(dir) {
        this.workspaceDir = dir;
        this.currentSessionId = null;
        registerWorkspace(dir);
    }
    sessionsDir() {
        if (this.workspaceDir) {
            return path.join(this.workspaceDir, ".claw", "sessions");
        }
        // Fallback — try to find via cwd
        return path.join(process.cwd(), ".claw", "sessions");
    }
    getCurrentSessionId() {
        return this.currentSessionId;
    }
    /** List all sessions from all known workspaces, newest first */
    listSessions() {
        // Always include current workspace + all registered ones
        const allWorkspaces = getRegisteredWorkspaces();
        if (this.workspaceDir && !allWorkspaces.includes(this.workspaceDir)) {
            allWorkspaces.unshift(this.workspaceDir);
        }
        const allSessions = [];
        for (const wsDir of allWorkspaces) {
            const dir = path.join(wsDir, ".claw", "sessions");
            if (!fs.existsSync(dir))
                continue;
            const workspaceName = path.basename(wsDir);
            const files = fs.readdirSync(dir)
                .filter((f) => f.endsWith(".jsonl"))
                .sort()
                .reverse();
            for (const f of files) {
                const filePath = path.join(dir, f);
                const stat = fs.statSync(filePath);
                const id = `${wsDir}::${f.replace(".jsonl", "")}`; // unique across workspaces
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
        return allSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    /** Resolve filePath from composite id (wsDir::sessionId) or plain sessionId */
    resolveFilePath(sessionId) {
        if (sessionId.includes("::")) {
            const sep = sessionId.indexOf("::");
            const wsDir = sessionId.slice(0, sep);
            const sid = sessionId.slice(sep + 2);
            return path.join(wsDir, ".claw", "sessions", `${sid}.jsonl`);
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