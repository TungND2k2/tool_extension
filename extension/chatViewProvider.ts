import * as vscode from "vscode";
import { ClawProcess, ClawStreamEvent } from "./clawProcess";
import { onTodoUpdate, TodoItem } from "./tools";
import { SessionStore } from "./sessionStore";
import { getWebviewScript } from "./webviewScript";
import { getProjectContextPrompt } from "./projectContext";

export class ClawChatViewProvider implements vscode.WebviewViewProvider {
  private webviewView?: vscode.WebviewView;
  private isGenerating = false;
  private sessionStore = new SessionStore();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly clawProcess: ClawProcess
  ) {
    // Forward todo updates to the webview in real-time
    onTodoUpdate((todos: TodoItem[]) => {
      this.webviewView?.webview.postMessage({ type: "todoUpdate", todos });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml();

    // Restore last session
    this.restoreLastSession();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "sendMessage":
          await this.handleUserMessage(msg.text);
          break;
        case "stopGeneration":
          this.stopGeneration();
          break;
        case "newChat":
          this.newChat();
          break;
        case "pickFile":
          await this.pickFile();
          break;
        case "listThreads":
          this.sendThreadList();
          break;
        case "switchThread":
          this.switchThread(msg.id);
          break;
        case "deleteThread":
          this.deleteThread(msg.id);
          break;
        case "permissionResponse":
          if (msg.answer !== "deny") {
            // Permission handled internally by claw binary
          }
          break;
      }
    });
  }

  private sendThreadList() {
    const sessions = this.sessionStore.listSessions();
    const currentId = this.sessionStore.getCurrentSessionId();
    this.webviewView?.webview.postMessage({
      type: "threadList",
      threads: sessions.map(s => ({
        id: s.id,
        preview: s.preview || "New chat",
        date: new Date(s.updatedAt).toLocaleDateString(),
        messageCount: s.messageCount,
        active: s.id === currentId,
      })),
    });
  }

  private switchThread(sessionId: string) {
    this.clawProcess.resetSession();
    const messages = this.sessionStore.load(sessionId);
    this.webviewView?.webview.postMessage({ type: "clearChat" });
    // Replay messages to UI
    for (const msg of messages) {
      const firstBlock = msg.content[0];
      if (!firstBlock) continue;
      if (msg.role === "user" && "text" in firstBlock) {
        this.webviewView?.webview.postMessage({ type: "addMessage", role: "user", content: firstBlock.text });
      } else if (msg.role === "assistant") {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === "text" && b.text)
          .map(b => b.text).join("\n");
        if (text) this.webviewView?.webview.postMessage({ type: "addMessage", role: "assistant", content: text });
      }
    }
  }

  private deleteThread(sessionId: string) {
    this.sessionStore.delete(sessionId);
    if (sessionId === this.sessionStore.getCurrentSessionId()) {
      this.newChat();
    }
    this.sendThreadList();
  }

  newChat() {
    this.clawProcess.resetSession();
    this.sessionStore.newSession();
    this.webviewView?.webview.postMessage({ type: "clearChat" });
  }

  private restoreLastSession() {
    const sessions = this.sessionStore.listSessions();
    if (sessions.length === 0) return;
    const latest = sessions[0];
    const messages = this.sessionStore.load(latest.id);
    if (messages.length === 0) return;
    for (const msg of messages) {
      const firstBlock = msg.content[0];
      if (!firstBlock) continue;
      if (msg.role === "user" && "text" in firstBlock) {
        this.webviewView?.webview.postMessage({ type: "addMessage", role: "user", content: firstBlock.text });
      } else if (msg.role === "assistant") {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === "text" && b.text)
          .map(b => b.text).join("\n");
        if (text) this.webviewView?.webview.postMessage({ type: "addMessage", role: "assistant", content: text });
      }
    }
  }

  stopGeneration() {
    this.clawProcess.kill();
    this.isGenerating = false;
    this.webviewView?.webview.postMessage({ type: "generationStopped" });
  }

  private async pickFile() {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: "Attach File" });
    if (uris && uris.length > 0) {
      const relativePath = vscode.workspace.asRelativePath(uris[0]);
      try {
        const content = await vscode.workspace.fs.readFile(uris[0]);
        const text = new TextDecoder("utf-8").decode(content);
        this.webviewView?.webview.postMessage({ type: "fileAttached", name: relativePath, content: text });
      } catch { /* ignore */ }
    }
  }

  private async handleUserMessage(text: string) {
    if (this.isGenerating || !text.trim()) return;

    if (!this.clawProcess.isConfigured()) {
      this.webviewView?.webview.postMessage({
        type: "showError",
        error: "API Key chưa cấu hình. Vào Settings → Milo Code → API Key",
      });
      return;
    }

    this.webviewView?.webview.postMessage({ type: "addMessage", role: "user", content: text });
    await this.runAgenticLoop(text);
  }

  private async runAgenticLoop(prompt: string) {
    this.isGenerating = true;
    this.webviewView?.webview.postMessage({ type: "generationStarted" });

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    // Append project context as system-level prefix to prompt
    const projectCtx = getProjectContextPrompt(cwd);
    const fullPrompt = projectCtx ? `${projectCtx}\n\n${prompt}` : prompt;

    let streamStarted = false;
    // tool_start events carry only name+input (no id from Rust binary) — use name as id key
    const pendingTools = new Map<string, string>(); // name → unique id

    await this.clawProcess.run(fullPrompt, cwd, (evt: ClawStreamEvent) => {
      if (!this.isGenerating) return;

      switch (evt.type) {
        case "text_delta":
          if (!streamStarted) {
            streamStarted = true;
            this.webviewView?.webview.postMessage({ type: "streamStart" });
          }
          this.webviewView?.webview.postMessage({ type: "streamDelta", text: evt.text });
          break;

        case "tool_start": {
          const toolId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          pendingTools.set(evt.toolName || "", toolId);
          const label = describeToolAction(evt.toolName || "", evt.toolInput ? ((): Record<string, unknown> => {
            try { return JSON.parse(evt.toolInput || "{}"); } catch { return {}; }
          })() : {});
          this.webviewView?.webview.postMessage({
            type: "toolBlock",
            id: toolId,
            name: evt.toolName,
            label,
            input: evt.toolInput || "",
          });
          break;
        }

        case "tool_done": {
          const toolId = pendingTools.get(evt.toolName || "") || `tool-${evt.toolName}`;
          pendingTools.delete(evt.toolName || "");
          this.webviewView?.webview.postMessage({
            type: "toolBlockUpdate",
            id: toolId,
            status: evt.toolIsError ? "error" : "done",
            output: (evt.toolOutput || "").slice(0, 1000),
          });
          break;
        }

        case "done":
          if (!streamStarted) {
            // No text_delta came — show result message
            this.webviewView?.webview.postMessage({ type: "streamStart" });
          }
          if (evt.result?.message) {
            this.webviewView?.webview.postMessage({ type: "streamDelta", text: evt.result.message });
          }
          this.webviewView?.webview.postMessage({ type: "streamEnd" });
          break;

        case "error":
          this.webviewView?.webview.postMessage({ type: "showError", error: evt.error });
          break;

        case "downloading":
          this.webviewView?.webview.postMessage({ type: "showError", error: `⬇️ ${evt.text}` });
          break;
      }
    });

    this.isGenerating = false;
    this.webviewView?.webview.postMessage({ type: "generationStopped" });
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --r: 10px; --rs: 6px;
  --accent: var(--vscode-textLink-foreground);
  --border: var(--vscode-widget-border);
  --bg: var(--vscode-sideBar-background);
  --bg2: var(--vscode-input-background);
  --bg3: var(--vscode-editor-background);
  --fg: var(--vscode-foreground);
  --fg2: var(--vscode-descriptionForeground);
  --green: var(--vscode-terminal-ansiGreen);
  --red: var(--vscode-errorForeground);
}
body {
  font-family: var(--vscode-font-family); font-size: 13px;
  color: var(--fg); background: var(--bg);
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

/* ── Thread slide-over panel ── */
#threadPanel {
  display: none; position: absolute; top: 0; right: 0; bottom: 0; left: 0;
  background: var(--bg); z-index: 20; flex-direction: column; padding: 0;
}
#threadPanel.open { display: flex; }
.tp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  font-weight: 600; font-size: 13px; flex-shrink: 0;
}
.tp-close {
  background: none; border: none; color: var(--fg2); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: var(--rs);
}
.tp-close:hover { background: var(--vscode-list-hoverBackground); color: var(--fg); }
#threadList { flex: 1; overflow-y: auto; padding: 8px; }
.thread-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: var(--r);
  cursor: pointer; border: 1px solid transparent; margin-bottom: 3px;
}
.thread-item:hover { background: var(--vscode-list-hoverBackground); border-color: var(--border); }
.thread-item.active { background: var(--vscode-list-activeSelectionBackground); border-color: var(--accent); }
.ti-icon { font-size: 14px; flex-shrink: 0; }
.ti-info { flex: 1; min-width: 0; }
.ti-preview { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ti-meta { font-size: 10px; color: var(--fg2); margin-top: 2px; }
.ti-delete {
  background: none; border: none; color: var(--fg2); cursor: pointer;
  font-size: 14px; padding: 3px 6px; border-radius: var(--rs); opacity: 0; flex-shrink: 0;
}
.thread-item:hover .ti-delete { opacity: 1; }
.ti-delete:hover { color: var(--red); background: var(--vscode-list-hoverBackground); }

/* ── Chat messages area ── */
#chat { flex: 1; overflow-y: auto; padding: 16px 12px; scroll-behavior: smooth; }

@keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes blink { 0%,80%,100% { opacity: 0; } 40% { opacity: 1; } }

/* ── Welcome screen ── */
.welcome { text-align: center; padding: 40px 20px 20px; color: var(--fg2); }
.welcome-logo { font-size: 32px; margin-bottom: 8px; }
.welcome h2 { font-size: 17px; font-weight: 700; color: var(--fg); margin-bottom: 4px; }
.welcome .tag {
  display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 10px;
  border-radius: 20px; background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground); margin-bottom: 14px; letter-spacing: 0.3px;
}
.welcome p { font-size: 12px; line-height: 1.6; margin-bottom: 18px; color: var(--fg2); }
.shortcuts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.shortcut {
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--r); padding: 9px 11px;
  font-size: 11.5px; cursor: pointer; color: var(--fg); text-align: left;
  transition: border-color 0.15s, background 0.15s;
}
.shortcut:hover { border-color: var(--accent); background: var(--vscode-list-hoverBackground); }
.shortcut-icon { display: block; font-size: 16px; margin-bottom: 3px; }

/* ── Message bubbles ── */
.msg { margin-bottom: 18px; animation: fadeIn 0.18s ease; }
.msg-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.avatar {
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; flex-shrink: 0;
}
.msg.user .avatar { background: #3b82f6; color: #fff; }
.msg.assistant .avatar { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
.msg-name { font-weight: 600; font-size: 11px; color: var(--fg2); }

/* User message: right-aligned bubble */
.msg.user { display: flex; flex-direction: column; align-items: flex-end; }
.msg.user .msg-head { flex-direction: row-reverse; align-self: flex-end; }
.msg.user .msg-body {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: 14px 14px 4px 14px;
  padding: 9px 14px; font-size: 13px; line-height: 1.55;
  max-width: 88%; word-break: break-word;
}

/* Assistant message: full-width with left indent */
.msg.assistant .msg-body {
  padding-left: 29px; line-height: 1.65; color: var(--fg);
}

/* Thinking / Processing indicator */
.thinking-wrap { display: flex; align-items: center; gap: 8px; }
.thinking-label { font-size: 12px; color: var(--fg2); font-style: italic; }
.thinking-dots { display: flex; gap: 4px; align-items: center; }
.thinking-dots span {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent); display: inline-block;
  animation: bounce 1.2s infinite ease-in-out; opacity: 0.3;
}
.thinking-dots span:nth-child(1) { animation-delay: 0s; }
.thinking-dots span:nth-child(2) { animation-delay: 0.18s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.36s; }
@keyframes bounce { 0%,60%,100% { transform: translateY(0); opacity: 0.3; } 30% { transform: translateY(-5px); opacity: 1; } }

/* Markdown styles */
.msg-body h1 { font-size: 16px; font-weight: 700; margin: 12px 0 5px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.msg-body h2 { font-size: 14px; font-weight: 700; margin: 10px 0 4px; }
.msg-body h3 { font-size: 13px; font-weight: 600; margin: 8px 0 3px; }
.msg-body p { margin: 5px 0; }
.msg-body ul, .msg-body ol { margin: 5px 0; padding-left: 20px; }
.msg-body li { margin: 3px 0; line-height: 1.55; }
.msg-body strong { font-weight: 700; color: var(--fg); }
.msg-body em { font-style: italic; }
.msg-body hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
.msg-body blockquote {
  border-left: 3px solid var(--accent); padding: 4px 12px; margin: 6px 0;
  color: var(--fg2); background: var(--bg2);
  border-radius: 0 var(--rs) var(--rs) 0; font-style: italic;
}
.msg-body a { color: var(--accent); text-decoration: none; }
.msg-body a:hover { text-decoration: underline; }
.msg-body code {
  font-family: var(--vscode-editor-font-family); font-size: 11.5px;
  background: var(--bg2); border: 1px solid var(--border);
  padding: 1px 5px; border-radius: 4px;
}
.msg-body pre { margin: 8px 0; border-radius: var(--r); overflow: hidden; border: 1px solid var(--border); }
.msg-body pre code {
  display: block; padding: 11px 13px; overflow-x: auto; line-height: 1.5;
  background: var(--bg3); border: none; border-radius: 0;
  font-size: 12px; tab-size: 2;
}
.code-head {
  display: flex; justify-content: space-between; align-items: center;
  background: var(--bg2); border-bottom: 1px solid var(--border);
  padding: 4px 10px; font-size: 10.5px; color: var(--fg2);
  font-family: var(--vscode-editor-font-family);
}
.copy-btn {
  background: none; border: 1px solid var(--border);
  color: var(--fg2); cursor: pointer; padding: 2px 8px;
  border-radius: var(--rs); font-size: 10px; font-family: var(--vscode-font-family);
  transition: background 0.15s, color 0.15s;
}
.copy-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.msg-body table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
.msg-body th, .msg-body td { border: 1px solid var(--border); padding: 5px 10px; text-align: left; }
.msg-body th { background: var(--bg2); font-weight: 600; }
.msg-body tr:nth-child(even) td { background: var(--bg2); }

/* ── Tool blocks ── */
.tool {
  margin: 4px 0 4px 29px; border-radius: var(--r);
  border: 1px solid var(--border); overflow: hidden;
  font-size: 12px; animation: fadeIn 0.15s ease;
}
.tool-head {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px; background: var(--bg2);
  cursor: pointer; user-select: none;
  transition: background 0.1s;
}
.tool-head:hover { background: var(--vscode-list-hoverBackground); }
/* Rotate chevron when expanded */
.tool.open .tool-chevron { transform: rotate(90deg); }
.tool-chevron { font-size: 9px; color: var(--fg2); transition: transform 0.15s; flex-shrink: 0; }
.tool-icon { font-size: 14px; flex-shrink: 0; }
.tool-label { flex: 1; font-size: 12px; color: var(--fg); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool-label .tool-subname { font-size: 10px; color: var(--fg2); font-weight: 400; margin-left: 4px; }
/* Spinner ring inside tool head while running */
.tool-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-badge {
  font-size: 10px; font-weight: 600; padding: 1px 7px;
  border-radius: 10px; flex-shrink: 0; white-space: nowrap;
}
.tool-badge.ok   { color: var(--green); background: color-mix(in srgb, var(--green) 15%, transparent); }
.tool-badge.err  { color: var(--red);   background: color-mix(in srgb, var(--red)   15%, transparent); }
.tool-body {
  display: none; overflow: hidden;
}
.tool.open .tool-body { display: block; }
.tool-section { border-top: 1px solid var(--border); }
.tool-section-head {
  font-size: 10px; font-weight: 600; color: var(--fg2);
  padding: 4px 10px 2px; text-transform: uppercase; letter-spacing: 0.5px;
  background: var(--bg2);
}
.tool-body pre {
  white-space: pre-wrap; word-break: break-all; font-size: 11px;
  color: var(--fg2); margin: 0; padding: 8px 10px 10px;
  font-family: var(--vscode-editor-font-family); line-height: 1.5;
  max-height: 200px; overflow-y: auto;
}
/* Green output lines */
.tool-output-ok pre { color: var(--fg); }
/* Error output */
.tool-output-err pre { color: var(--red); }

/* ── Thinking block ── */
.thinking-block {
  margin: 4px 0 4px 29px; border-radius: var(--r);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  overflow: hidden; font-size: 12px; animation: fadeIn 0.15s ease;
}
.thinking-head {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px; background: color-mix(in srgb, var(--accent) 6%, var(--bg2));
  cursor: pointer; user-select: none; transition: background 0.1s;
}
.thinking-head:hover { background: color-mix(in srgb, var(--accent) 12%, var(--bg2)); }
.thinking-block.open .thinking-chevron { transform: rotate(90deg); }
.thinking-chevron { font-size: 9px; color: var(--accent); transition: transform 0.15s; flex-shrink: 0; }
.thinking-head-label { flex: 1; font-size: 12px; font-weight: 500; color: var(--accent); }
/* Inline dots while streaming */
.thinking-stream-dots { display: flex; gap: 3px; align-items: center; }
.thinking-stream-dots span {
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.4;
  animation: bounce 1.2s infinite ease-in-out;
}
.thinking-stream-dots span:nth-child(1) { animation-delay: 0s; }
.thinking-stream-dots span:nth-child(2) { animation-delay: 0.18s; }
.thinking-stream-dots span:nth-child(3) { animation-delay: 0.36s; }
.thinking-char-count { font-size: 10px; color: var(--fg2); }
.thinking-body {
  display: none; border-top: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  padding: 10px 12px; max-height: 280px; overflow-y: auto;
  background: color-mix(in srgb, var(--accent) 3%, var(--bg));
}
.thinking-block.open .thinking-body { display: block; }
.thinking-body p {
  margin: 0 0 6px; font-size: 12px; color: var(--fg2); line-height: 1.65;
  font-style: italic;
}
.thinking-body p:last-child { margin-bottom: 0; }

/* ── Permission prompt ── */
.permission-prompt {
  margin: 6px 0 6px 29px; padding: 12px;
  border: 1px solid var(--vscode-editorWarning-foreground);

/* ── Todo panel ── */
.todo-panel {
  flex-shrink: 0; border-bottom: 1px solid var(--border);
  padding: 6px 10px 8px; background: var(--bg);
}
.todo-header {
  font-size: 11px; font-weight: 600; color: var(--fg2);
  margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;
}
.todo-item {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 12px; padding: 2px 0; line-height: 1.4;
}
.todo-title { flex: 1; }
.todo-note { font-size: 11px; color: var(--fg2); font-style: italic; }
.todo-pending { color: var(--fg2); }
.todo-in_progress { color: var(--accent); font-weight: 600; }
.todo-in_progress .todo-title::after { content: "..."; animation: pulse 1s infinite; }
.todo-done { color: var(--green); text-decoration: line-through; opacity: 0.7; }
.todo-blocked { color: var(--red); }
  border-radius: var(--r); background: var(--bg2);
  animation: fadeIn 0.15s ease;
}
.pp-head { font-size: 11px; color: var(--fg2); margin-bottom: 6px; font-weight: 500; }
.pp-tool { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--fg); }
.pp-input {
  font-size: 11px; padding: 7px 9px; margin-bottom: 10px;
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: var(--rs); max-height: 100px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
  font-family: var(--vscode-editor-font-family); color: var(--fg2); line-height: 1.4;
}
.pp-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pp-btn {
  padding: 5px 14px; border: none; border-radius: var(--rs);
  cursor: pointer; font-size: 12px; font-weight: 600;
  transition: opacity 0.15s;
}
.pp-btn:hover { opacity: 0.85; }
.pp-allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.pp-allowall { background: #059669; color: #fff; }
.pp-deny { background: var(--red); color: #fff; }
.pp-note { font-size: 10px; color: var(--fg2); margin-top: 8px; font-style: italic; }

/* ── Input area ── */
#inputArea {
  border-top: 1px solid var(--border); padding: 8px 10px;
  background: var(--bg); flex-shrink: 0;
}
.input-toolbar { display: flex; align-items: center; gap: 2px; margin-bottom: 6px; }
.icon-btn {
  background: none; border: none; color: var(--fg2); cursor: pointer;
  padding: 4px 7px; border-radius: var(--rs); font-size: 14px; line-height: 1;
  transition: background 0.1s, color 0.1s;
}
.icon-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--fg); }
.icon-btn.active { color: var(--accent); }
.toolbar-sep { flex: 1; }
.input-box {
  display: flex; gap: 6px; align-items: flex-end;
  border: 1px solid var(--border); border-radius: var(--r);
  background: var(--bg2); padding: 4px 4px 4px 10px;
  transition: border-color 0.15s;
}
.input-box:focus-within { border-color: var(--accent); }
#input {
  flex: 1; resize: none; border: none; background: transparent;
  color: var(--vscode-input-foreground);
  font-family: var(--vscode-font-family); font-size: 13px;
  min-height: 24px; max-height: 120px; line-height: 1.5; outline: none;
  padding: 3px 0;
}
#input::placeholder { color: var(--fg2); }
#sendBtn {
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: var(--rs); padding: 6px 14px;
  cursor: pointer; font-size: 12px; font-weight: 600; white-space: nowrap;
  flex-shrink: 0; transition: background 0.15s, opacity 0.15s;
  display: flex; align-items: center; gap: 5px;
}
#sendBtn:hover { background: var(--vscode-button-hoverBackground); }
#sendBtn.stop { background: #dc2626; }
#sendBtn:disabled { opacity: 0.5; cursor: not-allowed; }
.input-hint { font-size: 10px; color: var(--fg2); margin-top: 5px; text-align: center; }
</style>
</head>
<body>
<div id="chat">
  <div class="welcome">
    <div class="welcome-logo">&#129302;</div>
    <h2>Milo Code</h2>
    <span class="tag">Powered by Gemma 4 &nbsp;&#183;&nbsp; Self-hosted</span>
    <p>AI coding agent inside VS Code.<br>Read, write, edit files &bull; run commands &bull; persistent chat history.</p>
    <div class="shortcuts">
      <div class="shortcut" data-prompt="Explain this project structure to me"><span class="shortcut-icon">&#128269;</span>Explain project</div>
      <div class="shortcut" data-prompt="Find and fix bugs in the code"><span class="shortcut-icon">&#128030;</span>Find &amp; fix bugs</div>
      <div class="shortcut" data-prompt="Write unit tests for this project"><span class="shortcut-icon">&#9989;</span>Write tests</div>
      <div class="shortcut" data-prompt="Review the code and suggest improvements"><span class="shortcut-icon">&#128221;</span>Review code</div>
    </div>
  </div>
</div>

<div id="threadPanel">
  <div class="tp-header">
    <span>&#128172; Chat History</span>
    <button class="tp-close" id="closeThreads">&#10005;</button>
  </div>
  <div id="threadList"></div>
</div>

<div id="inputArea">
  <div class="input-toolbar">
    <button class="icon-btn" id="threadsBtn" title="Chat history">&#128172;</button>
    <button class="icon-btn" id="pickFileBtn" title="Attach file">&#128206;</button>
    <span class="toolbar-sep"></span>
    <button class="icon-btn" id="newChatBtn" title="New chat">&#10010;</button>
  </div>
  <div class="input-box">
    <textarea id="input" rows="1" placeholder="Message Milo Code... (Enter to send, Shift+Enter for new line)"></textarea>
    <button id="sendBtn">&#10148; Send</button>
  </div>
  <div class="input-hint">Shift+Enter for new line &nbsp;&bull;&nbsp; Enter to send</div>
</div>

<script>${getWebviewScript()}</script>
</body>
</html>`;
  }
}

// ── Tool display helpers ──────────────────────────────────────────────────────

/** Returns a short human-readable label for what the tool is doing. */
function describeToolAction(name: string, input: Record<string, unknown>): string {
  const key = name.toLowerCase().replace("tool", "");
  const fp = (input.file_path ?? input.path ?? "") as string;
  const short = fp ? fp.split(/[\\/]/).slice(-2).join("/") : "";

  switch (key) {
    case "fileread":    return short ? `Reading ${short}` : "Reading file";
    case "filewrite":   return short ? `Writing ${short}` : "Writing file";
    case "fileedit":    return short ? `Editing ${short}` : "Editing file";
    case "glob":        return `Searching ${(input.pattern as string) || "files"}`;
    case "grep":        return `Grepping for ${(input.pattern as string)?.slice(0, 40) || "pattern"}`;
    case "listdirectory":
    case "ls":          return short ? `Listing ${short}` : "Listing directory";
    case "bash": {
      const cmd = ((input.command as string) || "").trim();
      // Show first meaningful word(s)
      const first = cmd.split(/\s+/).slice(0, 3).join(" ");
      return `Running: ${first.slice(0, 60)}${cmd.length > 60 ? "…" : ""}`;
    }
    case "webfetch":    return `Fetching ${(input.url as string)?.replace(/^https?:\/\//, "").slice(0, 50) || "URL"}`;
    case "todowrite":   return "Updating task list";
    // PascalCase fallback
    case "read_file":   return short ? `Reading ${short}` : "Reading file";
    case "write_file":  return short ? `Writing ${short}` : "Writing file";
    case "edit_file":   return short ? `Editing ${short}` : "Editing file";
    default:            return name;
  }
}
