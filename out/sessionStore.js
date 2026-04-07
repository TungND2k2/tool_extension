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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const MILO_DIR = path.join(os.homedir(), ".milo");
const SESSIONS_DIR = path.join(MILO_DIR, "sessions");
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function nowMs() {
    return Date.now();
}
// ── SessionStore ──
class SessionStore {
    currentSessionId = null;
    currentFilePath = null;
    /** Start a new session */
    newSession() {
        ensureDir(SESSIONS_DIR);
        this.currentSessionId = generateId();
        this.currentFilePath = path.join(SESSIONS_DIR, `${this.currentSessionId}.jsonl`);
        // Write session header
        const header = {
            type: "session",
            session_id: this.currentSessionId,
            version: 1,
            created_at: nowMs(),
        };
        fs.writeFileSync(this.currentFilePath, JSON.stringify(header) + "\n", "utf-8");
        return this.currentSessionId;
    }
    /** Append a single message to the current session */
    appendMessage(message) {
        if (!this.currentFilePath) {
            this.newSession();
        }
        const entry = {
            type: "message",
            role: message.role,
            content: message.content,
            timestamp: nowMs(),
        };
        fs.appendFileSync(this.currentFilePath, JSON.stringify(entry) + "\n", "utf-8");
    }
    /** Append tool results */
    appendToolResults(results) {
        if (!this.currentFilePath)
            return;
        for (const r of results) {
            const entry = {
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                tool_name: r.tool_name,
                output: r.output.slice(0, 5000), // cap output size
                is_error: r.is_error,
                timestamp: nowMs(),
            };
            fs.appendFileSync(this.currentFilePath, JSON.stringify(entry) + "\n", "utf-8");
        }
    }
    /** Load messages from a session file (for resume) */
    load(sessionId) {
        const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
        if (!fs.existsSync(filePath))
            return [];
        const content = fs.readFileSync(filePath, "utf-8");
        const messages = [];
        for (const line of content.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === "message") {
                    messages.push({
                        role: entry.role,
                        content: entry.content,
                    });
                }
            }
            catch { /* skip */ }
        }
        this.currentSessionId = sessionId;
        this.currentFilePath = filePath;
        return messages;
    }
    /** List all saved sessions, newest first */
    listSessions() {
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
            }
            catch { /* ignore */ }
            return { id, createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), messageCount, preview, filePath };
        });
    }
    /** Delete a session */
    delete(sessionId) {
        const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
        if (this.currentSessionId === sessionId) {
            this.currentSessionId = null;
            this.currentFilePath = null;
        }
    }
    getCurrentSessionId() {
        return this.currentSessionId;
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=sessionStore.js.map