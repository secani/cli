import { randomUUID } from "node:crypto";

import { CliError, usageError } from "../runtime/errors";
import { day, when, words } from "../runtime/format";
import { outcomeLine, rows, table, type Column } from "../runtime/layout";
import { nextJson } from "../runtime/output";
import {
  FRAMEWORK_OPTION,
  LIMIT_OPTION,
  NEXT_OPTION,
  type CommandContext,
  type CommandSpec,
  type Example,
  type OptionSpec,
} from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import type { WorkspaceTarget } from "../session";

// The shared engine behind every record group: list (with --limit as a total
// across pages and an opaque, filter-bound --next), inspect, and the write
// receipt. Each group declares its tool, filters, columns and fields.

export type RecordDef = {
  group: string;
  noun: string;
  plural: string;
  /** The stdout identifier and display ID: the app's ID (RI-12) first. */
  identity(item: Record<string, unknown>): string;
};

export type Filter = {
  option: OptionSpec;
  /** Tool input name. */
  input: string;
  map?: (value: string | boolean | string[]) => unknown;
};

export const REQUEST_ID_OPTION: OptionSpec = {
  name: "request-id",
  type: "string",
  value: "<ID>",
  description: "Idempotency key; rerunning with the same one applies the change at most once (default: a new UUID)",
};

export function pick(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

export function workspaceArgs(workspace: WorkspaceTarget): Record<string, string> {
  return { organizationSlug: workspace.organizationSlug, workspaceSlug: workspace.workspaceSlug };
}

/** Shows the workspace when it wasn't named in this invocation. */
export function showWorkspace(context: CommandContext, workspace: WorkspaceTarget, always = false): void {
  if (always || workspace.source === "saved" || workspace.source === "only") {
    context.out.context([["Workspace", workspace.ref]]);
  }
}

/** Keeps --workspace in suggested commands when the person passed it. */
export function withWorkspace(context: CommandContext, argv: string[]): string[] {
  const option = context.options.workspace;
  return typeof option === "string" ? [...argv, "--workspace", option] : argv;
}

type CursorState = { v: 1; w: string; c: string | null; o: number; f: Record<string, unknown> };

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeCursor(token: string): CursorState | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as CursorState;
    if (parsed?.v === 1 && typeof parsed.w === "string" && typeof parsed.o === "number" && typeof parsed.f === "object") return parsed;
  } catch {
    // Falls through.
  }
  return undefined;
}

function sameFilters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

export type ListDef = {
  record: RecordDef;
  summary: string;
  tool: string;
  filters: Filter[];
  /** The tool's own page size cap; omit when the tool takes no limit. */
  pageLimit?: number;
  defaultLimit?: number;
  cap?: number;
  itemsKey?: string;
  cursorKey?: string;
  /** Lists that can narrow to one framework. */
  framework?: boolean;
  columns: Column<Record<string, unknown>>[];
  examples?: Example[];
  notes?: string[];
  /** The command that adds the first record, for first use. */
  firstUse?: { instruction: string; argv: string[] };
};

export function listCommand(def: ListDef): CommandSpec {
  const defaultLimit = def.defaultLimit ?? 20;
  const cap = def.cap ?? 200;
  const filterOptions = def.filters.map((filter) => filter.option);
  return {
    kind: "command",
    name: "list",
    aliases: ["ls"],
    summary: def.summary,
    consequence: "read",
    options: [
      ...filterOptions,
      ...(def.framework ? [FRAMEWORK_OPTION] : []),
      LIMIT_OPTION(defaultLimit, cap),
      NEXT_OPTION,
    ],
    examples: def.examples ?? [],
    notes: [
      `Lists newest first, ${defaultLimit} at a time by default. --limit is a total across pages; filters run on the server and stay fixed across --next pages.`,
      ...(def.notes ?? []),
    ],
    resultSchema: { [def.record.plural]: "array", "pagination.next": "string | null" },
    async run(context) {
      const { session, options, out } = context;
      const workspace = await session.workspace();
      let filters: Record<string, unknown> = {};
      for (const filter of def.filters) {
        const value = options[filter.option.name];
        if (value === undefined) continue;
        filters[filter.input] = filter.map ? filter.map(value) : value;
      }
      if (def.framework && typeof options.framework === "string") {
        filters.governanceScopeId = (await session.framework(options.framework, { action: `list ${def.record.plural}`, workspace: workspace.ref })).id;
      }
      let cursor: string | null = null;
      let offset = 0;
      if (typeof options.next === "string") {
        const state = decodeCursor(options.next);
        if (!state) {
          throw usageError(`--next takes the cursor a previous page printed, not ${JSON.stringify(cleanRemote(options.next))}.`);
        }
        if (state.w !== workspace.ref) {
          throw usageError(`Can't use --next from ${state.w} in ${workspace.ref}. The cursor belongs to another workspace.`, {
            reason: "conflicting_options",
          });
        }
        const givenFilters = Object.keys(filters).length > 0;
        if (givenFilters && !sameFilters(filters, state.f)) {
          throw usageError("Can't change filters with --next. The cursor keeps the filters of its first page.", {
            reason: "conflicting_options",
            recovery: [{ instruction: "Start over with the new filters by leaving out --next." }],
          });
        }
        filters = state.f;
        cursor = state.c;
        offset = state.o;
      }
      let limit = defaultLimit;
      if (typeof options.limit === "string") {
        limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1) throw usageError(`--limit must be a whole number of 1 or more, not ${options.limit}.`);
        if (limit > cap) {
          out.warn("limit_clamped", `--limit is capped at ${cap}. Showing up to ${cap} ${def.record.plural}.`);
          limit = cap;
        }
      }
      const stop = out.progress(`Loading ${def.record.plural}…`);
      const items: Record<string, unknown>[] = [];
      let next: string | null = null;
      try {
        for (let page = 0; page < 100; page += 1) {
          const need = limit - items.length;
          const args: Record<string, unknown> = {
            ...workspaceArgs(workspace),
            ...filters,
            ...(cursor ? { cursor } : {}),
            ...(def.pageLimit ? { limit: Math.min(def.pageLimit, need + offset) } : {}),
          };
          const result = await session.call(def.tool, args, {
            action: `list ${def.record.plural}`,
            workspace: workspace.ref,
          });
          const pageItems = (Array.isArray(result[def.itemsKey ?? "items"]) ? (result[def.itemsKey ?? "items"] as Record<string, unknown>[]) : []).slice(offset);
          const serverNext = result[def.cursorKey ?? "cursor"];
          if (pageItems.length > need) {
            items.push(...pageItems.slice(0, need));
            next = encodeCursor({ v: 1, w: workspace.ref, c: cursor, o: offset + need, f: filters });
            break;
          }
          items.push(...pageItems);
          offset = 0;
          if (typeof serverNext !== "string" || !serverNext) break;
          cursor = serverNext;
          if (items.length >= limit) {
            next = encodeCursor({ v: 1, w: workspace.ref, c: cursor, o: 0, f: filters });
            break;
          }
        }
      } finally {
        stop();
      }

      if (out.json) {
        out.document({
          [def.record.plural]: items,
          pagination: { next },
          ...(next ? { next: [nextJson({ argv: withWorkspace(context, ["secani", def.record.group, "list", "--next", next]) })] } : {}),
        });
        return;
      }
      showWorkspace(context, workspace);
      if (items.length === 0) {
        if (!out.out.rich) out.answer(table(out.out, def.columns, []));
        const filterNames = def.filters.filter((filter) => context.given.has(filter.option.name)).map((filter) => `--${filter.option.name}`);
        if (filterNames.length === 1) {
          out.note(`  No ${def.record.plural} match this filter. Remove ${filterNames[0]} to see all ${def.record.plural}.`);
        } else if (filterNames.length > 1 || typeof options.next === "string") {
          out.note(`  No ${def.record.plural} match these filters. Remove some to see more ${def.record.plural}.`);
        } else {
          out.note(`  No ${def.record.plural} in ${workspace.ref}.`);
          if (def.firstUse) out.next(def.firstUse.instruction, withWorkspace(context, def.firstUse.argv));
        }
        return;
      }
      out.answer(table(out.out, def.columns, items));
      if (next) {
        const argv = ["secani", def.record.group, "list", "--next", next];
        if (typeof options.limit === "string") argv.push("--limit", String(limit));
        out.next("Next page", withWorkspace(context, argv), { required: true });
      }
    },
  };
}

export type Field = [label: string, value: (item: Record<string, unknown>, now: number) => string];

export type InspectDef = {
  record: RecordDef;
  summary: string;
  tool: string;
  idInput: string;
  argDescription: string;
  resultKey: string;
  framework?: boolean;
  fields: Field[];
  /** Long text shown under the rows, such as a description. */
  body?: (item: Record<string, unknown>) => string;
  examples?: Example[];
};

export function inspectCommand(def: InspectDef): CommandSpec {
  const argName = def.record.noun.toUpperCase();
  return {
    kind: "command",
    name: "inspect",
    summary: def.summary,
    consequence: "read",
    args: [{ name: argName, description: def.argDescription, required: true }],
    options: def.framework ? [FRAMEWORK_OPTION] : [],
    examples: def.examples ?? [],
    resultSchema: { [def.record.noun]: "object" },
    async run(context) {
      const { session, out, io } = context;
      const ref = context.args[argName]!;
      const workspace = await session.workspace();
      const framework =
        def.framework && typeof context.options.framework === "string"
          ? (await session.framework(context.options.framework, { action: `load ${def.record.noun} ${ref}`, workspace: workspace.ref })).id
          : undefined;
      const stop = out.progress(`Loading ${def.record.noun} ${ref}…`);
      let result: Record<string, unknown>;
      try {
        result = await session.call(
          def.tool,
          {
            ...workspaceArgs(workspace),
            [def.idInput]: ref,
            ...(framework ? { governanceScopeId: framework } : {}),
          },
          {
            action: `load ${def.record.noun} ${ref}`,
            noun: def.record.noun,
            ref,
            workspace: workspace.ref,
            listArgv: withWorkspace(context, ["secani", def.record.group, "list"]),
          },
        );
      } finally {
        stop();
      }
      const item = (result[def.resultKey] as Record<string, unknown> | undefined) ?? result;
      if (out.json) {
        out.document({ [def.record.noun]: item });
        return;
      }
      showWorkspace(context, workspace);
      const now = io.now();
      const link = linkOf(result) ?? linkOf(item);
      const lines = rows(out.out, [
        ...def.fields.map(([label, value]) => [label, cleanRemote(value(item, now))] as [string, string]),
        ...(link ? [["Open", link] as [string, string]] : []),
      ]);
      const body = def.body ? cleanRemote(def.body(item), { multiline: true }).trim() : "";
      out.answer(body ? `${lines}\n\n${body.split("\n").map((line) => `  ${line}`.replace(/\s+$/, "")).join("\n")}` : lines);
    },
  };
}

export function linkOf(value: unknown): string | undefined {
  const href = (value as { objectLink?: { href?: unknown } } | undefined)?.objectLink?.href;
  return typeof href === "string" && /^https?:\/\//.test(href) ? href : undefined;
}

/** A new idempotency key, or the one given with --request-id. */
export function requestId(context: CommandContext): string {
  const given = context.options["request-id"];
  if (typeof given === "string") {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(given)) {
      throw usageError("--request-id takes letters, digits, dots, colons, underscores and hyphens, up to 128 characters.");
    }
    return given;
  }
  return randomUUID();
}

/**
 * The result of a write: a receipt on stderr leading with the outcome, the
 * bare identifier on stdout when it is piped or non-interactive, and with
 * --json one document with `outcome` and the inspect command in `next`.
 */
export function writeResult(
  context: CommandContext,
  result: {
    record: RecordDef;
    outcome: "created" | "updated" | "deleted" | "archived" | "restored" | "unchanged";
    verb: string;
    id: string;
    document: Record<string, unknown>;
    rows?: Array<[string, string]>;
    link?: string;
    inspect?: boolean;
  },
): void {
  const { out, mode } = context;
  const inspectArgv = withWorkspace(context, ["secani", result.record.group, "inspect", result.id]);
  const listArgv = withWorkspace(context, ["secani", result.record.group, "list"]);
  const followUp = result.outcome === "deleted" || result.inspect === false ? listArgv : inspectArgv;
  if (out.json) {
    out.document({ [result.record.noun]: result.document, outcome: result.outcome, next: [nextJson({ argv: followUp })] });
    return;
  }
  out.gap();
  if (result.outcome === "unchanged") {
    out.note(`  ${result.record.noun.charAt(0).toUpperCase()}${result.record.noun.slice(1)} ${cleanRemote(result.id)} already matches. Nothing was changed.`);
  } else {
    const lines = [
      outcomeLine(out.err, result.verb, cleanRemote(result.id)),
      rows(out.err, [...(result.rows ?? []).map(([label, value]) => [label, cleanRemote(value)] as [string, string]), ...(result.link ? [["Open", result.link] as [string, string]] : [])]),
    ].filter(Boolean);
    out.note(lines.join("\n"));
  }
  if (!mode.interactive || !context.io.stdout.isTTY) out.answer(result.id);
}

/** Reads a text option that may be `-` for stdin. */
export async function textOption(context: CommandContext, name: string): Promise<string | undefined> {
  const value = context.options[name];
  if (typeof value !== "string") return undefined;
  if (value !== "-") return value;
  if (context.io.stdinIsTTY) {
    throw usageError(`--${name} - reads stdin, but stdin is a terminal. Pipe the text in, such as: cat notes.md | secani …`);
  }
  const text = await context.io.readStdin();
  return text.replace(/\r?\n$/, "");
}

/** Validates every local input before the first request and reports all problems at once. */
export function validate(action: string, problems: string[], context: CommandContext): void {
  if (problems.length === 0) return;
  const missing = problems.every((problem) => problem.startsWith("Missing"));
  // Human issue lists show at most 5; JSON carries them all.
  const detail = problems.length > 5 ? [...problems.slice(0, 5), `and ${problems.length - 5} more`] : problems;
  throw new CliError({
    class: missing ? "missing_input" : "usage",
    reason: missing ? "missing_value" : "invalid_arguments",
    message: `Can't ${action}. ${problems.length === 1 ? problems[0] : `${problems.length} inputs are ${missing ? "missing" : "missing or invalid"}.`}`,
    ...(problems.length > 1 ? { detail } : {}),
    data: { issues: problems.map((message) => ({ message })) },
    recovery: [{ instruction: "See the options", command: { argv: ["secani", ...context.session.recoveryPath, "--help"] } }],
  });
}

export const dateish = { day, when, words };
