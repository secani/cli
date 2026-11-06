import { commandLine } from "./args";
import { CliError, type NextCommand } from "./errors";
import type { Io } from "./io";
import { nextStep, prose, row } from "./layout";
import type { Mode } from "./mode";
import { cleanRemote, createStyle, type Style } from "./style";

export type Warning = { reason: string; message: string };

/**
 * One writer per run. stdout carries the answer; everything else (context,
 * receipts, progress, prompts, warnings, errors, next steps) goes to stderr.
 * With --json, stdout holds exactly one document and stderr only the error
 * document; human lines become no-ops.
 */
export class Output {
  readonly out: Style;
  readonly err: Style;
  private readonly warnings: Warning[] = [];
  private stderrUsed = false;
  /** A blank line is due before the next stderr text (never trailing). */
  private pendingGap = false;
  private progressLine: { text: string; timer?: ReturnType<typeof setTimeout>; shown: boolean } | undefined;

  constructor(
    private readonly io: Io,
    readonly mode: Mode,
  ) {
    this.out = createStyle(mode.stdout, { accessible: mode.accessible });
    this.err = createStyle(mode.stderr, { accessible: mode.accessible });
  }

  get json(): boolean {
    return this.mode.json;
  }

  /** Human text on stderr: context, receipts, notes. Dropped under --json. */
  note(text: string): void {
    if (this.mode.json || text === "") return;
    this.clearProgress();
    if (this.pendingGap) this.io.stderr.write("\n");
    this.io.stderr.write(`${text}\n`);
    this.stderrUsed = true;
    this.pendingGap = false;
  }

  /** Separates phases with one blank line, written only if more text follows. */
  gap(): void {
    if (this.mode.json || !this.stderrUsed) return;
    this.pendingGap = true;
  }

  /** A prompt answered on stderr starts a new phase. */
  prompted(): void {
    this.stderrUsed = true;
    this.pendingGap = true;
  }

  /** Context rows (the resolved target) before results. */
  context(entries: Array<[string, string]>): void {
    if (entries.length === 0) return;
    this.note(entries.map(([label, value]) => row(this.err, label, value)).join("\n"));
    this.gap();
  }

  warn(reason: string, message: string, fix?: { instruction: string; command?: string[] }): void {
    this.warnings.push({ reason, message });
    if (this.mode.json) return;
    const head = `${this.err.rich ? `${this.err.glyph("warning")} ` : "Warning: "}${message}`;
    this.note(fix ? `${head}\n${nextStep(this.err, fix.instruction, fix.command && commandLine(fix.command))}` : head);
  }

  /** One next step: the benefit, then the command. Required recovery ignores guidance settings. */
  next(instruction: string, argv?: string[], options: { required?: boolean } = {}): void {
    if (!options.required && !this.mode.guidance) return;
    this.gap();
    this.note(nextStep(this.err, instruction, argv && commandLine(argv)));
  }

  /** The human answer on stdout. */
  answer(text: string): void {
    if (this.mode.json) return;
    this.clearProgress();
    this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    // On a terminal both streams share the screen: a next step after the
    // answer starts a new phase, after one blank line.
    this.stderrUsed = true;
  }

  /** The --json document. Pretty on a TTY, compact otherwise. */
  document(value: Record<string, unknown>): void {
    if (!this.mode.json) return;
    const doc = this.warnings.length > 0 ? { ...value, warnings: this.warnings } : value;
    this.io.stdout.write(`${JSON.stringify(doc, null, this.io.stdout.isTTY ? 2 : undefined)}\n`);
  }

  /**
   * Shows "Loading risks…" on an interactive rich stderr if the work takes
   * longer than 250 ms, and clears it before anything else prints. No
   * animation.
   */
  progress(text: string): () => void {
    if (this.mode.json || !this.mode.interactive || !this.err.rich) return () => undefined;
    this.clearProgress();
    const line: { text: string; timer?: ReturnType<typeof setTimeout>; shown: boolean } = { text, shown: false };
    line.timer = setTimeout(() => {
      this.io.stderr.write(`  ${text}`);
      line.shown = true;
    }, 250);
    this.progressLine = line;
    return () => {
      if (this.progressLine === line) this.clearProgress();
    };
  }

  private clearProgress(): void {
    const line = this.progressLine;
    if (!line) return;
    clearTimeout(line.timer);
    if (line.shown) this.io.stderr.write("\r\u001b[2K");
    this.progressLine = undefined;
  }

  /** Writes a failure: a human error on stderr, or one JSON line there. */
  error(error: CliError): void {
    this.clearProgress();
    const init = error.init;
    if (this.mode.json) {
      const doc: Record<string, unknown> = {
        status: error.status,
        reason: init.reason,
        message: init.message,
      };
      const next = (init.recovery ?? []).filter((step) => step.command).map((step) => nextJson(step.command!));
      if (next.length > 0) doc.next = next;
      if (init.data) doc.data = init.data;
      if (init.userActionRequired) doc.userActionRequired = true;
      if (init.requestId) doc.requestId = init.requestId;
      if (init.retryable !== undefined) doc.retryable = init.retryable;
      if (init.retryAfter !== undefined) doc.retryAfter = init.retryAfter;
      if (this.warnings.length > 0) doc.warnings = this.warnings;
      this.io.stderr.write(`${JSON.stringify(doc)}\n`);
      return;
    }
    const style = this.err;
    if (init.class === "canceled") {
      // A cancel isn't an error: no glyph, then what is known about the remote work.
      const recovery = (init.recovery ?? []).map((step) =>
        step.command ? nextStep(style, step.instruction, commandLine(step.command.argv)) : prose(style, step.instruction),
      );
      this.gapBeforeError();
      this.io.stderr.write(`${[init.message, ...(recovery.length > 0 ? ["", ...recovery] : [])].join("\n")}\n`);
      return;
    }
    const lines: string[] = [];
    const lead = style.rich ? `${style.glyph("error")} ` : "Error: ";
    lines.push(`${lead}${init.message}`);
    for (const detail of init.detail ?? []) lines.push(`  ${detail}`);
    for (const [label, value] of [...(init.context ?? []), ...(init.ids ?? [])]) lines.push(row(style, label, value));
    for (const [index, step] of (init.recovery ?? []).slice(0, 2).entries()) {
      // A blank line before the recovery; a second option follows directly.
      if (index === 0) lines.push("");
      lines.push(
        step.command
          ? nextStep(style, step.instruction, commandLine(step.command.argv))
          : prose(style, step.instruction),
      );
    }
    this.gapBeforeError();
    this.io.stderr.write(`${lines.join("\n")}\n`);
  }

  private gapBeforeError(): void {
    if (this.stderrUsed) this.io.stderr.write("\n");
    this.pendingGap = false;
  }
}

export function nextJson(command: NextCommand): { command: string; argv: string[]; when?: string } {
  return { command: commandLine(command.argv), argv: command.argv, ...(command.when ? { when: command.when } : {}) };
}

/** Remote text for human output. */
export const remote = cleanRemote;
