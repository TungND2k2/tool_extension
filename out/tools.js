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
exports.getToolDefinitions = getToolDefinitions;
exports.resolveToolName = resolveToolName;
exports.setPermissionResolver = setPermissionResolver;
exports.resolvePermission = resolvePermission;
exports.executeTool = executeTool;
exports.onTodoUpdate = onTodoUpdate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
// ── Tool definitions — source of truth: src/reference_data/tool_schemas.json ─
// Cùng project → path đơn giản: __dirname = out/ → lên 1 cấp → src/reference_data/
function loadToolSchemas() {
    // __dirname khi chạy là claw-code/out/
    const schemasPath = path.join(__dirname, "reference_data", "tool_schemas.json");
    try {
        return JSON.parse(fs.readFileSync(schemasPath, "utf-8"));
    }
    catch {
        vscode.window.showWarningMessage(`Claw Code: không đọc được tool_schemas.json tại ${schemasPath}`);
        return [];
    }
}
function getToolDefinitions() {
    return loadToolSchemas();
}
// ── Tool name mapping: claw-code PascalCase → executor key ──────────────────
const TOOL_NAME_MAP = {
    BashTool: "bash",
    FileReadTool: "read_file",
    FileWriteTool: "write_file",
    FileEditTool: "edit_file",
    GlobTool: "glob_search",
    GrepTool: "grep_search",
    ListDirectoryTool: "list_directory",
    WebFetchTool: "web_fetch",
    TodoWriteTool: "todo_write",
};
/** Resolve claw-code tool name to executor key. */
function resolveToolName(name) {
    return TOOL_NAME_MAP[name] ?? name;
}
// ── Tool execution ──────────────────────────────────────────────────────────
// Permission resolver — set by chatViewProvider to handle inline prompts
let pendingPermissionResolve = null;
function setPermissionResolver(resolve) {
    pendingPermissionResolve = resolve;
}
function resolvePermission(answer) {
    if (pendingPermissionResolve) {
        pendingPermissionResolve(answer);
        pendingPermissionResolve = null;
    }
}
async function executeTool(name, input, permissionMode, askPermission, sessionAllowAll) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    // Normalize claw-code PascalCase names → executor keys
    const key = resolveToolName(name);
    const writeTools = ["write_file", "edit_file"];
    const dangerTools = ["bash"];
    if (permissionMode === "read-only" && (writeTools.includes(key) || dangerTools.includes(key))) {
        return { output: `Permission denied: '${name}' not allowed in read-only mode`, isError: true };
    }
    if (permissionMode === "workspace-write" && dangerTools.includes(key) && askPermission && !sessionAllowAll?.value) {
        const answer = await askPermission(name, JSON.stringify(input).slice(0, 500));
        if (answer === "allow_all") {
            if (sessionAllowAll)
                sessionAllowAll.value = true;
        }
        else if (answer !== "allow") {
            return { output: `User denied tool '${name}'`, isError: true };
        }
    }
    try {
        switch (key) {
            case "read_file":
                return readFile(workspaceRoot, input.file_path);
            case "write_file":
                return writeFile(workspaceRoot, input.file_path, input.content);
            case "edit_file":
                return editFile(workspaceRoot, input.file_path, input.old_string, input.new_string);
            case "glob_search":
                return globSearch(input.pattern);
            case "grep_search":
                return grepSearch(workspaceRoot, input.pattern, input.path);
            case "bash":
                return bashExec(workspaceRoot, input.command);
            case "list_directory":
                return listDirectory(workspaceRoot, input.path);
            case "web_fetch":
                return webFetch(input.url);
            case "todo_write":
                return todoWrite(input.todos);
            default:
                return { output: `Unknown tool: ${name} (resolved: ${key})`, isError: true };
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Tool error: ${msg}`, isError: true };
    }
}
// ── Tool implementations ────────────────────────────────────────────────────
function readFile(root, filePath) {
    const absPath = path.resolve(root, filePath);
    if (!absPath.startsWith(root)) {
        return { output: "Path escapes workspace", isError: true };
    }
    if (!fs.existsSync(absPath)) {
        return { output: `File not found: ${filePath}`, isError: true };
    }
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
    return { output: lines, isError: false };
}
function writeFile(root, filePath, content) {
    const absPath = path.resolve(root, filePath);
    if (!absPath.startsWith(root)) {
        return { output: "Path escapes workspace", isError: true };
    }
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absPath, content, "utf-8");
    return { output: `File written: ${filePath} (${content.length} bytes)`, isError: false };
}
function editFile(root, filePath, oldString, newString) {
    const absPath = path.resolve(root, filePath);
    if (!absPath.startsWith(root)) {
        return { output: "Path escapes workspace", isError: true };
    }
    if (!fs.existsSync(absPath)) {
        return { output: `File not found: ${filePath}`, isError: true };
    }
    const content = fs.readFileSync(absPath, "utf-8");
    if (!content.includes(oldString)) {
        return { output: `old_string not found in ${filePath}`, isError: true };
    }
    const newContent = content.replace(oldString, newString);
    fs.writeFileSync(absPath, newContent, "utf-8");
    return { output: `File edited: ${filePath}`, isError: false };
}
async function globSearch(pattern, basePath) {
    // Respect base_path from GlobTool schema
    const fullPattern = basePath ? `${basePath.replace(/\\/g, "/")}/${pattern}` : pattern;
    const uris = await vscode.workspace.findFiles(fullPattern, "{**/node_modules/**,**/.git/**}", 200);
    const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort();
    return { output: files.join("\n") || "No matches", isError: false };
}
function grepSearch(root, pattern, searchPath) {
    const dir = searchPath ? path.resolve(root, searchPath) : root;
    try {
        const result = cp.execSync(`grep -rn --include='*' -E ${JSON.stringify(pattern)} ${JSON.stringify(dir)} | head -50`, { encoding: "utf-8", timeout: 10000 });
        return { output: result || "No matches", isError: false };
    }
    catch {
        return { output: "No matches", isError: false };
    }
}
function bashExec(root, command) {
    try {
        const result = cp.execSync(command, {
            encoding: "utf-8",
            cwd: root,
            timeout: 300000, // 5 phút — cho npm install, build, etc.
            maxBuffer: 5 * 1024 * 1024, // 5MB output
        });
        return { output: result, isError: false };
    }
    catch (err) {
        const execErr = err;
        const output = (execErr.stdout || "") + (execErr.stderr || "") || execErr.message;
        return { output, isError: true };
    }
}
function listDirectory(root, dirPath) {
    const absPath = path.resolve(root, dirPath);
    if (!absPath.startsWith(root)) {
        return { output: "Path escapes workspace", isError: true };
    }
    if (!fs.existsSync(absPath)) {
        return { output: `Directory not found: ${dirPath}`, isError: true };
    }
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const result = entries
        .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
        .join("\n");
    return { output: result, isError: false };
}
async function webFetch(url) {
    try {
        const result = cp.execSync(`curl -sL --max-time 15 --user-agent "Mozilla/5.0" ${JSON.stringify(url)} | head -c 20000`, { encoding: "utf-8", timeout: 20000 });
        return { output: result || "(empty response)", isError: false };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Fetch error: ${msg}`, isError: true };
    }
}
// Listeners so chatViewProvider can push todo updates to the webview
const todoListeners = [];
function onTodoUpdate(fn) {
    todoListeners.push(fn);
    return () => {
        const i = todoListeners.indexOf(fn);
        if (i >= 0)
            todoListeners.splice(i, 1);
    };
}
function todoWrite(todos) {
    if (!Array.isArray(todos)) {
        return { output: "todos must be an array", isError: true };
    }
    // Notify all listeners (chatViewProvider → webview)
    for (const fn of todoListeners) {
        fn(todos);
    }
    const summary = todos.map(t => {
        const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : t.status === "blocked" ? "✗" : "○";
        return `${icon} [${t.id}] ${t.title}${t.note ? ` — ${t.note}` : ""}`;
    }).join("\n");
    return { output: `Todo list updated (${todos.length} items):\n${summary}`, isError: false };
}
//# sourceMappingURL=tools.js.map