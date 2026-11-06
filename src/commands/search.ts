import { usageError } from "../runtime/errors";
import { words } from "../runtime/format";
import { table } from "../runtime/layout";
import { FRAMEWORK_OPTION, type CommandSpec } from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import { pick, showWorkspace, workspaceArgs } from "./records";

const KINDS: Record<string, string> = {
  asset: "workspace_object",
  task: "task",
  requirement: "requirement",
  evidence: "evidence_artifact",
};
const KIND_LABELS: Record<string, string> = Object.fromEntries(Object.entries(KINDS).map(([label, value]) => [value, label]));

export const search: CommandSpec = {
  kind: "command",
  name: "search",
  summary: "Search assets, tasks, requirements and evidence",
  consequence: "read",
  args: [{ name: "QUERY", description: "Words to search for", required: true }],
  options: [
    {
      name: "kind",
      type: "string",
      value: "<KIND>",
      choices: Object.keys(KINDS),
      repeat: "append",
      description: "Only results of this kind; repeat for several",
    },
    FRAMEWORK_OPTION,
    { name: "limit", type: "integer", value: "<N>", description: "Number of results per kind, up to 20", default: "10" },
  ],
  examples: [
    { title: "Find everything about backups", command: "secani search backup" },
    { title: "Find requirements in one framework", command: "secani search 'access control' --kind requirement --framework 'ISO 27001'" },
  ],
  notes: [
    "Requirements and evidence are searched in a framework: --framework, or the workspace's only framework. Risks and controls have their own --search: secani risks list --search, secani controls list --search.",
  ],
  resultSchema: { results: "array", sections: "array" },
  async run(context) {
    const { session, options, out } = context;
    const query = context.args.QUERY!;
    if (query.trim() === "") throw usageError("Can't search for an empty query.");
    let limit = 10;
    if (typeof options.limit === "string") {
      limit = Number(options.limit);
      if (limit < 1) throw usageError("--limit must be a whole number of 1 or more.");
      if (limit > 20) {
        out.warn("limit_clamped", "--limit is capped at 20. Showing up to 20 results per kind.");
        limit = 20;
      }
    }
    const kinds = Array.isArray(options.kind) ? [...new Set(options.kind.map((kind) => KINDS[kind]!))] : undefined;
    const workspace = await session.workspace();
    // Requirements and evidence live in a framework: --framework, else the
    // workspace's only one. Asked for explicitly, they need one; searched by
    // default, they are skipped with a warning when the choice is open.
    const scoped = !kinds || kinds.some((kind) => kind === "requirement" || kind === "evidence_artifact");
    const attempt = { action: "search requirements and evidence", workspace: workspace.ref };
    let framework =
      typeof options.framework === "string" ? (await session.framework(options.framework, attempt)).id : undefined;
    if (!framework && scoped) {
      if (kinds) {
        framework = (await session.framework(undefined, attempt)).id;
      } else {
        const { scopes, truncated } = await session.frameworks();
        if (scopes.length === 1 && !truncated) framework = scopes[0]!.governanceScopeId;
      }
    }
    const stop = out.progress("Searching…");
    let result: Record<string, unknown>;
    try {
      result = await session.call(
        "search",
        {
          ...workspaceArgs(workspace),
          query,
          limit,
          ...(kinds ? { entityKinds: kinds } : {}),
          ...(framework ? { governanceScopeId: framework } : {}),
        },
        { action: "search", workspace: workspace.ref },
      );
    } finally {
      stop();
    }
    const results = Array.isArray(result.results) ? (result.results as Record<string, unknown>[]) : [];
    const sections = Array.isArray(result.sections) ? (result.sections as Record<string, unknown>[]) : [];
    for (const section of sections) {
      const kind = KIND_LABELS[String(section.entityType)] ?? String(section.entityType);
      if (section.state === "unauthorized") out.warn("partial_visibility", `Skipped ${kind} results: you don't have access to them here.`);
      else if (section.state === "unavailable") out.warn("partial_visibility", `Skipped ${kind} results: Secani couldn't search them right now.`);
      else if (section.state === "skipped" && (!kinds || kinds.includes(String(section.entityType)))) {
        const code = String(section.errorCode ?? "");
        if (code === "SCOPE_REQUIRED") {
          out.warn("framework_required", `Skipped ${kind} results: they need a framework. Pass --framework to include them.`);
        } else if (code === "QUERY_TOO_SHORT") {
          out.warn("query_too_short", `Skipped ${kind} results: their search needs at least 2 characters.`);
        } else {
          out.warn("section_skipped", `Skipped ${kind} results: Secani doesn't search them here${code ? ` (${cleanRemote(code)})` : ""}.`);
        }
      }
    }
    if (out.json) {
      out.document({ results, sections });
      return;
    }
    showWorkspace(context, workspace);
    if (results.length === 0) {
      if (!out.out.rich) out.answer("Kind\tTitle\tState\tID");
      out.note(`  Nothing in ${workspace.ref} matches ${JSON.stringify(query)}.`);
      return;
    }
    out.answer(
      table(
        out.out,
        [
          { header: "Kind", human: (item) => KIND_LABELS[String(item.entityType)] ?? words(item.entityType), raw: (item) => pick(item, "entityType") },
          { header: "Title", human: (item) => pick(item, "title"), flex: true },
          { header: "State", human: (item) => words(item.state), raw: (item) => pick(item, "state") },
          { header: "ID", human: (item) => pick(item, "id") },
        ],
        results,
      ),
    );
  },
};
