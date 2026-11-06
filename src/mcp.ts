import { hostOf, networkError } from "./auth";
import { CliError } from "./runtime/errors";
import { MCP_REQUEST_TIMEOUT_MS, requestSignal, type Io } from "./runtime/io";

// A small MCP client over Streamable HTTP: initialize once per run, then
// tools/list and tools/call. Reads retry on transient failures; writes retry
// only because every write carries a requestId, which Secani treats as an
// idempotency key, so a resend can't apply a change twice.

const PROTOCOL_VERSION = "2025-06-18";
const ATTEMPTS = 3;

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
};

/** A tool answered with an error result (isError). */
export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    readonly remoteMessage: string,
    readonly extra: Record<string, unknown>,
  ) {
    super(`${code}: ${remoteMessage}`);
    this.name = "ToolFailure";
  }
}

export type CallOptions = {
  /** The call changes data; a failure after sending is an unknown outcome unless keyed. */
  write: boolean;
  /** Idempotency key sent as requestId; makes a write safe to resend. */
  requestId?: string;
};

type Tokens = {
  get(): Promise<string>;
  /** A fresh token after a 401. */
  refresh(): Promise<string>;
};

type RpcResponse = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class McpClient {
  private sessionId: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;

  constructor(
    private readonly io: Io,
    readonly url: string,
    private readonly tokens: Tokens,
    private readonly version: string,
    private readonly debug: (message: string) => void,
  ) {}

  private async post(body: unknown, token: string): Promise<Response> {
    return await this.io.fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "user-agent": `secani-cli/${this.version}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: requestSignal(this.io.signal, MCP_REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * One JSON-RPC exchange with bounded retries. `safe` says whether resending
   * can't duplicate an effect (reads, keyed writes, the handshake).
   */
  private async rpc(method: string, params: unknown, options: { notification?: boolean; safe: boolean; write?: boolean }): Promise<RpcResponse> {
    const id = options.notification ? undefined : this.nextId++;
    const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(id === undefined ? {} : { id }) };
    let token = await this.tokens.get();
    let refreshed = false;
    let lastError: CliError | undefined;
    let sent = false;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        this.debug(`retrying ${method} (attempt ${attempt} of ${ATTEMPTS})`);
        await this.io.sleep(Math.min(4000, 400 * 2 ** (attempt - 2)), this.io.signal);
      }
      let response: Response;
      try {
        this.debug(`POST ${this.url} ${method}`);
        response = await this.post(body, token);
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        sent = true;
        lastError = networkError(this.url, error);
        if (!options.safe) break;
        continue;
      }
      this.debug(`${response.status} ${method}`);
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.tokens.refresh();
        attempt -= 1;
        continue;
      }
      if (response.status === 401) {
        throw new CliError({
          class: "authentication",
          reason: "token_expired",
          message: "Your login expired.",
          userActionRequired: true,
          actionRequired: true,
          recovery: [{ instruction: "Log in again", command: { argv: ["secani", "login"] } }],
        });
      }
      if (response.status === 403) {
        throw new CliError({
          class: "permission",
          reason: "permission_denied",
          message: "This login can't use Secani's MCP server.",
          recovery: [{ instruction: "Log in with an account that has access", command: { argv: ["secani", "login"] } }],
        });
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || undefined;
        lastError = new CliError({
          class: "rate_limit",
          reason: "rate_limited",
          message: `Too many requests to Secani. Try again in ${retryAfter ?? 30} seconds.`,
          retryable: true,
          retryAfter: retryAfter ?? 30,
        });
        // A 429 means the request wasn't applied, so any call may wait and resend.
        if (retryAfter !== undefined && retryAfter > 10) break;
        if (retryAfter !== undefined) await this.io.sleep(retryAfter * 1000, this.io.signal);
        continue;
      }
      if (response.status >= 500) {
        sent = true;
        lastError = new CliError({
          class: "platform",
          reason: "api_error",
          message: `Failed to reach Secani's MCP server. It returned an error.`,
          detail: [`HTTP Status     ${response.status}`],
          ...(response.headers.get("x-vercel-id") ? { requestId: response.headers.get("x-vercel-id")! } : {}),
        });
        if (!options.safe) break;
        continue;
      }
      if (response.status === 404 && this.sessionId && method !== "initialize") {
        // The server forgot the session: start a new one and resend.
        this.sessionId = undefined;
        this.initialized = undefined;
        await this.initialize();
        attempt -= 1;
        continue;
      }
      if (options.notification) return {};
      if (!response.ok) {
        throw new CliError({
          class: "platform",
          reason: "api_error",
          message: `Failed to call Secani's MCP server at ${hostOf(this.url)}.`,
          detail: [`HTTP Status     ${response.status}`],
        });
      }
      try {
        return await this.readResponse(response, id!);
      } catch (error) {
        // The body stopped arriving (a timeout or a dropped connection): the
        // server may have acted, so only a safe call is resent.
        if (error instanceof CliError || (error as Error)?.name === "AbortError") throw error;
        sent = true;
        lastError = networkError(this.url, error);
        if (!options.safe) break;
        continue;
      }
    }
    if (options.write && sent && lastError && lastError.init.class !== "rate_limit") {
      throw new CliError({
        class: "unknown_outcome",
        reason: "unknown_outcome",
        message: "Can't confirm whether the change was saved. The request failed after it was sent.",
        detail: lastError.init.detail ?? [],
        retryable: false,
        ...(lastError.init.requestId ? { requestId: lastError.init.requestId } : {}),
      });
    }
    throw lastError ?? new CliError({ class: "internal", reason: "internal_error", message: "Unexpected error in the MCP client. This is a bug in Secani CLI." });
  }

  private async readResponse(response: Response, id: number): Promise<RpcResponse> {
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const messages: RpcResponse[] = [];
    try {
      if (type.includes("text/event-stream")) {
        // Each event's data lines form one JSON-RPC message.
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) messages.push(JSON.parse(data) as RpcResponse);
        }
      } else if (text) {
        const parsed = JSON.parse(text) as RpcResponse | RpcResponse[];
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      }
    } catch {
      throw new CliError({
        class: "platform",
        reason: "api_error",
        message: "Failed to read the answer from Secani's MCP server. It wasn't valid JSON.",
      });
    }
    const match = messages.find((message) => (message as { id?: unknown }).id === id);
    if (!match) {
      throw new CliError({
        class: "platform",
        reason: "api_error",
        message: "Failed to read the answer from Secani's MCP server. The response was empty.",
      });
    }
    return match;
  }

  async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const response = await this.rpc(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "secani-cli", title: "Secani CLI", version: this.version },
        },
        { safe: true },
      );
      if (response.error) throw rpcError(response.error);
      await this.rpc("notifications/initialized", undefined, { notification: true, safe: true });
    })();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = undefined;
      throw error;
    }
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.rpc("tools/list", cursor ? { cursor } : {}, { safe: true });
      if (response.error) throw rpcError(response.error);
      const result = response.result as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Calls one tool; returns its structured result or throws a ToolFailure. */
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<Record<string, unknown>> {
    await this.initialize();
    const params = { name, arguments: options.requestId ? { ...args, requestId: options.requestId } : args };
    const response = await this.rpc("tools/call", params, {
      safe: !options.write || Boolean(options.requestId),
      write: options.write,
    });
    if (response.error) throw rpcError(response.error);
    const result = (response.result ?? {}) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("\n");
    if (result.isError) {
      const structured = result.structuredContent?.error as { code?: unknown; message?: unknown } | undefined;
      if (structured && typeof structured.code === "string") {
        const { code, message, ...extra } = structured as Record<string, unknown>;
        throw new ToolFailure(String(code), typeof message === "string" ? message : text, extra);
      }
      const codeMatch = /^([A-Z_]{3,}):\s*([\s\S]*)$/.exec(text);
      if (codeMatch) throw new ToolFailure(codeMatch[1]!, codeMatch[2]!, {});
      if (/input validation/i.test(text)) throw new ToolFailure("VALIDATION_FAILED", text, {});
      throw new ToolFailure("INTERNAL", text, {});
    }
    if (result.structuredContent) return result.structuredContent;
    // Older tools answer with JSON text only.
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Plain text.
    }
    return { text };
  }
}

function rpcError(error: { code: number; message: string }): Error {
  if (error.code === -32602) return new ToolFailure("VALIDATION_FAILED", error.message, {});
  if (error.code === -32601) return new ToolFailure("TOOL_NOT_FOUND", error.message, {});
  return new ToolFailure("INTERNAL", error.message, {});
}
