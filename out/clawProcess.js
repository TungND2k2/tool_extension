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
exports.ClawProcess = void 0;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const MILO_DIR = path.join(os.homedir(), ".milo");
const BIN_DIR = path.join(MILO_DIR, "bin");
function getClawBinaryName() {
    if (process.platform === "win32")
        return "claw.exe";
    return "claw";
}
function getDownloadFileName() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === "linux" && arch === "x64")
        return "claw-linux-x64";
    if (platform === "linux" && arch === "arm64")
        return "claw-linux-arm64";
    if (platform === "darwin" && arch === "x64")
        return "claw-darwin-x64";
    if (platform === "darwin" && arch === "arm64")
        return "claw-darwin-arm64";
    if (platform === "win32" && arch === "x64")
        return "claw-windows-x64.exe";
    return "claw-linux-x64"; // fallback
}
class ClawProcess {
    proc = null;
    hasSession = false;
    resetSession() {
        this.hasSession = false;
    }
    getClawPath() {
        // 1. User override in settings
        const config = vscode.workspace.getConfiguration("miloCode");
        const custom = config.get("clawPath", "");
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
    getDownloadUrl() {
        const config = vscode.workspace.getConfiguration("miloCode");
        const baseUrl = config.get("baseUrl", "https://api.inferx.x-or.cloud");
        const fileName = getDownloadFileName();
        return `${baseUrl}/downloads/${fileName}`;
    }
    // Expected minimum version — bump this together with deploying a new binary to force auto-update
    static MIN_VERSION = "0.1.0";
    getBinaryVersion(binaryPath) {
        try {
            const out = cp.execSync(`"${binaryPath}" --version 2>&1`, { encoding: "utf-8", timeout: 5000 });
            // Output: "Claw Code\n  Version          0.1.0\n..."
            const match = out.match(/Version\s+([\d.]+)/);
            return match ? match[1] : null;
        }
        catch {
            return null;
        }
    }
    isVersionOutdated(version) {
        if (!version)
            return true;
        const [maj, min, patch] = version.split(".").map(Number);
        const [rMaj, rMin, rPatch] = ClawProcess.MIN_VERSION.split(".").map(Number);
        if (maj !== rMaj)
            return maj < rMaj;
        if (min !== rMin)
            return min < rMin;
        return patch < rPatch;
    }
    isInstalled() {
        const clawPath = this.getClawPath();
        // Check bundled
        if (fs.existsSync(clawPath))
            return true;
        // Check system PATH
        try {
            cp.execSync(`which ${clawPath} 2>/dev/null || where ${clawPath} 2>nul`, { encoding: "utf-8" });
            return true;
        }
        catch {
            return false;
        }
    }
    async ensureInstalled(onEvent) {
        const destPath = path.join(BIN_DIR, getClawBinaryName());
        // Check if binary needs update
        if (fs.existsSync(destPath)) {
            const version = this.getBinaryVersion(destPath);
            if (this.isVersionOutdated(version)) {
                onEvent({ type: "downloading", text: `Updating Claw engine (${version ?? "unknown"} → ${ClawProcess.MIN_VERSION})...`, progress: 0 });
                try {
                    fs.unlinkSync(destPath);
                }
                catch { /* ignore */ }
            }
            else {
                return true; // up to date
            }
        }
        else if (this.isInstalled()) {
            return true; // system PATH binary, skip version check
        }
        else {
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
            }
            catch {
                onEvent({ type: "downloading", text: "Installed successfully", progress: 100 });
            }
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            onEvent({ type: "error", error: `Failed to download Claw Code engine: ${msg}` });
            return false;
        }
    }
    downloadFile(url, dest, onProgress) {
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
                response.on("data", (chunk) => {
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
    getEnv() {
        const config = vscode.workspace.getConfiguration("miloCode");
        const apiKey = config.get("apiKey", "");
        const baseUrl = config.get("baseUrl", "https://api.inferx.x-or.cloud");
        return {
            ...process.env,
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_BASE_URL: baseUrl,
        };
    }
    getArgs(prompt) {
        const config = vscode.workspace.getConfiguration("miloCode");
        const model = config.get("model", "gemma4");
        const permissionMode = config.get("permissionMode", "workspace-write");
        const args = [
            "--model", model,
            "--output-format", "json",
            "--permission-mode", permissionMode,
            "--dangerously-skip-permissions",
        ];
        // Resume previous session for conversation continuity
        if (this.hasSession) {
            args.push("--resume", "latest");
        }
        args.push(prompt);
        return args;
    }
    isConfigured() {
        const config = vscode.workspace.getConfiguration("miloCode");
        const apiKey = config.get("apiKey", "");
        return apiKey.length > 0;
    }
    async run(prompt, cwd, onEvent) {
        // Auto-download if needed
        const installed = await this.ensureInstalled(onEvent);
        if (!installed)
            return;
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
            // Close stdin immediately — binary must not wait for user input
            this.proc.stdin?.end();
            this.proc.stdout?.on("data", (data) => {
                stdout += data.toString();
            });
            const parseStderrLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("{"))
                    return;
                try {
                    const evt = JSON.parse(trimmed);
                    if (evt.event === "text_delta") {
                        onEvent({ type: "text_delta", text: evt.text });
                    }
                    else if (evt.event === "tool_start") {
                        onEvent({ type: "tool_start", toolName: evt.name, toolInput: evt.input });
                    }
                    else if (evt.event === "tool_done") {
                        onEvent({ type: "tool_done", toolName: evt.name, toolOutput: evt.output, toolIsError: evt.is_error });
                    }
                }
                catch {
                    // Not JSON — ignore
                }
            };
            this.proc.stderr?.on("data", (data) => {
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
            this.proc.on("error", (err) => {
                onEvent({ type: "error", error: `Cannot start claw: ${err.message}` });
                resolve();
            });
            this.proc.on("close", (code) => {
                // Flush any remaining partial line in buffer
                if (stderrBuf.trim())
                    parseStderrLine(stderrBuf);
                stderrBuf = "";
                if (code === 0 && stdout.trim()) {
                    this.hasSession = true;
                    try {
                        const result = JSON.parse(stdout.trim());
                        onEvent({ type: "done", result });
                    }
                    catch {
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
                }
                else if (code !== 0) {
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
exports.ClawProcess = ClawProcess;
//# sourceMappingURL=clawProcess.js.map