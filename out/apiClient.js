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
exports.ClawApiClient = void 0;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const url_1 = require("url");
class ClawApiClient {
    baseUrl = "";
    apiKey = "";
    model = "";
    maxTokens = 8192;
    abortController = null;
    constructor() {
        this.reloadConfig();
    }
    reloadConfig() {
        const config = vscode.workspace.getConfiguration("miloCode");
        this.baseUrl = config.get("baseUrl", "https://api.inferx.x-or.cloud");
        this.apiKey = config.get("apiKey", "");
        this.model = config.get("model", "gemma4");
        this.maxTokens = config.get("maxTokens", 8192);
    }
    isConfigured() {
        return this.apiKey.length > 0 && this.baseUrl.length > 0;
    }
    abort() {
        this.abortController?.abort();
        this.abortController = null;
    }
    async *streamMessage(messages, systemPrompt, tools) {
        if (!this.isConfigured()) {
            yield { type: "error", error: "API key chưa được cấu hình. Vào Settings → Claw Code → API Key" };
            return;
        }
        this.abortController = new AbortController();
        const body = {
            model: this.model,
            max_tokens: this.maxTokens,
            stream: true,
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        };
        if (systemPrompt) {
            body.system = systemPrompt;
        }
        if (tools && tools.length > 0) {
            body.tools = tools;
        }
        const url = new url_1.URL("/v1/messages", this.baseUrl);
        const isHttps = url.protocol === "https:";
        const transport = isHttps ? https : http;
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
            },
        };
        const payload = JSON.stringify(body);
        yield* this.doStreamRequest(transport, options, payload);
    }
    async *doStreamRequest(transport, options, payload) {
        const abortCtrl = this.abortController;
        const response = await new Promise((resolve, reject) => {
            const req = transport.request(options, resolve);
            req.on("error", reject);
            if (abortCtrl) {
                abortCtrl.signal.addEventListener("abort", () => {
                    req.destroy();
                    reject(new Error("aborted"));
                });
            }
            req.write(payload);
            req.end();
        });
        if (response.statusCode !== 200) {
            let errorBody = "";
            for await (const chunk of response) {
                errorBody += chunk.toString();
            }
            yield {
                type: "error",
                error: `API error ${response.statusCode}: ${errorBody.slice(0, 500)}`,
            };
            return;
        }
        let buffer = "";
        for await (const chunk of response) {
            if (abortCtrl?.signal.aborted) {
                yield { type: "stop", stopReason: "user_cancelled" };
                return;
            }
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                const delta = this.parseSseLine(line);
                if (delta) {
                    yield delta;
                    if (delta.type === "stop")
                        return;
                }
            }
        }
    }
    parseSseLine(line) {
        if (!line.startsWith("data: "))
            return null;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]")
            return null;
        try {
            const event = JSON.parse(data);
            switch (event.type) {
                case "content_block_start":
                    if (event.content_block?.type === "tool_use") {
                        return {
                            type: "tool_use_start",
                            toolName: event.content_block.name,
                            toolId: event.content_block.id,
                        };
                    }
                    if (event.content_block?.type === "thinking") {
                        return { type: "thinking_start" };
                    }
                    return null;
                case "content_block_delta":
                    if (event.delta?.type === "text_delta") {
                        return { type: "text", text: event.delta.text };
                    }
                    if (event.delta?.type === "input_json_delta") {
                        return { type: "tool_input", partialJson: event.delta.partial_json };
                    }
                    if (event.delta?.type === "thinking_delta") {
                        return { type: "thinking_delta", text: event.delta.thinking };
                    }
                    return null;
                case "content_block_stop":
                    // Signal end of thinking block so UI can finalize it
                    return null; // handled implicitly by next content_block_start
                case "message_delta":
                    return {
                        type: "stop",
                        stopReason: event.delta?.stop_reason || "end_turn",
                    };
                case "message_stop":
                    return { type: "stop", stopReason: "end_turn" };
                case "error":
                    return { type: "error", error: event.error?.message || "Unknown error" };
                default:
                    return null;
            }
        }
        catch {
            return null;
        }
    }
}
exports.ClawApiClient = ClawApiClient;
//# sourceMappingURL=apiClient.js.map