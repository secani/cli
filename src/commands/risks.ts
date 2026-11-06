import { requireConsent } from "../runtime/consent";
import { age, day, iso, words } from "../runtime/format";
import { FRAMEWORK_OPTION, YES_OPTION, type CommandContext, type CommandSpec, type GroupSpec, type OptionSpec } from "../runtime/spec";
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

const CATEGORIES = ["security", "privacy", "compliance", "operational", "financial", "third_party", "other"] as const;
const STATUSES = ["identified", "analyzed", "treatment_planned", "pending_acceptance", "accepted", "closed"] as const;
const SETTABLE_STATUSES = STATUSES.filter((status) => status !== "accepted");
const STRATEGIES = ["mitigate", "avoid", "transfer", "accept"] as const;
const LEVELS = ["low", "moderate", "high", "critical"] as const;
const LIKELIHOODS = ["rare", "unlikely", "possible", "likely", "almost_certain"] as const;
const IMPACTS = ["negligible", "low", "medium", "high", "critical"] as const;

export const RISK: RecordDef = {
  group: "risks",
  noun: "risk",
  plural: "risks",
  identity: (item) => pick(item, "displayKey", "riskKey", "riskId"),
};

function level(item: Record<string, unknown>, prefix: "inherent" | "residual"): string {
  const value = item[`${prefix}Level`];
  const score = item[`${prefix}Score`];
  if (!value) return "";
  return typeof score === "number" ? `${words(value)} (${score})` : words(value);
}

const list = listCommand({
  record: RISK,
  summary: "List the workspace's active risks",
  tool: "list_risks",
  framework: true,
  filters: [
    { option: { name: "category", type: "string", value: "<CATEGORY>", choices: CATEGORIES, description: "Only risks in this category" }, input: "category" },
    { option: { name: "status", type: "string", value: "<STATUS>", choices: STATUSES, description: "Only risks with this status" }, input: "status" },
    { option: { name: "strategy", type: "string", value: "<STRATEGY>", choices: STRATEGIES, description: "Only risks with this treatment strategy" }, input: "strategy" },
    {
      option: { name: "min-level", type: "string", value: "<LEVEL>", choices: LEVELS, description: "Only risks whose residual level is at least this high" },
      input: "minResidualLevel",
    },
    { option: { name: "search", type: "string", value: "<WORDS>", description: "Only risks whose title or ID contains all these words" }, input: "search" },
    { option: { name: "asset", type: "string", value: "<ASSET>", description: "Only risks tied to this asset, by ID or name" }, input: "object" },
  ],
  columns: [
    { header: "ID", human: (item) => RISK.identity(item) },
    { header: "Title", human: (item) => pick(item, "title"), flex: true },
    { header: "Category", human: (item) => words(item.category), raw: (item) => pick(item, "category") },
    { header: "Residual", human: (item) => words(item.residualLevel), raw: (item) => pick(item, "residualLevel") },
    { header: "Strategy", human: (item) => words(item.strategy), raw: (item) => pick(item, "strategy") },
    { header: "Status", human: (item) => words(item.status), raw: (item) => pick(item, "status") },
    { header: "Updated", human: (item) => age(item.updatedAt), raw: (item) => iso(item.updatedAt) },
  ],
  examples: [
    { title: "List high and critical risks that are still open", command: "secani risks list --min-level high --status identified" },
    { title: "Read every risk as JSON", command: "secani risks list --limit 200 --json" },
  ],
  firstUse: {
    instruction: "Add one",
    argv: ["secani", "risks", "create", "--title", "<TITLE>", "--category", "<CATEGORY>", "--strategy", "<STRATEGY>", "--hazard", "<HAZARD>"],
  },
});

const inspect = inspectCommand({
  record: RISK,
  summary: "Show a risk's assessment and treatment",
  tool: "get_risk",
  idInput: "riskId",
  argDescription: "The risk's ID, such as RI-12",
  resultKey: "risk",
  framework: true,
  fields: [
    ["ID", (item) => RISK.identity(item)],
    ["Title", (item) => pick(item, "title")],
    ["Status", (item) => words(item.status)],
    ["Category", (item) => words(item.category)],
    ["Inherent", (item) => level(item, "inherent")],
    ["Residual", (item) => level(item, "residual")],
    ["Strategy", (item) => words(item.strategy)],
    ["Owner", (item) => pick(item, "riskOwnerName", "riskOwner")],
    ["Asset", (item) => pick((item.targetObject as Record<string, unknown>) ?? {}, "name")],
    ["Treatment", (item) => pick(item, "treatmentPlan")],
    ["Treatment Due", (item) => day(item.treatmentDueDate)],
    ["Next Review", (item) => day(item.nextReviewDate)],
  ],
  body: (item) => pick(item, "description"),
  examples: [{ title: "Show a risk", command: "secani risks inspect RI-12" }],
});

const FIELD_OPTIONS: OptionSpec[] = [
  { name: "title", type: "string", value: "<TITLE>", description: "Title, up to 160 characters" },
  { name: "description", type: "string", value: "<TEXT>", description: "Description, up to 2,000 characters; - reads stdin" },
  { name: "category", type: "string", value: "<CATEGORY>", choices: CATEGORIES, description: "Category" },
  { name: "likelihood", type: "string", value: "<LIKELIHOOD>", choices: LIKELIHOODS, description: "Inherent likelihood" },
  { name: "impact", type: "string", value: "<IMPACT>", choices: IMPACTS, description: "Inherent impact" },
  { name: "residual-likelihood", type: "string", value: "<LIKELIHOOD>", choices: LIKELIHOODS, description: "Residual likelihood after treatment" },
  { name: "residual-impact", type: "string", value: "<IMPACT>", choices: IMPACTS, description: "Residual impact after treatment" },
  { name: "strategy", type: "string", value: "<STRATEGY>", choices: STRATEGIES, description: "Treatment strategy" },
  { name: "status", type: "string", value: "<STATUS>", choices: SETTABLE_STATUSES, description: "Status" },
  { name: "owner", type: "string", value: "<NAME>", description: "Risk owner" },
  { name: "treatment-plan", type: "string", value: "<TEXT>", description: "How the risk is treated, up to 1,000 characters" },
  { name: "treatment-due", type: "string", value: "<YYYY-MM-DD>", description: "When the treatment is due" },
  { name: "review-date", type: "string", value: "<YYYY-MM-DD>", description: "When the risk is reviewed next" },
  { name: "hazard", type: "string", value: "<HAZARD>", description: "Threat from Secani's catalog, by catalog ID or exact title; fills the fields you leave out" },
];

const INPUTS: Record<string, string> = {
  title: "title",
  category: "category",
  likelihood: "inherentLikelihood",
  impact: "inherentImpact",
  "residual-likelihood": "residualLikelihood",
  "residual-impact": "residualImpact",
  strategy: "strategy",
  status: "status",
  owner: "riskOwner",
  "treatment-plan": "treatmentPlan",
  "treatment-due": "treatmentDueDate",
  "review-date": "nextReviewDate",
  hazard: "hazardRefCode",
};

async function riskFields(context: CommandContext, problems: string[]): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  for (const [option, input] of Object.entries(INPUTS)) {
    const value = context.options[option];
    if (typeof value === "string") fields[input] = value;
  }
  const description = await textOption(context, "description");
  if (description !== undefined) fields.description = description;
  for (const option of ["treatment-due", "review-date"]) {
    const value = context.options[option];
    if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`--${option} takes a date as YYYY-MM-DD, not ${JSON.stringify(cleanRemote(value))}.`);
  }
  const title = context.options.title;
  if (typeof title === "string" && (title.trim() === "" || title.length > 160)) problems.push("--title takes 1 to 160 characters.");
  return fields;
}

async function readDisplayKey(context: CommandContext, workspace: Parameters<typeof workspaceArgs>[0], riskId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await context.session.call("get_risk", { ...workspaceArgs(workspace), riskId }, { action: "load the risk" });
    return result.risk as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

const create: CommandSpec = {
  kind: "command",
  name: "create",
  summary: "Create a risk in the risk register",
  consequence: "ordinary",
  options: [...FIELD_OPTIONS, FRAMEWORK_OPTION, REQUEST_ID_OPTION],
  examples: [
    {
      title: "Create a risk from Secani's threat catalog",
      command: "secani risks create --hazard <HAZARD> --strategy mitigate",
    },
    {
      title: "Create a risk with its own assessment",
      command:
        "secani risks create --title 'Laptop theft' --category security --likelihood possible --impact high --residual-likelihood unlikely --residual-impact medium --strategy mitigate",
    },
  ],
  notes: [
    "Without --hazard, a new risk needs --title, --category, --strategy and its four ratings. A workspace whose risk method rates several impact dimensions takes its ratings in the app or with `secani tools call save_risk`.",
  ],
  resultSchema: { risk: "object", outcome: "created" },
  async run(context) {
    const { session, options, out } = context;
    const problems: string[] = [];
    const fields = await riskFields(context, problems);
    const required = options.hazard
      ? ["strategy"]
      : ["title", "category", "likelihood", "impact", "residual-likelihood", "residual-impact", "strategy"];
    for (const name of required) if (options[name] === undefined) problems.push(`Missing --${name}.`);
    validate("create the risk", problems, context);
    const workspace = await session.workspace();
    const attempt = { action: "create the risk", noun: "risk", workspace: workspace.ref };
    const framework = await session.framework(options.framework as string | undefined, attempt);
    out.context([
      ...(workspace.source === "saved" || workspace.source === "only" ? [["Workspace", workspace.ref] as [string, string]] : []),
      ...(framework.source === "only" && framework.name ? [["Framework", cleanRemote(framework.name)] as [string, string]] : []),
    ]);
    const id = requestId(context);
    const stop = out.progress("Creating the risk…");
    let result: Record<string, unknown>;
    try {
      result = await session.call(
        "save_risk",
        { ...workspaceArgs(workspace), governanceScopeId: framework.id, ...fields },
        attempt,
        { write: true, requestId: id },
      );
    } finally {
      stop();
    }
    const risk = await readDisplayKey(context, workspace, String(result.riskId));
    writeResult(context, {
      record: RISK,
      outcome: "created",
      verb: "Created",
      id: risk ? RISK.identity(risk) : String(result.riskId),
      document: { ...result, ...(risk ?? {}) },
      rows: [["Title", pick(risk ?? result, "title")]],
      ...(linkOf(result) ? { link: linkOf(result)! } : {}),
    });
  },
};

const update: CommandSpec = {
  kind: "command",
  name: "update",
  summary: "Change a risk's fields",
  consequence: "ordinary",
  args: [{ name: "RISK", description: "The risk's ID, such as RI-12", required: true }],
  options: [...FIELD_OPTIONS, FRAMEWORK_OPTION, REQUEST_ID_OPTION],
  examples: [{ title: "Accept a risk's treatment plan and set its review date", command: "secani risks update RI-12 --status treatment_planned --review-date 2027-03-31" }],
  notes: ["Only the options you pass change; everything else stays as it is."],
  resultSchema: { risk: "object", outcome: "updated | unchanged" },
  async run(context) {
    const { session, options, out } = context;
    const ref = context.args.RISK!;
    const problems: string[] = [];
    const fields = await riskFields(context, problems);
    if (Object.keys(fields).length === 0) problems.push(`Pass at least one field to change, such as --status or --title.`);
    validate(`update risk ${ref}`, problems, context);
    const workspace = await session.workspace();
    const attempt = {
      action: `update risk ${ref}`,
      noun: "risk",
      ref,
      workspace: workspace.ref,
      listArgv: ["secani", "risks", "list"],
    };
    const framework = await session.framework(options.framework as string | undefined, attempt);
    showWorkspace(context, workspace);
    const stop = out.progress(`Updating risk ${ref}…`);
    let result: Record<string, unknown>;
    try {
      result = await session.call(
        "save_risk",
        { ...workspaceArgs(workspace), governanceScopeId: framework.id, id: ref, ...fields },
        attempt,
        { write: true, requestId: requestId(context) },
      );
    } finally {
      stop();
    }
    const applied = Array.isArray(result.applied) ? (result.applied as string[]) : [];
    writeResult(context, {
      record: RISK,
      outcome: applied.length === 0 ? "unchanged" : "updated",
      verb: "Updated",
      id: ref,
      document: result,
      rows: [["Changed", applied.join(", ")]],
      ...(linkOf(result) ? { link: linkOf(result)! } : {}),
    });
  },
};

const remove: CommandSpec = {
  kind: "command",
  name: "delete",
  aliases: ["rm", "del"],
  summary: "Delete a risk from the active risk register",
  consequence: "destructive",
  args: [{ name: "RISK", description: "The risk's ID, such as RI-12 (titles aren't accepted)", required: true }],
  options: [FRAMEWORK_OPTION, REQUEST_ID_OPTION, YES_OPTION],
  examples: [{ title: "Delete a risk in a script, after a person approved it", command: "secani risks delete RI-12 --yes" }],
  notes: ["The risk leaves the register and its lists; its versions and audit trail stay."],
  resultSchema: { risk: "object", outcome: "deleted" },
  async run(context) {
    const { session, options, out } = context;
    const ref = context.args.RISK!;
    const workspace = await session.workspace();
    const attempt = { action: `delete risk ${ref}`, noun: "risk", ref, workspace: workspace.ref, listArgv: ["secani", "risks", "list"] };
    const framework = await session.framework(options.framework as string | undefined, attempt);
    const current = await session.call(
      "get_risk",
      { ...workspaceArgs(workspace), riskId: ref, governanceScopeId: framework.id },
      { ...attempt, action: `load risk ${ref}` },
    );
    const risk = (current.risk as Record<string, unknown>) ?? {};
    const key = RISK.identity(risk) || ref;
    out.context([["Workspace", workspace.ref], ["Risk", `${key}  ${cleanRemote(pick(risk, "title"))}`.trim()]]);
    await requireConsent(context, {
      tier: "destructive",
      question: `Delete risk ${key}?`,
      effects: [`Removes ${key} from the active risk register and its lists.`, "Its versions and audit trail stay."],
      consequence: `risk ${key} leaves the active risk register`,
    });
    const result = await session.call(
      "delete_risk",
      { ...workspaceArgs(workspace), governanceScopeId: framework.id, id: pick(risk, "riskId") || ref },
      attempt,
      { write: true, requestId: requestId(context) },
    );
    const applied = Array.isArray(result.applied) ? (result.applied as string[]) : [];
    writeResult(context, {
      record: RISK,
      outcome: applied.length === 0 && risk.status === "closed" ? "unchanged" : "deleted",
      verb: "Deleted",
      id: key,
      document: result,
    });
  },
};

export const risks: GroupSpec = {
  kind: "group",
  name: "risks",
  aliases: ["risk"],
  summary: "List, inspect, create, update and delete risks",
  children: [list, inspect, create, update, remove],
};
