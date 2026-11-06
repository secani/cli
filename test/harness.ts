import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/main";
import type { Io } from "../src/runtime/io";

// A fake world for end-to-end tests of the CLI: captured streams, a fixed
// clock, scripted prompt answers, and a fetch that plays Secani's OAuth
// metadata, AuthKit's device flow and the MCP server.

export const SERVER = "https://mcp.secani.com/mcp";
export const ISSUER = "https://auth.example.test";
export const NOW = Date.parse("2026-11-06T12:00:00Z");

export type ToolHandler = (args: Record<string, unknown>, call: number) => ToolReply | Promise<ToolReply>;
export type ToolReply =
  | { result: Record<string, unknown> }
  | { error: { code: string; message: string; [key: string]: unknown } }
  | { http: number; headers?: Record<string, string> }
  | { network: true };

export type ToolDef = {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
  properties?: string[];
  required?: string[];
  handler: ToolHandler;
};

export type World = {
  configDir: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  tools: Map<string, ToolDef>;
  tokenRequests: Array<Record<string, string>>;
  /** Device-flow polls answered "authorization_pending" before success. */
  pendingPolls: number;
  accessToken: string;
  /** Access tokens the MCP server accepts. */
  validTokens: Set<string>;
  opened: string[];
  cleanup(): void;
};

export function createWorld(): World {
  const configDir = mkdtempSync(join(tmpdir(), "secani-cli-test-"));
  return {
    configDir,
    calls: [],
    tools: new Map(),
    tokenRequests: [],
    pendingPolls: 1,
    accessToken: "access-1",
    validTokens: new Set(["access-1", "env-token"]),
    opened: [],
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

export function tool(world: World, def: ToolDef): void {
  world.tools.set(def.name, def);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sse(body: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
  });
}

export function fakeFetch(world: World): typeof fetch {
  let refreshes = 0;
  const callCounts = new Map<string, number>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const href = `${url.origin}${url.pathname}`;
    if (href === "https://mcp.secani.com/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: SERVER, authorization_servers: [ISSUER] });
    }
    if (href === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/oauth2/token`,
        registration_endpoint: `${ISSUER}/oauth2/register`,
        device_authorization_endpoint: `${ISSUER}/oauth2/device_authorization`,
      });
    }
    if (href === `${ISSUER}/oauth2/register`) return json({ client_id: "client_cli" }, 201);
    if (href === `${ISSUER}/oauth2/device_authorization`) {
      return json({
        device_code: "device-1",
        user_code: "WDJB-MJHT",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=WDJB-MJHT`,
        expires_in: 300,
        interval: 5,
      });
    }
    if (href === `${ISSUER}/oauth2/token`) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      world.tokenRequests.push(form);
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        if (world.pendingPolls > 0) {
          world.pendingPolls -= 1;
          return json({ error: "authorization_pending" }, 400);
        }
        return json({ access_token: world.accessToken, refresh_token: "refresh-1", expires_in: 300 });
      }
      if (form.grant_type === "refresh_token") {
        if (form.refresh_token !== "refresh-1") return json({ error: "invalid_grant" }, 400);
        refreshes += 1;
        const token = `access-refreshed-${refreshes}`;
        world.validTokens.add(token);
        return json({ access_token: token, expires_in: 300 });
      }
    }
    if (href === SERVER) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!world.validTokens.has(auth.replace(/^Bearer /, ""))) return new Response("", { status: 401 });
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown>; cursor?: string } };
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize") {
        return sse({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "secani", version: "1" } } });
      }
      if (message.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [...world.tools.values()].map((def) => ({
              name: def.name,
              title: def.name.replace(/_/g, " "),
              description: `Does ${def.name}.`,
              inputSchema: {
                type: "object",
                properties: Object.fromEntries((def.properties ?? []).map((name) => [name, { type: "string" }])),
                required: def.required ?? [],
              },
              annotations: { readOnlyHint: def.readOnly !== false, destructiveHint: def.destructive === true },
            })),
          },
        });
      }
      if (message.method === "tools/call") {
        const name = message.params!.name;
        const args = message.params!.arguments;
        world.calls.push({ tool: name, args });
        const def = world.tools.get(name);
        if (!def) return json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Tool ${name} not found` } });
        const count = (callCounts.get(name) ?? 0) + 1;
        callCounts.set(name, count);
        const reply = await def.handler(args, count);
        if ("network" in reply) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        if ("http" in reply) return new Response("", { status: reply.http, headers: reply.headers ?? {} });
        if ("error" in reply) {
          return sse({
            jsonrpc: "2.0",
            id: message.id,
            result: { isError: true, content: [{ type: "text", text: `${reply.error.code}: ${reply.error.message}` }], structuredContent: { error: reply.error } },
          });
        }
        return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: reply.result } });
      }
      return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  }) as typeof fetch;
}

export type RunOptions = {
  tty?: boolean;
  stdoutTTY?: boolean;
  env?: Record<string, string>;
  answers?: string[];
  stdin?: string;
  columns?: number;
};

export type RunResult = { code: number; stdout: string; stderr: string; prompts: string[] };

export async function run(world: World, argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const tty = options.tty ?? false;
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  let clock = NOW;
  const io: Io = {
    stdout: { write: (text) => void (stdout += text), isTTY: options.stdoutTTY ?? tty, columns: options.columns ?? 100 },
    stderr: { write: (text) => void (stderr += text), isTTY: tty, columns: options.columns ?? 100 },
    stdinIsTTY: tty,
    env: { SECANI_CONFIG_DIR: world.configDir, TERM: "xterm-256color", NO_COLOR: "1", ...options.env },
    platform: "linux",
    fetch: fakeFetch(world),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readLine: async (question) => {
      prompts.push(question);
      const answer = answers.shift();
      return answer === undefined ? null : answer;
    },
    readStdin: async () => options.stdin ?? "",
    openUrl: async (url) => {
      world.opened.push(url);
      return true;
    },
    signal: new AbortController().signal,
    homedir: world.configDir,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr, prompts };
}

/** Stores a valid login without running the device flow. */
export async function loggedIn(world: World, expiresIn = 300_000): Promise<void> {
  const { Store, saveLogin } = await import("../src/config");
  await saveLogin(new Store(world.configDir), SERVER, {
    issuer: ISSUER,
    clientId: "client_cli",
    tokenEndpoint: `${ISSUER}/oauth2/token`,
    accessToken: world.accessToken,
    refreshToken: "refresh-1",
    expiresAt: NOW + expiresIn,
  });
}

export function whoamiTool(world: World, workspaces: string[] = ["acme/isms"], scopes: Array<{ governanceScopeId: string; name: string }> = [{ governanceScopeId: "scope_iso", name: "ISO 27001" }], readOnlyMode = false): void {
  tool(world, {
    name: "whoami",
    handler: () => {
      const orgs = new Map<string, string[]>();
      for (const ref of workspaces) {
        const [org, ws] = ref.split("/") as [string, string];
        orgs.set(org, [...(orgs.get(org) ?? []), ws]);
      }
      return {
        result: {
          user: { workosUserId: "user_1" },
          connector: { clientId: "client_cli", readOnlyMode },
          organizations: [...orgs.entries()].map(([slug, wss]) => ({
            organizationId: `org_${slug}`,
            name: slug.toUpperCase(),
            slug,
            accessLevel: "write",
            effect: "full",
            roles: ["owner"],
            canWrite: !readOnlyMode,
            workspaces: wss.map((ws) => ({ workspaceId: `ws_${ws}`, name: ws.toUpperCase(), slug: ws, governanceScopes: scopes, governanceScopesTruncated: false })),
          })),
        },
      };
    },
  });
}

export function jsonLine(text: string): Record<string, unknown> {
  const lines = text.trim().split("\n");
  expectOne(lines.length);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function expectOne(count: number): void {
  if (count !== 1) throw new Error(`expected one line of JSON, got ${count}`);
}
