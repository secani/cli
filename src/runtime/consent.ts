import { withOptions } from "./args";
import { CliError } from "./errors";
import type { CommandContext } from "./spec";

// One confirmation helper for every consequential command. Ordinary writes
// never ask. Destructive work previews its exact target and effects, then asks
// (y/N); non-interactive runs need --yes. Severe work asks for the exact name.

export type ConsentRequest = {
  tier: "destructive" | "severe";
  /** "Delete risk RI-12?" */
  question: string;
  /** One line per effect, shown before the question. */
  effects: string[];
  /** For severe work: the noun and exact name to type. */
  confirmName?: { noun: string; name: string };
  /** The consequence, for the `when` of the --yes continuation. */
  consequence: string;
};

export async function requireConsent(context: CommandContext, request: ConsentRequest): Promise<void> {
  const { mode, out, io, options } = context;
  const yes = options.yes === true;
  if (yes && (request.tier === "destructive" || !mode.interactive)) return;
  if (!mode.interactive) {
    throw new CliError({
      class: "missing_input",
      reason: "confirmation_required",
      message: `Can't ${request.question.replace(/\?$/, "").replace(/^./, (c) => c.toLowerCase())} without --yes in non-interactive mode.`,
      userActionRequired: true,
      detail: request.effects,
      data: { effects: request.effects },
      recovery: [
        {
          instruction: "After a person approves, run it again with --yes",
          command: { argv: withOptions(context.session.replayArgv, "--yes"), when: `Only after a human approves: ${request.consequence}` },
        },
      ],
    });
  }
  out.note(request.effects.map((line) => `  ${line}`).join("\n"));
  if (request.tier === "severe" && request.confirmName) {
    const { noun, name } = request.confirmName;
    const answer = await io.readLine(`${out.err.glyph("prompt")} To confirm, type the ${noun} name "${name}": `);
    out.prompted();
    if (answer === null) throw canceled();
    if (answer.trim() !== name) {
      throw new CliError({
        class: "usage",
        reason: "invalid_arguments",
        message: `Type only the ${noun} name "${name}". Nothing was changed.`,
      });
    }
    return;
  }
  const answer = await io.readLine(`${out.err.glyph("prompt")} ${request.question} (y/N) `);
  out.prompted();
  if (answer === null || !/^(y|yes)$/i.test(answer.trim())) throw canceled();
}

export function canceled(message = "Canceled. Nothing was changed."): CliError {
  return new CliError({ class: "canceled", reason: "canceled", message, data: { remote: "none" } });
}

/** A numbered choice on stderr. Non-interactive runs throw `missing` instead. */
export async function choose<T>(
  context: CommandContext,
  question: string,
  choices: Array<{ label: string; value: T }>,
  missing: () => CliError,
): Promise<T> {
  if (!context.mode.interactive) throw missing();
  const { out, io } = context;
  out.note(choices.map((choice, index) => `  ${index + 1}) ${choice.label}`).join("\n"));
  for (let tries = 0; tries < 3; tries += 1) {
    const answer = await io.readLine(`${out.err.glyph("prompt")} ${question} (1-${choices.length}) `);
    if (answer === null) throw canceled("Canceled.");
    const index = Number(answer.trim()) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index]!.value;
    out.note(`  Enter a number from 1 to ${choices.length}.`);
  }
  throw canceled("Canceled.");
}
