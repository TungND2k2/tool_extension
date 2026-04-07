import * as fs from "fs";
import * as path from "path";

const MILO_DIR = ".milo";
const CONTEXT_FILE = "context.md";

/**
 * Scan workspace directory tree (max 3 levels deep, skip node_modules etc.)
 */
function scanTree(dir: string, prefix: string = "", depth: number = 0, maxDepth: number = 3): string[] {
  if (depth > maxDepth) return [];
  const skip = new Set(["node_modules", ".git", ".milo", "dist", "build", "out", "__pycache__", ".next", "coverage", ".vscode"]);

  let lines: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !skip.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        lines = lines.concat(scanTree(path.join(dir, entry.name), prefix + "  ", depth + 1, maxDepth));
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  } catch { /* ignore permission errors */ }
  return lines;
}

/**
 * Read existing context.md from workspace
 */
export function readProjectContext(workspaceRoot: string): string {
  const contextPath = path.join(workspaceRoot, MILO_DIR, CONTEXT_FILE);
  if (fs.existsSync(contextPath)) {
    return fs.readFileSync(contextPath, "utf-8");
  }
  return "";
}

/**
 * Update project context after file operations.
 * Keeps track of: directory tree + file descriptions
 */
export function updateProjectContext(
  workspaceRoot: string,
  action: string,  // "created" | "edited" | "deleted"
  filePath: string,
  description?: string
): void {
  const miloDir = path.join(workspaceRoot, MILO_DIR);
  if (!fs.existsSync(miloDir)) {
    fs.mkdirSync(miloDir, { recursive: true });
  }

  const contextPath = path.join(miloDir, CONTEXT_FILE);

  // Read existing context
  let existing = "";
  const fileDescriptions: Map<string, string> = new Map();

  if (fs.existsSync(contextPath)) {
    existing = fs.readFileSync(contextPath, "utf-8");
    // Parse existing file descriptions
    const descRegex = /^- `(.+?)`: (.+)$/gm;
    let match;
    while ((match = descRegex.exec(existing)) !== null) {
      fileDescriptions.set(match[1], match[2]);
    }
  }

  // Update file description
  const relativePath = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath));
  if (action === "deleted") {
    fileDescriptions.delete(relativePath);
  } else if (description) {
    fileDescriptions.set(relativePath, description);
  } else {
    // Auto-describe based on file extension
    const ext = path.extname(relativePath).toLowerCase();
    const name = path.basename(relativePath);
    const autoDesc = guessDescription(name, ext);
    if (!fileDescriptions.has(relativePath)) {
      fileDescriptions.set(relativePath, autoDesc);
    }
  }

  // Generate new context
  const tree = scanTree(workspaceRoot);
  let content = `# Project Context\n\n`;
  content += `## Directory Structure\n\n`;
  content += "```\n";
  content += tree.join("\n");
  content += "\n```\n\n";

  if (fileDescriptions.size > 0) {
    content += `## File Descriptions\n\n`;
    const sorted = [...fileDescriptions.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [file, desc] of sorted) {
      content += `- \`${file}\`: ${desc}\n`;
    }
    content += "\n";
  }

  content += `_Last updated: ${new Date().toISOString()}_\n`;

  fs.writeFileSync(contextPath, content, "utf-8");
}

/**
 * Read README.md from workspace root (first 3000 chars to avoid token overflow)
 */
function readReadme(workspaceRoot: string): string {
  const candidates = ["README.md", "readme.md", "Readme.md", "README.txt", "readme.txt"];
  for (const name of candidates) {
    const p = path.join(workspaceRoot, name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      if (content.trim().length === 0) return "";
      const trimmed = content.length > 3000 ? content.slice(0, 3000) + "\n...(truncated)" : content;
      return `## README\n\n${trimmed}`;
    }
  }
  return "";
}

/**
 * Generate system prompt with project context
 */
export function getProjectContextPrompt(workspaceRoot: string): string {
  const tree = scanTree(workspaceRoot);
  if (tree.length === 0) return "";

  let result = "\n\n## Workspace Structure\n\n```\n" + tree.join("\n") + "\n```";

  // Inject README content if present
  const readme = readReadme(workspaceRoot);
  if (readme) {
    result += "\n\n" + readme;
  }

  // Inject .milo/context.md file descriptions if present
  const context = readProjectContext(workspaceRoot);
  if (context) {
    // Extract only the File Descriptions section to avoid duplicating tree
    const match = context.match(/## File Descriptions\n\n([\s\S]+?)(\n_Last|$)/);
    if (match) {
      result += "\n\n## File Descriptions\n\n" + match[1].trim();
    }
  }

  return result;
}

function guessDescription(name: string, ext: string): string {
  const map: Record<string, string> = {
    "package.json": "Node.js project config & dependencies",
    "tsconfig.json": "TypeScript configuration",
    "index.html": "Main HTML entry point",
    "index.js": "Main JavaScript entry point",
    "index.ts": "Main TypeScript entry point",
    "app.js": "Express application setup",
    "app.ts": "Express application setup",
    "server.js": "Server entry point",
    "server.ts": "Server entry point",
    ".env": "Environment variables",
    ".gitignore": "Git ignore rules",
    "README.md": "Project documentation",
    "Dockerfile": "Docker container config",
    "docker-compose.yml": "Docker Compose config",
  };
  if (map[name]) return map[name];

  const extMap: Record<string, string> = {
    ".jsx": "React component",
    ".tsx": "React TypeScript component",
    ".css": "Stylesheet",
    ".scss": "SASS stylesheet",
    ".json": "JSON config",
    ".yaml": "YAML config",
    ".yml": "YAML config",
    ".sql": "SQL schema/query",
    ".test.js": "Test file",
    ".test.ts": "Test file",
    ".spec.js": "Test file",
    ".spec.ts": "Test file",
  };

  for (const [pattern, desc] of Object.entries(extMap)) {
    if (name.endsWith(pattern)) return desc;
  }

  return `${ext.slice(1) || "unknown"} file`;
}
