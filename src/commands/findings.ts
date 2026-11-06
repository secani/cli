import { age, iso, when, words } from "../runtime/format";
import type { GroupSpec } from "../runtime/spec";
import { inspectCommand, listCommand, pick, type RecordDef } from "./records";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const DISPOSITIONS = ["open", "accepted", "mitigated", "false_positive", "deferred", "closed"] as const;
const CATEGORIES = ["security", "privacy", "compliance", "operational", "control_gap", "other"] as const;

export const FINDING: RecordDef = {
  group: "findings",
  noun: "finding",
  plural: "findings",
  identity: (item) => pick(item, "displayKey", "findingKey", "findingId"),
};

function requirement(item: Record<string, unknown>): string {
  return [pick(item, "requirementCode"), pick(item, "requirementTitle")].filter(Boolean).join(" ");
}

export const findings: GroupSpec = {
  kind: "group",
  name: "findings",
  aliases: ["finding"],
  summary: "List and inspect audit and assessment findings",
  children: [
    listCommand({
      record: FINDING,
      summary: "List the workspace's findings",
      tool: "list_findings",
      pageLimit: 50,
      filters: [
        { option: { name: "severity", type: "string", value: "<SEVERITY>", choices: SEVERITIES, description: "Only findings with this severity" }, input: "severity" },
        { option: { name: "disposition", type: "string", value: "<DISPOSITION>", choices: DISPOSITIONS, description: "Only findings with this disposition" }, input: "disposition" },
        { option: { name: "category", type: "string", value: "<CATEGORY>", choices: CATEGORIES, description: "Only findings in this category" }, input: "category" },
      ],
      columns: [
        { header: "ID", human: (item) => FINDING.identity(item) },
        { header: "Severity", human: (item) => words(item.severity), raw: (item) => pick(item, "severity") },
        { header: "Disposition", human: (item) => words(item.disposition), raw: (item) => pick(item, "disposition") },
        { header: "Category", human: (item) => words(item.category), raw: (item) => pick(item, "category") },
        { header: "Requirement", human: requirement, flex: true },
        { header: "Detected", human: (item) => age(item.detectedAt), raw: (item) => iso(item.detectedAt) },
      ],
      examples: [{ title: "List open critical findings", command: "secani findings list --severity critical --disposition open" }],
    }),
    inspectCommand({
      record: FINDING,
      summary: "Show a finding",
      tool: "get_finding",
      idInput: "findingId",
      argDescription: "The finding's ID, such as FI-7",
      resultKey: "finding",
      fields: [
        ["ID", (item) => FINDING.identity(item)],
        ["Severity", (item) => words(item.severity)],
        ["Disposition", (item) => words(item.disposition)],
        ["Category", (item) => words(item.category)],
        ["Requirement", requirement],
        ["Origin", (item) => words(item.originKind)],
        ["Control Test", (item) => [pick(item, "controlTestDisplayKey"), pick(item, "controlTestTitle")].filter(Boolean).join(" ")],
        ["Issue", (item) => pick((item.issue as Record<string, unknown>) ?? {}, "issueKey")],
        ["Detected", (item) => when(item.detectedAt)],
      ],
      examples: [{ title: "Show a finding", command: "secani findings inspect FI-7" }],
    }),
  ],
};
