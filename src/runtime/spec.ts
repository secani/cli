import type { Io } from "./io";
import type { Mode } from "./mode";
import type { Output } from "./output";
import type { Session } from "../session";

// Command metadata. The parser, help, `--help --json`, `help search` and the
// consent helper all read it; nothing scans argv by hand.

export type OptionType = "boolean" | "string" | "integer";

export type OptionSpec = {
  /** Long name without dashes, kebab-case. */
  name: string;
  short?: string;
  type: OptionType;
  /** Value hint, such as <STATUS>. */
  value?: string;
  description: string;
  choices?: readonly string[];
  /** Shown as (default: X). */
  default?: string;
  /** How a repeated option behaves; default "last". */
  repeat?: "last" | "append";
  /** Accepts --no-<name> (booleans only). */
  negatable?: boolean;
};

export type ArgSpec = {
  name: string;
  description: string;
  required: boolean;
};

export type Example = { title: string; command: string };

/** What a run can change, which sets the consent it needs. */
export type Consequence = "none" | "read" | "ordinary" | "destructive" | "severe";

export type CommandContext = {
  io: Io;
  mode: Mode;
  out: Output;
  spec: CommandSpec;
  args: Record<string, string | undefined>;
  options: Record<string, string | boolean | string[] | undefined>;
  /** Options the person gave (not defaults). */
  given: Set<string>;
  session: Session;
};

export type CommandSpec = {
  kind: "command";
  name: string;
  aliases?: string[];
  summary: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  examples?: Example[];
  notes?: string[];
  consequence: Consequence;
  /** Guaranteed fields of the --json result, with types. */
  resultSchema?: Record<string, string>;
  /** Lists accept --limit and --next. */
  hidden?: boolean;
  run(context: CommandContext): Promise<number | void>;
};

export type GroupSpec = {
  kind: "group";
  name: string;
  aliases?: string[];
  summary: string;
  /** Root help heading this group or command appears under. */
  children: Array<CommandSpec | GroupSpec>;
  examples?: Example[];
};

export type RootSpec = {
  kind: "root";
  name: string;
  summary: string;
  sections: Array<{ title: string; entries: Array<CommandSpec | GroupSpec> }>;
  examples?: Example[];
  notes?: string[];
};

export type Node = CommandSpec | GroupSpec | RootSpec;

export function childrenOf(node: Node): Array<CommandSpec | GroupSpec> {
  if (node.kind === "root") return node.sections.flatMap((section) => section.entries);
  if (node.kind === "group") return node.children;
  return [];
}

export function findChild(node: Node, token: string): CommandSpec | GroupSpec | undefined {
  return childrenOf(node).find((child) => child.name === token || child.aliases?.includes(token));
}

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "debug", short: "d", type: "boolean", description: "Print redacted diagnostic detail on stderr" },
  { name: "help", short: "h", type: "boolean", description: "Show help for the command; do no work" },
  { name: "json", type: "boolean", description: "Output the result as JSON; never prompts" },
  { name: "no-color", type: "boolean", description: "Disable color" },
  {
    name: "non-interactive",
    type: "boolean",
    description: "Never prompt; fail with the inputs needed instead",
  },
  { name: "version", short: "v", type: "boolean", description: "Print the CLI version" },
  {
    name: "workspace",
    short: "w",
    type: "string",
    value: "<ORG/WORKSPACE>",
    description: "Workspace to act in, such as acme/isms (default: SECANI_WORKSPACE, then the current workspace)",
  },
];

export const YES_OPTION: OptionSpec = {
  name: "yes",
  short: "y",
  type: "boolean",
  description: "Confirm without a prompt; needed in non-interactive mode",
};

export const LIMIT_OPTION = (fallback: number, cap: number): OptionSpec => ({
  name: "limit",
  type: "integer",
  value: "<N>",
  description: `Number of results to return, up to ${cap}`,
  default: String(fallback),
});

export const NEXT_OPTION: OptionSpec = {
  name: "next",
  type: "string",
  value: "<CURSOR>",
  description: "Continue from the cursor a previous page printed",
};

export const FRAMEWORK_OPTION: OptionSpec = {
  name: "framework",
  type: "string",
  value: "<FRAMEWORK>",
  description: "Framework to work in, by name or ID (default: the workspace's only framework)",
};
