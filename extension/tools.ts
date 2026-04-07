import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { ToolDefinition } from "./apiClient";

// ── Tool definitions — source of truth: src/reference_data/tool_schemas.json ─
// Cùng project → path đơn giản: __dirname = out/ → lên 1 cấp → src/reference_data/

function loadToolSchemas(): ToolDefinition[] {
  // __dirname khi chạy là claw-code/out/
  const schemasPath = path.join(__dirname, "reference_data", "tool_schemas.json");
  try {
    return JSON.parse(fs.readFileSync(schemasPath, "utf-8")) as ToolDefinition[];
  } catch {
    vscode.window.showWarningMessage(
      `Claw Code: không đọc được tool_schemas.json tại ${schemasPath}`
    );
    return [];
  }
}

export function getToolDefinitions(): ToolDefinition[] {
  return loadToolSchemas();
}

// ── Tool name mapping: claw-code PascalCase → executor key ──────────────────
const TOOL_NAME_MAP: Record<string, string> = {
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
export function resolveToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

// ── Tool execution ──────────────────────────────────────────────────────────

// Permission resolver — set by chatViewProvider to handle inline prompts
let pendingPermissionResolve: ((answer: string) => void) | null = null;

export function setPermissionResolver(resolve: (answer: string) => void) {
  pendingPermissionResolve = resolve;
}

export function resolvePermission(answer: string) {
  if (pendingPermissionResolve) {
    pendingPermissionResolve(answer);
    pendingPermissionResolve = null;
  }
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  permissionMode: string,
  askPermission?: (toolName: string, toolInput: string) => Promise<string>,
  sessionAllowAll?: { value: boolean }
): Promise<{ output: string; isError: boolean }> {
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
      if (sessionAllowAll) sessionAllowAll.value = true;
    } else if (answer !== "allow") {
      return { output: `User denied tool '${name}'`, isError: true };
    }
  }

  try {
    switch (key) {
      case "read_file":
        return readFile(workspaceRoot, input.file_path as string);

      case "write_file":
        return writeFile(workspaceRoot, input.file_path as string, input.content as string);

      case "edit_file":
        return editFile(
          workspaceRoot,
          input.file_path as string,
          input.old_string as string,
          input.new_string as string
        );

      case "glob_search":
        return globSearch(input.pattern as string);

      case "grep_search":
        return grepSearch(workspaceRoot, input.pattern as string, input.path as string | undefined);

      case "bash":
        return bashExec(workspaceRoot, input.command as string);

      case "list_directory":
        return listDirectory(workspaceRoot, input.path as string);

      case "web_fetch":
        return webFetch(input.url as string);

      case "todo_write":
        return todoWrite(input.todos as TodoItem[]);

      default:
        return { output: `Unknown tool: ${name} (resolved: ${key})`, isError: true };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Tool error: ${msg}`, isError: true };
  }
}

// ── Tool implementations ────────────────────────────────────────────────────

function readFile(root: string, filePath: string): { output: string; isError: boolean } {
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

function writeFile(root: string, filePath: string, content: string): { output: string; isError: boolean } {
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

function editFile(
  root: string,
  filePath: string,
  oldString: string,
  newString: string
): { output: string; isError: boolean } {
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

async function globSearch(pattern: string, basePath?: string): Promise<{ output: string; isError: boolean }> {
  // Respect base_path from GlobTool schema
  const fullPattern = basePath ? `${basePath.replace(/\\/g, "/")}/${pattern}` : pattern;
  const uris = await vscode.workspace.findFiles(fullPattern, "{**/node_modules/**,**/.git/**}", 200);
  const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort();
  return { output: files.join("\n") || "No matches", isError: false };
}

function grepSearch(
  root: string,
  pattern: string,
  searchPath?: string
): { output: string; isError: boolean } {
  const dir = searchPath ? path.resolve(root, searchPath) : root;
  try {
    const result = cp.execSync(
      `grep -rn --include='*' -E ${JSON.stringify(pattern)} ${JSON.stringify(dir)} | head -50`,
      { encoding: "utf-8", timeout: 10000 }
    );
    return { output: result || "No matches", isError: false };
  } catch {
    return { output: "No matches", isError: false };
  }
}

function bashExec(root: string, command: string): { output: string; isError: boolean } {
  try {
    const result = cp.execSync(command, {
      encoding: "utf-8",
      cwd: root,
      timeout: 300000,  // 5 phút — cho npm install, build, etc.
      maxBuffer: 5 * 1024 * 1024,  // 5MB output
    });
    return { output: result, isError: false };
  } catch (err: unknown) {
    const execErr = err as cp.ExecException & { stdout?: string; stderr?: string };
    const output = (execErr.stdout || "") + (execErr.stderr || "") || execErr.message;
    return { output, isError: true };
  }
}

function listDirectory(root: string, dirPath: string): { output: string; isError: boolean } {
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

async function webFetch(url: string): Promise<{ output: string; isError: boolean }> {
  try {
    const result = cp.execSync(
      `curl -sL --max-time 15 --user-agent "Mozilla/5.0" ${JSON.stringify(url)} | head -c 20000`,
      { encoding: "utf-8", timeout: 20000 }
    );
    return { output: result || "(empty response)", isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Fetch error: ${msg}`, isError: true };
  }
}

// ── TodoWriteTool ────────────────────────────────────────────────────────────

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  note?: string;
}

// Listeners so chatViewProvider can push todo updates to the webview
const todoListeners: Array<(todos: TodoItem[]) => void> = [];

export function onTodoUpdate(fn: (todos: TodoItem[]) => void): () => void {
  todoListeners.push(fn);
  return () => {
    const i = todoListeners.indexOf(fn);
    if (i >= 0) todoListeners.splice(i, 1);
  };
}

function todoWrite(todos: TodoItem[]): { output: string; isError: boolean } {
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
