import type { StreamStyle } from "./mode";

// The one theme module: semantic roles, glyphs with plain fallbacks, and the
// sanitizer for remote text. Nothing else writes ANSI codes.

const CODES = {
  bold: [1, 22],
  faint: [2, 22],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

type Code = keyof typeof CODES;

export type Style = {
  rich: boolean;
  color: boolean;
  columns: number;
  bold(text: string): string;
  faint(text: string): string;
  underline(text: string): string;
  /** Help section headings. */
  heading(text: string): string;
  /** A complete command offered on its own line. */
  command(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  failure(text: string): string;
  glyph(kind: Glyph): string;
};

export type Glyph = "success" | "warning" | "error" | "prompt";

const RICH_GLYPHS: Record<Glyph, string> = { success: "✓", warning: "!", error: "✗", prompt: "?" };

export function createStyle(stream: StreamStyle, options: { accessible?: boolean; help?: boolean } = {}): Style {
  // Help stays unstyled when color is only forced onto a non-TTY.
  const color = stream.color && !(options.help && !stream.rich);
  const paint = (code: Code) => (text: string) => {
    if (!color || text === "") return text;
    const [open, close] = CODES[code];
    return `\u001b[${open}m${text}\u001b[${close}m`;
  };
  const rich = stream.rich && !options.accessible;
  return {
    rich,
    color,
    columns: stream.columns,
    bold: paint("bold"),
    faint: paint("faint"),
    underline: paint("underline"),
    heading: (text) => paint("bold")(paint("magenta")(text)),
    command: paint("cyan"),
    success: paint("green"),
    warning: paint("yellow"),
    failure: paint("red"),
    glyph: (kind) => {
      if (!rich) return " ";
      const glyph = RICH_GLYPHS[kind];
      if (kind === "success") return paint("green")(glyph);
      if (kind === "warning") return paint("yellow")(glyph);
      if (kind === "error") return paint("red")(glyph);
      return glyph;
    },
  };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Remote text (titles, names, server messages) is data, never terminal
 * instructions: strips escape sequences, C0/C1 controls and bidirectional or
 * zero-width format characters, and shows newlines and tabs as visible escapes
 * in single-line fields.
 */
export function cleanRemote(value: unknown, options: { multiline?: boolean } = {}): string {
  if (value === null || value === undefined) return "";
  let text = String(value).replace(ANSI, "");
  if (options.multiline) {
    text = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
    return text.replace(CONTROL, "");
  }
  text = text.replace(/\r\n?|\n/g, "\\n").replace(/\t/g, "\\t");
  return text.replace(CONTROL, "");
}

/** Terminal display width: wide East Asian characters count 2, combining marks 0. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0)!;
    if (code >= 0x300 && code <= 0x36f) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Shortens text to a display width, ending in "…". */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return "…".slice(0, width);
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
