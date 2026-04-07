import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface StreamDelta {
  type: "text" | "thinking_start" | "thinking_delta" | "thinking_end" | "tool_use_start" | "tool_input" | "stop" | "error";
  text?: string;
  toolName?: string;
  toolId?: string;
  partialJson?: string;
  stopReason?: string;
  error?: string;
}

export class ClawApiClient {
  private baseUrl = "";
  private apiKey = "";
  private model = "";
  private maxTokens = 8192;
  private abortController: AbortController | null = null;

  constructor() {
    this.reloadConfig();
  }

  reloadConfig() {
    const config = vscode.workspace.getConfiguration("miloCode");
    this.baseUrl = config.get<string>("baseUrl", "https://api.inferx.x-or.cloud");
    this.apiKey = config.get<string>("apiKey", "");
    this.model = config.get<string>("model", "gemma4");
    this.maxTokens = config.get<number>("maxTokens", 8192);
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0;
  }

  abort() {
    this.abortController?.abort();
    this.abortController = null;
  }

  async *streamMessage(
    messages: Message[],
    systemPrompt?: string,
    tools?: ToolDefinition[]
  ): AsyncGenerator<StreamDelta> {
    if (!this.isConfigured()) {
      yield { type: "error", error: "API key chưa được cấu hình. Vào Settings → Claw Code → API Key" };
      return;
    }

    this.abortController = new AbortController();

    const body: Record<string, unknown> = {
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

    const url = new URL("/v1/messages", this.baseUrl);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const options: http.RequestOptions = {
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

  private async *doStreamRequest(
    transport: typeof http | typeof https,
    options: http.RequestOptions,
    payload: string
  ): AsyncGenerator<StreamDelta> {
    const abortCtrl = this.abortController;

    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
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
      }
    );

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
          if (delta.type === "stop") return;
        }
      }
    }
  }

  private parseSseLine(line: string): StreamDelta | null {
    if (!line.startsWith("data: ")) return null;

    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") return null;

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
    } catch {
      return null;
    }
  }
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}
