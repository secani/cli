import type { Io, OutStream } from "./io";

// The one place that decides interaction, format, presentation and color.
// Commands read the resolved Mode and never check isTTY, CI or agent
// variables themselves.

export type Mode = {
  interactive: boolean;
  json: boolean;
  /** A coding agent's harness runs this process. */
  agent: boolean;
  ci: boolean;
  /** Plain words instead of glyphs, no redraws (SECANI_ACCESSIBLE=1). */
  accessible: boolean;
  /** Optional next steps (SECANI_GUIDANCE_DISABLED=1 turns them off). */
  guidance: boolean;
  debug: boolean;
  stdout: StreamStyle;
  stderr: StreamStyle;
};

export type StreamStyle = {
  /** A TTY whose TERM isn't dumb: glyphs, aligned tables, redraws. */
  rich: boolean;
  color: boolean;
  /** Display width; 80 when unknown. */
  columns: number;
};

// Environment variables that coding-agent harnesses set for the commands they run.
const AGENT_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "GEMINI_CLI",
  "OPENCODE",
  "AI_AGENT",
];

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export function isAgent(env: Io["env"]): boolean {
  return AGENT_VARIABLES.some((name) => truthy(env[name]));
}

export function isCi(env: Io["env"]): boolean {
  return truthy(env.CI);
}

function streamStyle(stream: OutStream, env: Io["env"], noColor: boolean): StreamStyle {
  const dumb = env.TERM === "dumb";
  const rich = stream.isTTY && !dumb;
  let color: boolean;
  if (noColor) color = false;
  else if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") color = false;
  else if (env.FORCE_COLOR !== undefined) color = env.FORCE_COLOR !== "0" && env.FORCE_COLOR.toLowerCase() !== "false";
  else color = rich;
  return { rich, color, columns: stream.columns && stream.columns > 0 ? stream.columns : 80 };
}

export function resolveMode(
  io: Io,
  flags: { json: boolean; nonInteractive: boolean | undefined; noColor: boolean; debug: boolean },
): Mode {
  const agent = isAgent(io.env);
  const ci = isCi(io.env);
  const terminal = io.stdinIsTTY && io.stderr.isTTY;
  let interactive: boolean;
  if (flags.nonInteractive === true || flags.json || ci || !terminal) interactive = false;
  // --non-interactive=false restores prompts for an agent on a TTY.
  else if (agent) interactive = flags.nonInteractive === false;
  else interactive = true;
  return {
    interactive,
    json: flags.json,
    agent,
    ci,
    accessible: truthy(io.env.SECANI_ACCESSIBLE),
    guidance: !truthy(io.env.SECANI_GUIDANCE_DISABLED),
    debug: flags.debug,
    stdout: streamStyle(io.stdout, io.env, flags.noColor),
    stderr: streamStyle(io.stderr, io.env, flags.noColor),
  };
}
