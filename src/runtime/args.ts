import { closest, CliError, usageError } from "./errors";
import {
  childrenOf,
  findChild,
  GLOBAL_OPTIONS,
  type CommandSpec,
  type Node,
  type OptionSpec,
  type RootSpec,
} from "./spec";

export type ParsedValue = string | boolean | string[] | undefined;

export type Parsed = {
  /** The deepest node the command path reached. */
  node: Node;
  /** Canonical names of the path, without the root. */
  path: string[];
  positionals: string[];
  /** Everything after `--`. */
  passthrough: string[];
  options: Record<string, ParsedValue>;
  given: Set<string>;
  help: boolean;
  version: boolean;
};

function isOptionToken(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !/^-\d/.test(token);
}

function lookup(options: OptionSpec[], token: string): { spec: OptionSpec; inline?: string; negated: boolean } | undefined {
  if (token.startsWith("--")) {
    const [rawName, ...rest] = token.slice(2).split("=");
    const name = rawName!;
    const inline = rest.length > 0 ? rest.join("=") : undefined;
    const direct = options.find((option) => option.name === name);
    if (direct) return { spec: direct, ...(inline === undefined ? {} : { inline }), negated: false };
    if (name.startsWith("no-")) {
      const negated = options.find((option) => option.name === name.slice(3) && option.negatable);
      if (negated && inline === undefined) return { spec: negated, negated: true };
    }
    return undefined;
  }
  const short = token.slice(1);
  const [letter, ...rest] = short.split("=");
  const spec = options.find((option) => option.short === letter);
  if (!spec) return undefined;
  const inline = rest.length > 0 ? rest.join("=") : undefined;
  return { spec, ...(inline === undefined ? {} : { inline }), negated: false };
}

function displayPath(root: RootSpec, path: string[]): string {
  return [root.name, ...path].join(" ");
}

/**
 * Parses argv against the command tree: globals anywhere, command options
 * after the path, `--value`, `--name=value` and `-x value`, `--` ends option
 * parsing. Help is recognized before any other validation.
 */
export function parseArgv(root: RootSpec, argv: string[]): Parsed {
  const dashDash = argv.indexOf("--");
  const tokens = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  // Pass 1: the command path. Globals that take a value skip their value.
  let node: Node = root;
  const path: string[] = [];
  const pathIndexes = new Set<number>();
  let stopped = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isOptionToken(token)) {
      const found = lookup(GLOBAL_OPTIONS, token);
      if (found && found.spec.type !== "boolean" && found.inline === undefined) index += 1;
      continue;
    }
    if (stopped) continue;
    const child = findChild(node, token);
    if (child && node.kind !== "command") {
      node = child;
      path.push(child.name);
      pathIndexes.add(index);
    } else {
      stopped = true;
    }
  }

  const help = tokens.some((token) => token === "--help" || token === "-h" || token.startsWith("--help="));
  const leafOptions = node.kind === "command" ? node.options ?? [] : [];
  const known = [...GLOBAL_OPTIONS, ...leafOptions];
  const options: Record<string, ParsedValue> = {};
  const given = new Set<string>();
  const positionals: string[] = [];
  const problems: string[] = [];
  let firstUnknown: CliError | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    if (pathIndexes.has(index)) continue;
    const token = tokens[index]!;
    if (!isOptionToken(token)) {
      positionals.push(token);
      continue;
    }
    const found = lookup(known, token);
    if (!found) {
      if (!firstUnknown) {
        const name = token.split("=")[0]!;
        const candidates = known.flatMap((option) => [
          `--${option.name}`,
          ...(option.negatable ? [`--no-${option.name}`] : []),
        ]);
        const suggestion = name.startsWith("--") ? closest(name, candidates) : undefined;
        firstUnknown = usageError(
          `Unknown option ${name} for ${displayPath(root, path)}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
          {
            reason: "unknown_option",
            recovery: [{ instruction: "See all options", command: { argv: [root.name, ...path, "--help"] } }],
            ...(suggestion ? { data: { suggestion } } : {}),
          },
        );
      }
      continue;
    }
    const { spec, negated } = found;
    let value: string | boolean;
    if (negated) {
      // --no-<name>: off for a switch, cleared for a value.
      value = false;
    } else if (spec.type === "boolean") {
      if (found.inline === undefined) value = !negated;
      else if (found.inline === "true") value = true;
      else if (found.inline === "false") value = false;
      else {
        problems.push(`--${spec.name} takes true or false, not "${found.inline}".`);
        continue;
      }
    } else if (found.inline !== undefined) {
      value = found.inline;
    } else {
      const next = tokens[index + 1];
      if (next === undefined || (isOptionToken(next) && next !== "-")) {
        problems.push(`--${spec.name} needs a value${spec.value ? ` (${spec.value})` : ""}.`);
        continue;
      }
      value = next;
      index += 1;
    }
    if (spec.type === "integer" && typeof value === "string" && !/^\d+$/.test(value)) {
      problems.push(`--${spec.name} must be a whole number of 1 or more, not "${value}".`);
      continue;
    }
    if (spec.choices && typeof value === "string" && !spec.choices.includes(value)) {
      const suggestion = closest(value, [...spec.choices]);
      problems.push(
        `--${spec.name} accepts ${spec.choices.join(", ")}, not "${value}".${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
      );
      continue;
    }
    if (spec.repeat === "append") {
      const previous = options[spec.name];
      options[spec.name] = [...(Array.isArray(previous) ? previous : []), String(value)];
    } else {
      options[spec.name] = value;
    }
    given.add(spec.name);
  }

  const parsed: Parsed = {
    node,
    path,
    positionals,
    passthrough,
    options,
    given,
    help,
    version: options.version === true,
  };
  if (help) return parsed;
  if (firstUnknown) throw firstUnknown;
  if (problems.length > 0) {
    throw usageError(
      problems.length === 1 ? problems[0]! : `Can't run ${displayPath(root, path)}. ${problems.length} options are invalid.`,
      {
        reason: "invalid_arguments",
        ...(problems.length > 1 ? { detail: problems } : {}),
        data: { issues: problems.map((message) => ({ message })) },
        recovery: [{ instruction: "See all options", command: { argv: [root.name, ...path, "--help"] } }],
      },
    );
  }
  return parsed;
}

/** Positionals for a leaf: required ones present, no extras. */
export function bindArgs(root: RootSpec, parsed: Parsed, spec: CommandSpec): Record<string, string | undefined> {
  const declared = spec.args ?? [];
  // Values after `--` are positionals too, so a query may start with a hyphen.
  const positionals = [...parsed.positionals, ...parsed.passthrough];
  const values: Record<string, string | undefined> = {};
  declared.forEach((arg, index) => {
    values[arg.name] = positionals[index];
  });
  const missing = declared.filter((arg, index) => arg.required && positionals[index] === undefined);
  if (missing.length > 0) {
    const name = missing[0]!.name;
    throw new CliError({
      class: "usage",
      reason: "missing_argument",
      message: `Can't run ${displayPath(root, parsed.path)} without <${name}>.`,
      recovery: [{ instruction: "See the usage", command: { argv: [root.name, ...parsed.path, "--help"] } }],
    });
  }
  if (positionals.length > declared.length) {
    const extra = positionals[declared.length]!;
    throw usageError(`Unexpected argument ${JSON.stringify(extra)} for ${displayPath(root, parsed.path)}.`, {
      reason: "invalid_arguments",
      recovery: [{ instruction: "See the usage", command: { argv: [root.name, ...parsed.path, "--help"] } }],
    });
  }
  return values;
}

/** An unknown subcommand under a group. */
export function unknownCommand(root: RootSpec, parsed: Parsed): CliError {
  const segment = parsed.positionals[0]!;
  const names = childrenOf(parsed.node).map((child) => child.name);
  const suggestion = closest(segment, names);
  return new CliError({
    class: "usage",
    reason: "unknown_command",
    message: `Unknown command ${segment} for ${displayPath(root, parsed.path)}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    recovery: [{ instruction: "See the commands", command: { argv: [root.name, ...parsed.path, "--help"] } }],
    ...(suggestion ? { data: { suggestion } } : {}),
  });
}

/**
 * Adds options to a suggested rerun. They go before a `--`, where they would
 * otherwise be read as arguments.
 */
export function withOptions(argv: string[], ...options: string[]): string[] {
  const end = argv.indexOf("--");
  return end === -1 ? [...argv, ...options] : [...argv.slice(0, end), ...options, ...argv.slice(end)];
}

/** Quotes one argument for POSIX shells when it needs it. */
export function shellQuote(value: string): string {
  // Placeholders such as <TASK> stay as they are, for the reader to replace.
  if (/^<[A-Z_/]+>$/.test(value) || /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
