import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const MILO_DIR = path.join(os.homedir(), ".milo");
const BIN_DIR = path.join(MILO_DIR, "bin");
function getClawBinaryName(): string {
  if (process.platform === "win32") return "claw.exe";
  return "claw";
}

function getDownloadFileName(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "claw-linux-x64";
  if (platform === "linux" && arch === "arm64") return "claw-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "claw-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "claw-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "claw-windows-x64.exe";
  return "claw-linux-x64"; // fallback
}

export interface ClawResult {
  message: string;
  model: string;
  iterations: number;
  estimated_cost: string;
  tool_uses: { id: string; name: string; input: string }[];
  tool_results: { tool_use_id: string; tool_name: string; output: string; is_error: boolean }[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
}

export interface ClawStreamEvent {
  type: "stdout" | "stderr" | "done" | "error" | "downloading" | "text_delta" | "tool_start" | "tool_done" | "permission_prompt";
  text?: string;
  result?: ClawResult;
  error?: string;
  progress?: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolIsError?: boolean;
  permissionName?: string;
  permissionInput?: string;
}

export class ClawProcess {
  private proc: cp.ChildProcess | null = null;
  private hasSession = false;
  private binaryReady = false; // cached after first successful ensureInstalled

  resetSession() {
    this.hasSession = false;
  }

  private getClawPath(): string {
    // 1. User override in settings
    const config = vscode.workspace.getConfiguration("miloCode");
    const custom = config.get<string>("clawPath", "");
    if (custom && custom !== "claw" && custom !== "") {
      return custom;
    }

    // 2. Bundled in ~/.milo/bin/
    const bundled = path.join(BIN_DIR, getClawBinaryName());
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    // 3. System PATH
    return "claw";
  }

  private getDownloadUrl(): string {
    const config = vscode.workspace.getConfiguration("miloCode");
    const baseUrl = config.get<string>("baseUrl", "https://api.inferx.x-or.cloud");
    const fileName = getDownloadFileName();
    return `${baseUrl}/downloads/${fileName}`;
  }

  // Expected minimum version — bump this together with deploying a new binary to force auto-update
  private static readonly MIN_VERSION = "0.2.0";

  private getBinaryVersion(binaryPath: string): string | null {
    try {
      const out = cp.execSync(`"${binaryPath}" --version 2>&1`, { encoding: "utf-8", timeout: 5000 });
      // Output: "Claw Code\n  Version          0.1.0\n..."
      const match = out.match(/Version\s+([\d.]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private isVersionOutdated(version: string | null): boolean {
    if (!version) return true;
    const [maj, min, patch] = version.split(".").map(Number);
    const [rMaj, rMin, rPatch] = ClawProcess.MIN_VERSION.split(".").map(Number);
    if (maj !== rMaj) return maj < rMaj;
    if (min !== rMin) return min < rMin;
    return patch < rPatch;
  }

  isInstalled(): boolean {
    const clawPath = this.getClawPath();

    // Check bundled
    if (fs.existsSync(clawPath)) return true;

    // Check system PATH
    try {
      cp.execSync(`which ${clawPath} 2>/dev/null || where ${clawPath} 2>nul`, { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  async ensureInstalled(onEvent: (event: ClawStreamEvent) => void): Promise<boolean> {
    if (this.binaryReady) return true; // already verified this session

    const destPath = path.join(BIN_DIR, getClawBinaryName());

    // Check if binary needs update
    if (fs.existsSync(destPath)) {
      const version = this.getBinaryVersion(destPath);
      if (this.isVersionOutdated(version)) {
        onEvent({ type: "downloading", text: `Updating Claw engine (${version ?? "unknown"} → ${ClawProcess.MIN_VERSION})...`, progress: 0 });
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      } else {
        this.binaryReady = true;
        return true; // up to date
      }
    } else if (this.isInstalled()) {
      this.binaryReady = true;
      return true; // system PATH binary, skip version check
    } else {
      onEvent({ type: "downloading", text: "Downloading Claw Code engine...", progress: 0 });
    }

    try {
      // Create ~/.milo/bin/
      if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
      }

      const downloadUrl = this.getDownloadUrl();

      let lastReported = -1;
      await this.downloadFile(downloadUrl, destPath, (progress) => {
        // Throttle: only emit every 10% to avoid spamming the UI
        const bucket = Math.floor(progress / 10) * 10;
        if (bucket > lastReported) {
          lastReported = bucket;
          onEvent({ type: "downloading", text: `Downloading... ${progress}%`, progress });
        }
      });

      // Make executable
      fs.chmodSync(destPath, 0o755);

      // Verify
      try {
        const version = cp.execSync(`"${destPath}" --version`, { encoding: "utf-8", timeout: 5000 });
        onEvent({ type: "downloading", text: `Installed: ${version.trim()}`, progress: 100 });
      } catch {
        onEvent({ type: "downloading", text: "Installed successfully", progress: 100 });
      }

      this.binaryReady = true;
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", error: `Failed to download Claw Code engine: ${msg}` });
      return false;
    }
  }

  private downloadFile(
    url: string,
    dest: string,
    onProgress: (percent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;

      const request = transport.get(url, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const location = response.headers.location;
          if (location) {
            this.downloadFile(location, dest, onProgress).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers["content-length"] || "0", 10);
        let downloaded = 0;

        const file = fs.createWriteStream(dest);
        response.pipe(file);

        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            onProgress(Math.round((downloaded / totalSize) * 100));
          }
        });

        file.on("finish", () => {
          file.close();
          resolve();
        });

        file.on("error", (err) => {
          fs.unlinkSync(dest);
          reject(err);
        });
      });

      request.on("error", reject);
      request.setTimeout(120000, () => {
        request.destroy();
        reject(new Error("Download timeout"));
      });
    });
  }

  private getEnv(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration("miloCode");
    const apiKey = config.get<string>("apiKey", "");
    const baseUrl = config.get<string>("baseUrl", "https://api.inferx.x-or.cloud");

    return {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
    };
  }

  private getArgs(prompt: string): string[] {
    const config = vscode.workspace.getConfiguration("miloCode");
    const model = config.get<string>("model", "gemma4");
    const permissionMode = config.get<string>("permissionMode", "default");

    const args = [
      "--model", model,
      "--output-format", "json",
      "--permission-mode", permissionMode,
    ];

    // Resume previous session for conversation continuity
    if (this.hasSession) {
      args.push("--resume", "latest");
    }

    args.push(prompt);
    return args;
  }

  /** Send permission response ('y' = allow, 'n' = deny) to the running binary via stdin. */
  sendPermissionResponse(allow: boolean): void {
    if (this.proc?.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(allow ? "y\n" : "n\n");
    }
  }

  isConfigured(): boolean {
    const config = vscode.workspace.getConfiguration("miloCode");
    const apiKey = config.get<string>("apiKey", "");
    return apiKey.length > 0;
  }

  async run(
    prompt: string,
    cwd: string,
    onEvent: (event: ClawStreamEvent) => void
  ): Promise<void> {
    // Auto-download if needed
    const installed = await this.ensureInstalled(onEvent);
    if (!installed) return;

    const clawPath = this.getClawPath();
    const args = this.getArgs(prompt);
    const env = this.getEnv();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let stderrBuf = ""; // partial-line buffer for streaming events

      this.proc = cp.spawn(clawPath, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Keep stdin open so we can write permission responses later

      this.proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      const parseStderrLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) return;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.event === "text_delta") {
            onEvent({ type: "text_delta" as const, text: evt.text });
          } else if (evt.event === "tool_start") {
            onEvent({ type: "tool_start" as const, toolName: evt.name, toolInput: evt.input });
          } else if (evt.event === "tool_done") {
            onEvent({ type: "tool_done" as const, toolName: evt.name, toolOutput: evt.output, toolIsError: evt.is_error });
          } else if (evt.event === "permission_prompt") {
            onEvent({ type: "permission_prompt" as const, permissionName: evt.name, permissionInput: evt.input ?? evt.command ?? "" });
          }
        } catch {
          // Not JSON — ignore
        }
      };

      this.proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;

        // Buffer partial lines — a chunk may not end on a newline boundary
        stderrBuf += text;
        const lines = stderrBuf.split("\n");
        // Keep the last element (may be incomplete) in the buffer
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
          parseStderrLine(line);
        }
      });

      this.proc.on("error", (err: Error) => {
        onEvent({ type: "error", error: `Cannot start claw: ${err.message}` });
        resolve();
      });

      this.proc.on("close", (code) => {
        // Flush any remaining partial line in buffer
        if (stderrBuf.trim()) parseStderrLine(stderrBuf);
        stderrBuf = "";

        if (code === 0 && stdout.trim()) {
          this.hasSession = true;
          try {
            const result = JSON.parse(stdout.trim()) as ClawResult;
            onEvent({ type: "done", result });
          } catch {
            onEvent({
              type: "done",
              result: {
                message: stdout.trim(),
                model: "", iterations: 0, estimated_cost: "",
                tool_uses: [], tool_results: [],
                usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              },
            });
          }
        } else if (code !== 0) {
          const errorMsg = stderr.trim() || stdout.trim() || `claw exited with code ${code}`;
          onEvent({ type: "error", error: errorMsg });
        }
        this.proc = null;
        resolve();
      });
    });
  }

  kill() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
