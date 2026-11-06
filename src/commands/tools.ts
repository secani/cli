import { requireConsent } from "../runtime/consent";
import { closest, CliError, usageError } from "../runtime/errors";
import { outcomeLine, rows, table } from "../runtime/layout";
import { FRAMEWORK_OPTION, YES_OPTION, type CommandContext, type CommandSpec, type GroupSpec } from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import type { McpTool } from "../mcp";
import { REQUEST_ID_OPTION, requestId, workspaceArgs } from "./records";

// Every tool of Secani's MCP server, for what the curated commands don't
// cover yet. A tool's result is its own protocol: it prints as JSON.

const TOOL_PATTERN = /^[a-z][a-z0-9_]*$/;

function access(tool: McpTool): string {
  if (tool.annotations?.readOnlyHint) return "Read";
  return tool.annotations?.destructiveHint ? "Write, destructive" : "Write";
}

async function findTool(context: CommandContext, name: string): Promise<McpTool> {
  if (!TOOL_PATTERN.test(name)) {
    throw usageError(`Tool names use lowercase letters, digits and underscores, such as list_risks, not ${JSON.stringify(cleanRemote(name))}.`);
  }
  const tools = await context.session.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool) return tool;
  const suggestion = closest(name, tools.map((candidate) => candidate.name));
  throw new CliError({
    class: "not_found",
    reason: "tool_not_found",
    message: `Couldn't find tool ${name} on Secani's MCP server.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    ...(suggestion ? { data: { suggestion } } : {}),
    recovery: [{ instruction: "List the tools", command: { argv: ["secani", "tools", "list"] } }],
  });
}

const list: CommandSpec = {
  kind: "command",
  name: "list",
  aliases: ["ls"],
  summary: "List the tools of Secani's MCP server",
  consequence: "read",
  options: [{ name: "search", type: "string", value: "<WORDS>", description: "Only tools whose name, title or description contains these words" }],
  examples: [{ title: "Find the tools about vendors", command: "secani tools list --search vendor" }],
  resultSchema: { tools: "array" },
  async run(context) {
    const { out, options } = context;
    let tools = await context.session.client.listTools();
    if (typeof options.search === "string") {
      const words = options.search.toLowerCase().split(/\s+/).filter(Boolean);
      tools = tools.filter((tool) => {
        const text = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      });
    }
    if (out.json) {
      out.document({
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title ?? null,
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true,
        })),
      });
      return;
    }
    if (tools.length === 0) {
      if (!out.out.rich) out.answer("Tool\tAccess\tTitle");
      out.note(typeof options.search === "string" ? "  No tools match this search. Remove --search to see all tools." : "  The server lists no tools.");
      return;
    }
    out.answer(
      table(
        out.out,
        [
          { header: "Tool", human: (tool: McpTool) => tool.name },
          { header: "Access", human: access, raw: (tool) => (tool.annotations?.readOnlyHint ? "read" : tool.annotations?.destructiveHint ? "destructive" : "write") },
          { header: "Title", human: (tool) => tool.title ?? tool.annotations?.title ?? "", flex: true },
        ],
        tools,
      ),
    );
  },
};

const inspect: CommandSpec = {
  kind: "command",
  name: "inspect",
  summary: "Show a tool's description and input schema",
  consequence: "read",
  args: [{ name: "TOOL", description: "The tool's name, such as list_risks", required: true }],
  examples: [{ title: "See what save_vendor takes", command: "secani tools inspect save_vendor" }],
  resultSchema: { tool: "object" },
  async run(context) {
    const { out } = context;
    const tool = await findTool(context, context.args.TOOL!);
    if (out.json) {
      out.document({ tool });
      return;
    }
    out.answer(
      [
        rows(out.out, [
          ["Tool", tool.name],
          ["Title", cleanRemote(tool.title ?? tool.annotations?.title ?? "")],
          ["Access", access(tool)],
        ]),
        "",
        cleanRemote(tool.description ?? "", { multiline: true })
          .split("\n")
          .map((line) => `  ${line}`.replace(/\s+$/, ""))
          .join("\n"),
        "",
        "  Input Schema",
        JSON.stringify(tool.inputSchema ?? {}, null, 2)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      ].join("\n"),
    );
  },
};

const call: CommandSpec = {
  kind: "command",
  name: "call",
  summary: "Call one tool of Secani's MCP server",
  consequence: "destructive",
  args: [{ name: "TOOL", description: "The tool's name, such as list_vendors", required: true }],
  options: [
    { name: "input", type: "string", value: "<JSON>", description: "The tool's arguments as a JSON object; - reads stdin", default: "{}" },
    FRAMEWORK_OPTION,
    REQUEST_ID_OPTION,
    YES_OPTION,
  ],
  examples: [
    { title: "List vendors with reviews due", command: "secani tools call list_vendors --input '{\"reviewsDue\":true}'" },
    { title: "Pass arguments from a file", command: "secani tools call save_vendor --input - < vendor.json" },
  ],
  notes: [
    "Fills organizationSlug and workspaceSlug from the workspace, governanceScopeId from --framework (or the only framework) when the tool needs it, and a requestId for writes, unless --input sets them.",
    "Read tools run directly and ordinary writes run without a prompt; a destructive tool asks first, and needs --yes in non-interactive mode. Prints the tool's structured result as JSON on stdout.",
  ],
  resultSchema: { tool: "string", result: "object" },
  async run(context) {
    const { session, options, out, io } = context;
    const name = context.args.TOOL!;
    let raw = typeof options.input === "string" ? options.input : "{}";
    if (raw === "-") {
      if (io.stdinIsTTY) throw usageError("--input - reads stdin, but stdin is a terminal. Pipe the JSON in, such as: secani tools call <TOOL> --input - < input.json");
      raw = await io.readStdin();
    }
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed as Record<string, unknown>;
    } catch (error) {
      throw usageError(`--input must be a JSON object. ${error instanceof SyntaxError ? error.message : "It isn't an object."}`);
    }
    const tool = await findTool(context, name);
    const properties = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    const write = tool.annotations?.readOnlyHint !== true;
    if ("organizationSlug" in properties && input.organizationSlug === undefined && input.workspaceSlug === undefined) {
      const workspace = await session.workspace();
      if (workspace.source === "saved" || workspace.source === "only") out.context([["Workspace", workspace.ref]]);
      Object.assign(input, workspaceArgs(workspace));
    }
    if ("governanceScopeId" in properties && input.governanceScopeId === undefined) {
      if (typeof options.framework === "string" || required.has("governanceScopeId")) {
        const given = typeof options.framework === "string" ? options.framework : undefined;
        // The workspace --input names, if it names one, holds the framework.
        const org = input.organizationSlug;
        const ws = input.workspaceSlug;
        const target =
          typeof org === "string" && typeof ws === "string"
            ? { organizationSlug: org, workspaceSlug: ws, ref: `${org}/${ws}`, source: "option" as const }
            : undefined;
        input.governanceScopeId = (await session.framework(given, { action: `call ${name}` }, target)).id;
      }
    }
    // A requestId in --input is the idempotency key too, so the call is resent safely.
    if (typeof input.requestId === "string" && typeof options["request-id"] === "string" && input.requestId !== options["request-id"]) {
      throw usageError("Can't use --request-id with a different requestId in --input.", { reason: "conflicting_options" });
    }
    const key =
      typeof input.requestId === "string"
        ? input.requestId
        : "requestId" in properties
          ? requestId(context)
          : undefined;
    if (tool.annotations?.destructiveHint) {
      await requireConsent(context, {
        tier: "destructive",
        question: `Call ${name}?`,
        effects: [`${name} is marked destructive: it can remove data in Secani.`],
        consequence: `${name} runs with ${JSON.stringify(input)}`,
      });
    }
    const result = await session.call(
      name,
      input,
      { action: `call ${name}` },
      { write, ...(key ? { requestId: key } : {}) },
    );
    if (out.json) {
      out.document({ tool: name, result });
      return;
    }
    if (write) out.note(outcomeLine(out.err, "Called", name));
    out.answer(JSON.stringify(result, null, 2));
  },
};

export const tools: GroupSpec = {
  kind: "group",
  name: "tools",
  aliases: ["tool"],
  summary: "List, inspect and call any tool of Secani's MCP server",
  children: [list, inspect, call],
};
