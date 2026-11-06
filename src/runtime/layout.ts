import { cleanRemote, displayWidth, padEnd, truncate, type Glyph, type Style } from "./style";

// Shared layout helpers: the status gutter (column 0 glyph, content from
// column 2), label/value rows (label in a 16-character column, value from
// column 18), tables and capped lists. Commands never hand-pad.

export const LABEL_WIDTH = 16;
const GAP = "   ";

export type Row = [label: string, value: string];

export function row(style: Style, label: string, value: string, gutter: Glyph | null = null): string {
  const lead = gutter && style.rich ? style.glyph(gutter) : " ";
  const labelText = padEnd(label, LABEL_WIDTH);
  const indent = " ".repeat(LABEL_WIDTH + 2);
  const lines = value.split("\n");
  const width = style.columns - (LABEL_WIDTH + 2);
  // A value that doesn't fit beside its label moves to the next line, unless it
  // is one unbreakable token (an ID or URL), which may soft-wrap instead.
  if (lines.length === 1 && displayWidth(value) > width && /\s/.test(value)) {
    const wrapped = wrap(value, Math.max(20, width));
    return [`${lead} ${labelText}${wrapped[0]}`, ...wrapped.slice(1).map((line) => indent + line)].join("\n");
  }
  return [`${lead} ${labelText}${lines[0] ?? ""}`, ...lines.slice(1).map((line) => indent + line)].join("\n");
}

export function rows(style: Style, entries: Array<Row | null | undefined>): string {
  return entries
    .filter((entry): entry is Row => Boolean(entry) && entry![1] !== "")
    .map(([label, value]) => row(style, label, value))
    .join("\n");
}

/**
 * The primary outcome line. Rich: `✓ Created         RI-14`. Plain: a
 * sentence at column 0 (`Created RI-14`).
 */
export function outcomeLine(style: Style, verb: string, value: string, glyph: Glyph = "success"): string {
  if (!style.rich) return value ? `${verb} ${value}` : verb;
  const label = style.bold(padEnd(verb, LABEL_WIDTH));
  return `${style.glyph(glyph)} ${value ? label + value : style.bold(verb)}`;
}

/** Plain sentence lines indented on the shared gutter. */
export function prose(style: Style, text: string): string {
  return wrap(text, Math.max(20, style.columns - 2)).map((line) => `  ${line}`).join("\n");
}

/** An instruction ending in ":" with the command indented 4 spaces on its own line. */
export function nextStep(style: Style, instruction: string, command?: string): string {
  const head = `  ${instruction}${command ? ":" : ""}`;
  return command ? `${head}\n    ${style.command(command)}` : head;
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      if (line === "") line = word;
      else if (displayWidth(line) + 1 + displayWidth(word) <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** At most 5 items, then "and N more". */
export function capped<T>(items: T[], render: (item: T) => string, more?: (rest: number) => string): string[] {
  const shown = items.slice(0, 5).map(render);
  if (items.length > 5) shown.push(more ? more(items.length - 5) : `and ${items.length - 5} more`);
  return shown;
}

export type Column<T> = {
  header: string;
  /** Value on a TTY: human words, relative ages. */
  human: (item: T) => string;
  /** Value off a TTY: API values and ISO times, never truncated. */
  raw?: (item: T) => string;
  /** A descriptive column that may shorten with "…" on a narrow TTY. */
  flex?: boolean;
};

/**
 * A borderless table. On a TTY: aligned, indented 2, descriptive columns
 * shortened first, compact records when even that doesn't fit. Off a TTY:
 * header plus tab-separated rows, untruncated.
 */
export function table<T>(style: Style, columns: Column<T>[], items: T[]): string {
  if (!style.rich) {
    const cell = (text: string) => text.replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
    const lines = [columns.map((column) => column.header).join("\t")];
    for (const item of items) {
      lines.push(columns.map((column) => cell(cleanRemote((column.raw ?? column.human)(item)))).join("\t"));
    }
    return lines.join("\n");
  }
  const cells = items.map((item) => columns.map((column) => cleanRemote(column.human(item))));
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.header), ...cells.map((line) => displayWidth(line[index]!))),
  );
  const available = style.columns - 2;
  const total = () => widths.reduce((sum, width) => sum + width, 0) + GAP.length * (widths.length - 1);
  const MIN_FLEX = 12;
  for (let index = 0; index < columns.length && total() > available; index += 1) {
    if (!columns[index]!.flex) continue;
    const excess = total() - available;
    widths[index] = Math.max(Math.min(MIN_FLEX, widths[index]!), widths[index]! - excess);
  }
  if (total() > available) {
    // Compact records: one short block per row with the same fields.
    return cells
      .map((line) =>
        line
          .map((value, index) => row(style, columns[index]!.header, value))
          .filter((_, index) => line[index] !== "")
          .join("\n"),
      )
      .join("\n\n");
  }
  const render = (values: string[]) =>
    `  ${values
      .map((value, index) => {
        const fitted = truncate(value, widths[index]!);
        return index === values.length - 1 ? fitted : fitted + " ".repeat(widths[index]! - displayWidth(fitted));
      })
      .join(GAP)}`.replace(/\s+$/, "");
  return [render(columns.map((column) => column.header)), ...cells.map((line) => render(line))].join("\n");
}

export { padEnd };
