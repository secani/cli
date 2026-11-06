import { age, iso, words } from "../runtime/format";
import type { GroupSpec } from "../runtime/spec";
import { inspectCommand, listCommand, pick, type RecordDef } from "./records";

const KINDS = ["policy", "process", "procedure", "technical_control", "physical_control", "contractual_control", "service"] as const;
const MODES = ["direct", "inherited", "shared", "external"] as const;

// The app calls measures "Controls" in English; the MCP tools call them
// implementations.
export const CONTROL: RecordDef = {
  group: "controls",
  noun: "control",
  plural: "controls",
  identity: (item) => pick(item, "displayKey", "implementationKey", "implementationId"),
};

export const controls: GroupSpec = {
  kind: "group",
  name: "controls",
  aliases: ["control"],
  summary: "List and inspect controls (measures)",
  children: [
    listCommand({
      record: CONTROL,
      summary: "List the workspace's controls",
      tool: "list_implementations",
      framework: true,
      filters: [
        { option: { name: "kind", type: "string", value: "<KIND>", choices: KINDS, description: "Only controls of this kind" }, input: "kind" },
        { option: { name: "mode", type: "string", value: "<MODE>", choices: MODES, description: "Only controls provided this way" }, input: "provisionMode" },
        { option: { name: "search", type: "string", value: "<WORDS>", description: "Only controls whose title contains these words" }, input: "search" },
      ],
      columns: [
        { header: "ID", human: (item) => CONTROL.identity(item) },
        { header: "Title", human: (item) => pick(item, "title"), flex: true },
        { header: "Kind", human: (item) => words(item.kind), raw: (item) => pick(item, "kind") },
        { header: "State", human: (item) => words(item.implementationState), raw: (item) => pick(item, "implementationState") },
        { header: "Updated", human: (item) => age(item.updatedAt), raw: (item) => iso(item.updatedAt) },
      ],
      examples: [{ title: "Find backup controls", command: "secani controls list --search backup" }],
    }),
    inspectCommand({
      record: CONTROL,
      summary: "Show a control",
      tool: "get_implementation",
      idInput: "implementationId",
      argDescription: "The control's ID, such as M-12",
      resultKey: "implementation",
      fields: [
        ["ID", (item) => CONTROL.identity(item)],
        ["Title", (item) => pick(item, "title")],
        ["Kind", (item) => words(item.kind)],
        ["State", (item) => words(item.implementationState)],
        ["Provided", (item) => words(item.provisionMode)],
        ["Updated", (item) => age(item.updatedAt)],
      ],
      body: (item) => pick(item, "description", "content"),
      examples: [{ title: "Show a control", command: "secani controls inspect M-12" }],
    }),
  ],
};
