import { requireConsent } from "../runtime/consent";
import { day, iso, words } from "../runtime/format";
import { YES_OPTION, type CommandContext, type CommandSpec, type GroupSpec, type OptionSpec } from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import {
  inspectCommand,
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

const STATES = ["inbox", "backlog", "planned", "in_progress", "blocked", "awaiting_verification", "done", "cancelled"] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export const TASK: RecordDef = {
  group: "tasks",
  noun: "task",
  plural: "tasks",
  identity: (item) => pick(item, "displayKey", "workItemKey", "issueKey", "key", "workItemId"),
};

function assignee(item: Record<string, unknown>): string {
  return pick(item, "assigneeName", "assigneeEmail", "assigneeTeam");
}

const list = listCommand({
  record: TASK,
  summary: "List the workspace's tasks",
  tool: "list_tasks",
  pageLimit: 50,
  filters: [
    { option: { name: "status", type: "string", value: "<STATUS>", choices: STATES, description: "Only tasks with this status" }, input: "workflowState" },
    { option: { name: "priority", type: "string", value: "<PRIORITY>", choices: PRIORITIES, description: "Only tasks with this priority" }, input: "priority" },
    { option: { name: "assignee", type: "string", value: "<EMAIL>", description: "Only tasks assigned to this member; me for your own" }, input: "assignee" },
    { option: { name: "team", type: "string", value: "<TEAM>", description: "Only tasks assigned to this team, by name or ID" }, input: "team" },
    { option: { name: "open", type: "boolean", description: "Only tasks that aren't done or cancelled" }, input: "open" },
    { option: { name: "overdue", type: "boolean", description: "Only open tasks past their due date" }, input: "overdue" },
  ],
  columns: [
    { header: "ID", human: (item) => TASK.identity(item) },
    { header: "Title", human: (item) => pick(item, "title"), flex: true },
    { header: "Status", human: (item) => words(item.workflowState), raw: (item) => pick(item, "workflowState") },
    { header: "Priority", human: (item) => words(item.priority), raw: (item) => pick(item, "priority") },
    { header: "Assignee", human: assignee, raw: (item) => pick(item, "assigneeEmail", "assigneeTeam", "assigneeName") },
    { header: "Due", human: (item) => day(item.dueAt), raw: (item) => iso(item.dueAt) },
  ],
  examples: [
    { title: "List your open tasks", command: "secani tasks list --assignee me --open" },
    { title: "List overdue tasks as JSON", command: "secani tasks list --overdue --json" },
  ],
  firstUse: { instruction: "Add one", argv: ["secani", "tasks", "create", "--title", "<TITLE>"] },
});

const inspect = inspectCommand({
  record: TASK,
  summary: "Show a task",
  tool: "get_task",
  idInput: "workItemId",
  argDescription: "The task's ID, such as TASK-12",
  resultKey: "task",
  fields: [
    ["ID", (item) => TASK.identity(item)],
    ["Title", (item) => pick(item, "title")],
    ["Status", (item) => words(item.workflowState)],
    ["Priority", (item) => words(item.priority)],
    ["Assignee", assignee],
    ["Due", (item) => day(item.dueAt)],
    ["Archived", (item) => (item.lifecycleStatus === "retired" ? "Yes" : "")],
  ],
  body: (item) => pick(item, "description"),
  examples: [{ title: "Show a task", command: "secani tasks inspect TASK-12" }],
});

const FIELD_OPTIONS: OptionSpec[] = [
  { name: "title", type: "string", value: "<TITLE>", description: "Title" },
  { name: "description", type: "string", value: "<TEXT>", description: "Description; - reads stdin" },
  { name: "status", type: "string", value: "<STATUS>", choices: STATES, description: "Status" },
  { name: "priority", type: "string", value: "<PRIORITY>", choices: PRIORITIES, description: "Priority" },
  { name: "assignee", type: "string", value: "<EMAIL>", description: "Workspace member to assign, by email; me for yourself", negatable: true },
  {
    name: "due",
    type: "string",
    value: "<DATE>",
    description: "Due date as YYYY-MM-DD (5 pm local time) or an ISO 8601 time with offset",
    negatable: true,
  },
];

/** YYYY-MM-DD becomes 17:00 local time with the local offset; ISO times pass through. */
export function dueAt(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const local = new Date(`${value}T17:00:00`);
    if (Number.isNaN(local.getTime())) return undefined;
    const offset = -local.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    return `${value}T17:00:00${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
}

async function taskFields(context: CommandContext, problems: string[]): Promise<Record<string, unknown>> {
  const { options } = context;
  const fields: Record<string, unknown> = {};
  if (typeof options.title === "string") {
    if (options.title.trim() === "") problems.push("--title can't be empty.");
    fields.title = options.title;
  }
  const description = await textOption(context, "description");
  if (description !== undefined) fields.description = description;
  if (typeof options.status === "string") fields.status = options.status;
  if (typeof options.priority === "string") fields.priority = options.priority;
  if (typeof options.assignee === "string") fields.assigneeEmail = options.assignee;
  if (options.assignee === false) fields.assigneeEmail = null;
  if (typeof options.due === "string") {
    const value = dueAt(options.due);
    if (value) fields.dueAt = value;
    else problems.push(`--due takes YYYY-MM-DD or an ISO 8601 time with offset, not ${JSON.stringify(cleanRemote(options.due))}.`);
  }
  if (options.due === false) fields.dueAt = null;
  return fields;
}

function outcomeOf(result: Record<string, unknown>): "unchanged" | undefined {
  const applied = Array.isArray(result.applied) ? (result.applied as unknown[]) : [];
  return applied.length === 0 ? "unchanged" : undefined;
}

const create: CommandSpec = {
  kind: "command",
  name: "create",
  summary: "Create a task",
  consequence: "ordinary",
  // A new task has nothing to clear, so its options take no --no- form.
  options: [...FIELD_OPTIONS.map((option) => ({ ...option, negatable: false })), REQUEST_ID_OPTION],
  examples: [{ title: "Create a task for yourself, due on a date", command: "secani tasks create --title 'Review the backup policy' --assignee me --due 2026-12-15" }],
  resultSchema: { task: "object", outcome: "created" },
  async run(context) {
    const { session, out } = context;
    const problems: string[] = [];
    const fields = await taskFields(context, problems);
    if (fields.title === undefined) problems.push("Missing --title.");
    validate("create the task", problems, context);
    const workspace = await session.workspace();
    showWorkspace(context, workspace);
    const stop = out.progress("Creating the task…");
    let result: Record<string, unknown>;
    try {
      result = await session.call(
        "save_task",
        { ...workspaceArgs(workspace), ...fields },
        { action: "create the task", noun: "task", workspace: workspace.ref },
        { write: true, requestId: requestId(context) },
      );
    } finally {
      stop();
    }
    const task = await readTask(context, workspace, String(result.workItemId));
    writeResult(context, {
      record: TASK,
      outcome: "created",
      verb: "Created",
      id: task ? TASK.identity(task) || String(result.workItemId) : String(result.workItemId),
      document: { ...result, ...(task ?? {}) },
      rows: [["Title", pick(task ?? fields, "title")], ["Status", words(result.workflowState)]],
      ...(linkOf(result) ? { link: linkOf(result)! } : {}),
    });
  },
};

async function readTask(context: CommandContext, workspace: Parameters<typeof workspaceArgs>[0], workItemId: string) {
  try {
    const result = await context.session.call("get_task", { ...workspaceArgs(workspace), workItemId }, { action: "load the task" });
    return result.task as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

const update: CommandSpec = {
  kind: "command",
  name: "update",
  summary: "Change a task's fields",
  consequence: "ordinary",
  args: [{ name: "TASK", description: "The task's ID, such as TASK-12", required: true }],
  options: [...FIELD_OPTIONS, REQUEST_ID_OPTION],
  examples: [
    { title: "Mark a task done", command: "secani tasks update TASK-12 --status done" },
    { title: "Hand a task to a colleague and clear its due date", command: "secani tasks update TASK-12 --assignee jane@example.com --no-due" },
  ],
  notes: ["Only the options you pass change; --no-assignee and --no-due clear those fields."],
  resultSchema: { task: "object", outcome: "updated | unchanged" },
  async run(context) {
    const { session, out } = context;
    const ref = context.args.TASK!;
    const problems: string[] = [];
    const fields = await taskFields(context, problems);
    if (Object.keys(fields).length === 0) problems.push("Pass at least one field to change, such as --status or --assignee.");
    validate(`update task ${ref}`, problems, context);
    const workspace = await session.workspace();
    showWorkspace(context, workspace);
    const stop = out.progress(`Updating task ${ref}…`);
    let result: Record<string, unknown>;
    try {
      result = await session.call(
        "save_task",
        { ...workspaceArgs(workspace), id: ref, ...fields },
        { action: `update task ${ref}`, noun: "task", ref, workspace: workspace.ref, listArgv: ["secani", "tasks", "list"] },
        { write: true, requestId: requestId(context) },
      );
    } finally {
      stop();
    }
    writeResult(context, {
      record: TASK,
      outcome: outcomeOf(result) ?? "updated",
      verb: "Updated",
      id: ref,
      document: result,
      rows: [["Changed", (Array.isArray(result.applied) ? (result.applied as string[]) : []).join(", ")], ["Status", words(result.workflowState)]],
      ...(linkOf(result) ? { link: linkOf(result)! } : {}),
    });
  },
};

function archiveCommand(archive: boolean): CommandSpec {
  return {
    kind: "command",
    name: archive ? "archive" : "restore",
    summary: archive ? "Archive a task" : "Restore an archived task",
    consequence: archive ? "destructive" : "ordinary",
    args: [{ name: "TASK", description: "The task's ID, such as TASK-12", required: true }],
    options: archive ? [REQUEST_ID_OPTION, YES_OPTION] : [REQUEST_ID_OPTION],
    examples: [
      archive
        ? { title: "Archive a task in a script, after a person approved it", command: "secani tasks archive TASK-12 --yes" }
        : { title: "Bring an archived task back", command: "secani tasks restore TASK-12" },
    ],
    ...(archive ? { notes: ["An archived task leaves the board and lists; secani tasks restore brings it back."] } : {}),
    resultSchema: { task: "object", outcome: archive ? "archived | unchanged" : "restored | unchanged" },
    async run(context) {
      const { session } = context;
      const ref = context.args.TASK!;
      const workspace = await session.workspace();
      const attempt = {
        action: `${archive ? "archive" : "restore"} task ${ref}`,
        noun: "task",
        ref,
        workspace: workspace.ref,
        listArgv: ["secani", "tasks", "list"],
      };
      // save_task resolves an ID such as TASK-12 among active tasks only, so
      // an archived task is found through get_task and addressed by its ID.
      const current = await session.call("get_task", { ...workspaceArgs(workspace), workItemId: ref }, { ...attempt, action: `load task ${ref}` });
      const task = (current.task as Record<string, unknown>) ?? {};
      const workItemId = pick(task, "workItemId") || ref;
      if (archive) {
        const key = TASK.identity(task) || ref;
        context.out.context([["Workspace", workspace.ref], ["Task", `${key}  ${cleanRemote(pick(task, "title"))}`.trim()]]);
        await requireConsent(context, {
          tier: "destructive",
          question: `Archive task ${key}?`,
          effects: [`Removes ${key} from the board and task lists.`, "secani tasks restore brings it back."],
          consequence: `task ${key} is archived`,
        });
      } else {
        showWorkspace(context, workspace);
      }
      const result = await session.call(
        "save_task",
        { ...workspaceArgs(workspace), id: workItemId, archived: archive },
        attempt,
        { write: true, requestId: requestId(context) },
      );
      writeResult(context, {
        record: TASK,
        outcome: outcomeOf(result) ?? (archive ? "archived" : "restored"),
        verb: archive ? "Archived" : "Restored",
        id: ref,
        document: result,
      });
    },
  };
}

export const tasks: GroupSpec = {
  kind: "group",
  name: "tasks",
  aliases: ["task"],
  summary: "List, inspect, create, update and archive tasks",
  children: [list, inspect, create, update, archiveCommand(true), archiveCommand(false)],
};
