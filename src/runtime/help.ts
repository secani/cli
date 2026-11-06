import { displayWidth, padEnd, type Style } from "./style";
import { wrap } from "./layout";
import {
  childrenOf,
  GLOBAL_OPTIONS,
  type CommandSpec,
  type GroupSpec,
  type Node,
  type OptionSpec,
  type RootSpec,
} from "./spec";

// Help is generated from command metadata: usage and summary, commands,
// arguments, options (alphabetical), global options, examples, notes.

function optionSyntax(option: OptionSpec): string {
  const short = option.short ? `-${option.short}, ` : "";
  const value = option.type === "boolean" ? "" : ` ${option.value ?? "<VALUE>"}`;
  return `${short}--${option.name}${value}`;
}

function optionDescription(option: OptionSpec): string {
  let text = option.description;
  if (option.choices && !text.includes(option.choices[0]!)) text += ` (${option.choices.join(", ")})`;
  if (option.default !== undefined) text += ` (default: ${option.default})`;
  if (option.negatable && option.type !== "boolean") text += `; --no-${option.name} clears it`;
  return text;
}

function usage(root: RootSpec, path: string[], node: Node): string {
  const parts = [root.name, ...path];
  if (node.kind === "command") {
    for (const arg of node.args ?? []) parts.push(arg.required ? `<${arg.name}>` : `[${arg.name}]`);
    parts.push("[options]");
  } else {
    parts.push("<command>", "[options]");
  }
  return parts.join(" ");
}

/** Two-column entries; a description that doesn't fit moves below its syntax. */
function entries(style: Style, items: Array<[string, string]>, nameStyle: (text: string) => string): string[] {
  const width = Math.min(30, Math.max(...items.map(([name]) => displayWidth(name))) + 2);
  const lines: string[] = [];
  const available = Math.max(30, style.columns - 2 - width);
  for (const [name, description] of items) {
    if (displayWidth(name) + 2 > width) {
      lines.push(`  ${nameStyle(name)}`);
      for (const line of wrap(description, Math.max(30, style.columns - 4))) lines.push(`    ${line}`);
      continue;
    }
    const wrapped = wrap(description, available);
    lines.push(`  ${nameStyle(padEnd(name, width))}${wrapped[0] ?? ""}`.replace(/\s+$/, ""));
    for (const line of wrapped.slice(1)) lines.push(`  ${" ".repeat(width)}${line}`);
  }
  return lines;
}

export function renderHelp(style: Style, root: RootSpec, path: string[], node: Node): string {
  const out: string[] = [];
  out.push(style.bold(usage(root, path, node)));
  out.push(style.faint(node.summary));

  if (node.kind === "root") {
    for (const section of node.sections) {
      out.push("", style.heading(`${section.title}:`));
      out.push(...entries(style, section.entries.map((entry) => [entry.name, entry.summary]), style.bold));
    }
  } else if (node.kind === "group") {
    out.push("", style.heading("Commands:"));
    out.push(...entries(style, node.children.map((child) => [child.name, child.summary]), style.bold));
  }

  if (node.kind === "command") {
    const args = node.args ?? [];
    if (args.length > 0) {
      out.push("", style.heading("Arguments:"));
      out.push(...entries(style, args.map((arg) => [arg.required ? `<${arg.name}>` : `[${arg.name}]`, arg.description]), (t) => t));
    }
    const options = [...(node.options ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (options.length > 0) {
      out.push("", style.heading("Options:"));
      out.push(...entries(style, options.map((option) => [optionSyntax(option), optionDescription(option)]), style.bold));
    }
  }

  if (node.kind === "root") {
    out.push("", style.heading("Global Options:"));
    out.push(
      ...entries(
        style,
        GLOBAL_OPTIONS.map((option) => [optionSyntax(option), optionDescription(option)]),
        style.bold,
      ),
    );
  } else {
    out.push("", `${style.heading("Global Options:")} See \`${root.name} --help\``);
  }

  const examples = node.examples ?? [];
  if (examples.length > 0) {
    out.push("", style.heading("Examples:"));
    examples.forEach((example, index) => {
      if (index > 0) out.push("");
      out.push(`  ${example.title}`, `    ${style.command(example.command)}`);
    });
  }

  const notes = node.kind === "command" || node.kind === "root" ? node.notes ?? [] : [];
  if (notes.length > 0) {
    out.push("", style.heading("Notes:"));
    for (const note of notes) {
      const wrapped = wrap(note, Math.max(30, style.columns - 4));
      out.push(`  ${wrapped[0]}`, ...wrapped.slice(1).map((line) => `  ${line}`));
    }
  }
  return `${out.join("\n")}\n`;
}

function optionJson(option: OptionSpec) {
  return {
    name: option.name,
    short: option.short ?? null,
    type: option.type,
    valueHint: option.value ?? null,
    default: option.default ?? null,
    choices: option.choices ? [...option.choices] : null,
    repeatable: option.repeat === "append",
    negatable: option.negatable === true,
  };
}

export function helpJson(root: RootSpec, path: string[], node: Node): Record<string, unknown> {
  return {
    path: [root.name, ...path].join(" "),
    usage: usage(root, path, node),
    summary: node.summary,
    subcommands: childrenOf(node).map((child) => ({ name: child.name, summary: child.summary })),
    arguments:
      node.kind === "command"
        ? (node.args ?? []).map((arg) => ({ name: arg.name, required: arg.required, description: arg.description }))
        : [],
    options: node.kind === "command" ? (node.options ?? []).map(optionJson) : [],
    globalOptions: GLOBAL_OPTIONS.map(optionJson),
    consequence: node.kind === "command" ? node.consequence : null,
    resultSchema: node.kind === "command" ? node.resultSchema ?? null : null,
    examples: node.examples ?? [],
  };
}

/** Every leaf command with its full path. */
export function allCommands(root: RootSpec): Array<{ path: string[]; spec: CommandSpec }> {
  const out: Array<{ path: string[]; spec: CommandSpec }> = [];
  const visit = (node: CommandSpec | GroupSpec, prefix: string[]) => {
    const path = [...prefix, node.name];
    if (node.kind === "command") {
      if (!node.hidden) out.push({ path, spec: node });
    } else {
      for (const child of node.children) visit(child, path);
    }
  };
  for (const child of childrenOf(root)) visit(child, []);
  return out;
}

/** Offline command search over paths, summaries, options and examples. */
export function searchCommands(root: RootSpec, query: string): Array<{ path: string; summary: string }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = allCommands(root)
    .map(({ path, spec }) => {
      const haystack = [
        path.join(" "),
        spec.summary,
        ...(spec.options ?? []).map((option) => `${option.name} ${option.description}`),
        ...(spec.examples ?? []).map((example) => `${example.title} ${example.command}`),
      ]
        .join(" ")
        .toLowerCase();
      const pathText = path.join(" ").toLowerCase();
      let score = 0;
      for (const word of words) {
        if (pathText.includes(word)) score += 3;
        else if (haystack.includes(word)) score += 1;
        else if (word.endsWith("s") && haystack.includes(word.slice(0, -1))) score += 1;
        else return { path, spec, score: 0 };
      }
      return { path, spec, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map(({ path, spec }) => ({ path: [root.name, ...path].join(" "), summary: spec.summary }));
}
