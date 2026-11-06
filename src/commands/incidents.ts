import { age, iso, words } from "../runtime/format";
import type { CommandContext, CommandSpec, GroupSpec, OptionSpec } from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import {
  linkOf,
  listCommand,
  pick,
  REQUEST_ID_OPTION,
  requestId,
  showWorkspace,
  textOption,
  validate,
  workspaceArgs,
  writeResult,
  type RecordDef,
} from "./records";

const STATUSES = ["open", "investigating", "contained", "resolved", "closed"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const INCIDENT: RecordDef = {
  group: "incidents",
  noun: "incident",
  plural: "incidents",
  identity: (item) => pick(item, "displayKey", "incidentId"),
};

const list = listCommand({
  record: INCIDENT,
  summary: "List the workspace's security incidents",
  tool: "list_incidents",
  cursorKey: "nextCursor",
  filters: [
    { option: { name: "status", type: "string", value: "<STATUS>", choices: STATUSES, description: "Only incidents with this status" }, input: "status" },
  ],
  columns: [
    { header: "ID", human: (item) => INCIDENT.identity(item) },
    { header: "Title", human: (item) => pick(item, "title"), flex: true },
    { header: "Severity", human: (item) => words(item.severity), raw: (item) => pick(item, "severity") },
    { header: "Status", human: (item) => words(item.status), raw: (item) => pick(item, "status") },
    { header: "Discovered", human: (item) => age(item.discoveredAt), raw: (item) => iso(item.discoveredAt) },
  ],
  examples: [{ title: "List incidents under investigation", command: "secani incidents list --status investigating" }],
  firstUse: { instruction: "Report one", argv: ["secani", "incidents", "create", "--title", "<TITLE>"] },
});

const FIELD_OPTIONS: OptionSpec[] = [
  { name: "title", type: "string", value: "<TITLE>", description: "Title" },
  { name: "description", type: "string", value: "<TEXT>", description: "What happened; - reads stdin" },
  { name: "severity", type: "string", value: "<SEVERITY>", choices: SEVERITIES, description: "Severity" },
  { name: "status", type: "string", value: "<STATUS>", choices: STATUSES, description: "Status" },
  {
    name: "discovered-at",
    type: "string",
    value: "<TIME>",
    description: "When it was noticed, as ISO 8601; a time without offset counts as Europe/Berlin",
  },
  { name: "lessons-learned", type: "string", value: "<TEXT>", description: "Lessons learned, up to 4,000 characters" },
];

async function incidentFields(context: CommandContext, problems: string[]): Promise<Record<string, unknown>> {
  const { options } = context;
  const fields: Record<string, unknown> = {};
  if (typeof options.title === "string") {
    if (options.title.trim() === "") problems.push("--title can't be empty.");
    fields.title = options.title;
  }
  const description = await textOption(context, "description");
  if (description !== undefined) fields.description = description;
  if (typeof options.severity === "string") fields.severity = options.severity;
  if (typeof options.status === "string") fields.status = options.status;
  if (typeof options["lessons-learned"] === "string") fields.lessonsLearned = options["lessons-learned"];
  const discovered = options["discovered-at"];
  if (typeof discovered === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(discovered)) {
      problems.push(`--discovered-at takes an ISO 8601 time such as 2026-10-20T12:45, not ${JSON.stringify(cleanRemote(discovered))}.`);
    } else {
      fields.discoveredAt = discovered;
    }
  }
  return fields;
}

function saveCommand(mode: "create" | "update"): CommandSpec {
  const creating = mode === "create";
  return {
    kind: "command",
    name: mode,
    summary: creating ? "Report a security incident" : "Change an incident's fields",
    consequence: "ordinary",
    ...(creating ? {} : { args: [{ name: "INCIDENT", description: "The incident's ID, such as INC-3", required: true }] }),
    options: [...FIELD_OPTIONS, REQUEST_ID_OPTION],
    examples: creating
      ? [{ title: "Report an incident noticed this morning", command: "secani incidents create --title 'Phishing mail opened' --severity high --discovered-at 2026-11-06T09:30" }]
      : [{ title: "Mark an incident as contained", command: "secani incidents update INC-3 --status contained" }],
    notes: creating
      ? ["A new incident starts as open with medium severity, discovered now, unless you pass those options."]
      : ["Only the options you pass change."],
    resultSchema: { incident: "object", outcome: creating ? "created" : "updated | unchanged" },
    async run(context) {
      const { session, out } = context;
      const ref = context.args.INCIDENT;
      const problems: string[] = [];
      const fields = await incidentFields(context, problems);
      if (creating && fields.title === undefined) problems.push("Missing --title.");
      if (!creating && Object.keys(fields).length === 0) problems.push("Pass at least one field to change, such as --status.");
      const action = creating ? "report the incident" : `update incident ${ref}`;
      validate(action, problems, context);
      const workspace = await session.workspace();
      showWorkspace(context, workspace);
      const stop = out.progress(creating ? "Reporting the incident…" : `Updating incident ${ref}…`);
      let result: Record<string, unknown>;
      try {
        result = await session.call(
          "save_incident",
          { ...workspaceArgs(workspace), ...(ref ? { id: ref } : {}), ...fields },
          { action, noun: "incident", ...(ref ? { ref } : {}), workspace: workspace.ref, listArgv: ["secani", "incidents", "list"] },
          { write: true, requestId: requestId(context) },
        );
      } finally {
        stop();
      }
      const applied = Array.isArray(result.applied) ? (result.applied as string[]) : [];
      writeResult(context, {
        record: INCIDENT,
        outcome: creating ? "created" : applied.length === 0 ? "unchanged" : "updated",
        verb: creating ? "Reported" : "Updated",
        id: pick(result, "displayKey") || ref || pick(result, "incidentId"),
        document: result,
        rows: creating ? [["Title", String(fields.title ?? "")]] : [["Changed", applied.join(", ")]],
        inspect: false,
        ...(linkOf(result) ? { link: linkOf(result)! } : {}),
      });
    },
  };
}

export const incidents: GroupSpec = {
  kind: "group",
  name: "incidents",
  aliases: ["incident"],
  summary: "List, report and update security incidents",
  children: [list, saveCommand("create"), saveCommand("update")],
};
