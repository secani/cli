// Shared formatters for ages, dates, counts and API enums, used by every
// command so the same value always reads the same way.

let clock: () => number = () => Date.now();

/** The run's clock (tests inject a fixed one). */
export function setClock(now: () => number): void {
  clock = now;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/** Tables: relative under 7 days (2m, 5h, 3d), then Mar 5, 2026. Future: in 3d. */
export function age(value: unknown, now: number = clock()): string {
  const date = toDate(value);
  if (!date) return "";
  const diff = now - date.getTime();
  const span = Math.abs(diff);
  if (span < 7 * DAY) {
    const text = span < MINUTE ? "now" : span < HOUR ? `${Math.floor(span / MINUTE)}m` : span < DAY ? `${Math.floor(span / HOUR)}h` : `${Math.floor(span / DAY)}d`;
    if (text === "now") return text;
    return diff >= 0 ? text : `in ${text}`;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** ISO 8601 UTC, for non-TTY output. */
export function iso(value: unknown): string {
  const date = toDate(value);
  return date ? date.toISOString() : typeof value === "string" ? value : "";
}

/** A calendar date as stored (YYYY-MM-DD) or the date part of a timestamp. */
export function day(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = toDate(value);
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Detail views: local time with zone and age, such as 2026-09-28 14:03 CEST (2h ago). */
export function when(value: unknown, now: number = clock()): string {
  const date = toDate(value);
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}${zone ? ` ${zone}` : ""}`;
  const relative = age(value, now);
  return Math.abs(now - date.getTime()) < 7 * DAY && relative !== "now"
    ? `${stamp} (${relative.startsWith("in ") ? relative : `${relative} ago`})`
    : stamp;
}

/** in_progress → In progress. Unknown values render as words, never crash. */
export function words(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 1 risk, 3 risks; 1,000 with separators. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

export function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
