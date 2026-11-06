import { ROOT } from "./commands/index";
import { bindArgs, parseArgv, unknownCommand, withOptions } from "./runtime/args";
import { CliError, isAbort } from "./runtime/errors";
import { setClock } from "./runtime/format";
import { allCommands, helpJson, renderHelp, searchCommands } from "./runtime/help";
import type { Io } from "./runtime/io";
import { resolveMode, type Mode } from "./runtime/mode";
import { Output } from "./runtime/output";
import { childrenOf, type Node } from "./runtime/spec";
import { createStyle } from "./runtime/style";
import { Session } from "./session";
import { VERSION } from "./version";

function earlyFlags(argv: string[]) {
  const before = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  return {
    json: before.includes("--json"),
    nonInteractive: before.includes("--non-interactive") ? true : undefined,
    noColor: before.includes("--no-color"),
    debug: before.includes("--debug") || before.includes("-d"),
  };
}

/** The invocation to suggest for a rerun: without consent and without a previous request ID. */
export function replayArgv(argv: string[]): string[] {
  const out: string[] = ["secani"];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      // Everything after `--` is an argument, kept as typed.
      out.push(...argv.slice(index));
      break;
    }
    if (token === "--request-id") {
      index += 1;
      continue;
    }
    if (token.startsWith("--request-id=") || token === "--yes" || token === "-y" || token === "--yes=true") continue;
    out.push(token);
  }
  return out;
}

function printHelp(io: Io, mode: Mode, path: string[], node: Node): number {
  if (mode.json) {
    io.stdout.write(`${JSON.stringify(helpJson(ROOT, path, node), null, io.stdout.isTTY ? 2 : undefined)}\n`);
  } else {
    io.stdout.write(renderHelp(createStyle(mode.stdout, { help: true, accessible: mode.accessible }), ROOT, path, node));
  }
  return 0;
}

/** `secani help`, `secani help <path>`, `secani help search <query>`, `secani help --all --json`. */
function runHelpCommand(io: Io, mode: Mode, rest: string[]): number {
  const words = rest.filter((token) => !token.startsWith("-"));
  if (words[0] === "search") {
    const query = words.slice(1).join(" ");
    const matches = searchCommands(ROOT, query);
    if (mode.json) {
      io.stdout.write(`${JSON.stringify({ commands: matches })}\n`);
    } else if (matches.length === 0) {
      io.stderr.write(`  No commands match ${JSON.stringify(query)}.\n`);
    } else {
      const style = createStyle(mode.stdout, { help: true });
      const width = Math.max(...matches.map((match) => match.path.length)) + 2;
      io.stdout.write(`${matches.map((match) => `  ${style.bold(match.path.padEnd(width))}${match.summary}`).join("\n")}\n`);
    }
    return 0;
  }
  if (rest.includes("--all") && mode.json) {
    io.stdout.write(
      `${JSON.stringify({ commands: allCommands(ROOT).map(({ path, spec }) => helpJson(ROOT, path, spec)) })}\n`,
    );
    return 0;
  }
  const parsed = parseArgv(ROOT, [...words, "--help"]);
  if (parsed.positionals.length > 0 && parsed.node.kind !== "command") throw unknownCommand(ROOT, parsed);
  return printHelp(io, mode, parsed.path, parsed.node);
}

export async function runCli(argv: string[], io: Io): Promise<number> {
  setClock(() => io.now());
  let mode = resolveMode(io, earlyFlags(argv));
  let out = new Output(io, mode);
  let session: Session | undefined;
  let path: string[] = [];
  try {
    const firstWord = argv.find((token) => !token.startsWith("-"));
    if (firstWord === "help" && argv.indexOf("help") === argv.findIndex((token) => !token.startsWith("-"))) {
      return runHelpCommand(io, mode, argv.slice(argv.indexOf("help") + 1));
    }
    const parsed = parseArgv(ROOT, argv);
    path = parsed.path;
    mode = resolveMode(io, {
      json: parsed.options.json === true,
      nonInteractive: parsed.options["non-interactive"] as boolean | undefined,
      noColor: parsed.options["no-color"] === true,
      debug: parsed.options.debug === true,
    });
    out = new Output(io, mode);
    if (parsed.help) return printHelp(io, mode, parsed.path, parsed.node);
    if (parsed.version) {
      io.stdout.write(mode.json ? `${JSON.stringify({ version: VERSION })}\n` : `${VERSION}\n`);
      return 0;
    }
    const node = parsed.node;
    if (node.kind !== "command") {
      if (parsed.positionals.length > 0) throw unknownCommand(ROOT, parsed);
      return printHelp(io, mode, parsed.path, node);
    }
    const args = bindArgs(ROOT, parsed, node);
    session = new Session(io, mode, VERSION, parsed.options.workspace as string | undefined);
    session.recoveryPath = parsed.path;
    session.replayArgv = replayArgv(argv);
    const code = await node.run({
      io,
      mode,
      out,
      spec: node,
      args,
      options: parsed.options,
      given: parsed.given,
      session,
    });
    return code ?? 0;
  } catch (error) {
    return handleFailure(error, io, out, session, path);
  }
}

function handleFailure(error: unknown, io: Io, out: Output, session: Session | undefined, path: string[]): number {
  if (isAbort(error) || io.signal.aborted) {
    const reason = io.signal.reason as { exitCode?: number } | undefined;
    const exitCode = typeof reason?.exitCode === "number" ? reason.exitCode : 130;
    const pending = session?.inFlightWrite;
    out.error(
      new CliError(
        pending
          ? {
              class: "canceled",
              reason: "canceled",
              message: `Stopped waiting. Can't confirm whether Secani finished: ${pending.action}.`,
              data: { remote: "unknown", requestId: pending.requestId },
              recovery: [
                {
                  instruction: "Run it again with the same request ID; Secani applies it at most once",
                  command: { argv: withOptions(session?.replayArgv ?? ["secani"], "--request-id", pending.requestId) },
                },
              ],
              exitCode,
            }
          : { class: "canceled", reason: "canceled", message: "Canceled.", data: { remote: "none" }, exitCode },
      ),
    );
    return exitCode;
  }
  if ((error as NodeJS.ErrnoException)?.code === "EPIPE") return 0;
  if (error instanceof CliError) {
    out.error(error);
    return error.exitCode;
  }
  const failure = error as Error;
  if (out.mode.debug && failure?.stack) io.stderr.write(`${failure.stack}\n`);
  const bug = new CliError({
    class: "internal",
    reason: "internal_error",
    message: `Unexpected error in ${["secani", ...path].join(" ")}. This is a bug in Secani CLI.`,
    context: [
      ["Error", failure?.name ?? typeof error],
      ["Version", `Secani CLI ${VERSION}, Node.js ${process.versions.node}, ${process.platform}-${process.arch}`],
    ],
    recovery: [{ instruction: "Run the command again with --debug for the stack trace, which can include workspace names, and send it to Secani support." }],
  });
  out.error(bug);
  return bug.exitCode;
}

export { ROOT, childrenOf };
