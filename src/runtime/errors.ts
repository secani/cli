// One typed error for every failure. The class fixes the exit code; the
// reason is a stable snake_case code from the registry below; the message is
// CLI-written copy (server text only ever goes in an attributed detail row or
// data.remoteMessage).

export type ErrorClass =
  | "usage"
  | "missing_input"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "limit"
  | "rate_limit"
  | "network"
  | "platform"
  | "unknown_outcome"
  | "partial"
  | "config"
  | "internal"
  | "canceled";

export const REASONS = {
  usage: [
    "invalid_arguments",
    "unknown_option",
    "unknown_command",
    "missing_argument",
    "conflicting_options",
    "ambiguous_reference",
    "agent_cannot_switch",
  ],
  missing_input: [
    "missing_workspace",
    "missing_framework",
    "missing_value",
    "confirmation_required",
    "requires_terminal",
  ],
  authentication: ["login_required", "token_expired", "login_denied", "login_expired"],
  permission: ["permission_denied", "writes_disabled", "workspace_not_accessible", "approval_required"],
  not_found: ["not_found", "workspace_not_found", "tool_not_found"],
  conflict: ["conflict", "stale_version", "invalid_transition"],
  limit: ["limit_reached"],
  rate_limit: ["rate_limited"],
  network: ["network_error"],
  platform: ["api_error"],
  unknown_outcome: ["unknown_outcome", "timeout"],
  partial: ["partial_failure"],
  config: ["invalid_config"],
  internal: ["internal_error"],
  canceled: ["canceled"],
} as const satisfies Record<ErrorClass, readonly string[]>;

export type Reason = (typeof REASONS)[keyof typeof REASONS][number];

const EXIT_CODES: Record<ErrorClass, number> = {
  usage: 2,
  missing_input: 2,
  authentication: 1,
  permission: 1,
  not_found: 1,
  conflict: 1,
  limit: 1,
  rate_limit: 1,
  network: 1,
  platform: 1,
  unknown_outcome: 1,
  partial: 1,
  config: 1,
  internal: 1,
  canceled: 130,
};

export type NextCommand = { argv: string[]; when?: string };
export type Recovery = { instruction: string; command?: NextCommand };

export type CliErrorInit = {
  class: ErrorClass;
  reason: Reason;
  /** Headline: the failed action and its object, then the known cause. */
  message: string;
  detail?: string[];
  context?: Array<[string, string]>;
  ids?: Array<[string, string]>;
  recovery?: Recovery[];
  data?: Record<string, unknown>;
  /** A human must approve or perform a step before this can run. */
  userActionRequired?: boolean;
  /** Blocked before any effect; input, approval or a human step would let it run. */
  actionRequired?: boolean;
  retryable?: boolean;
  retryAfter?: number;
  requestId?: string;
  /** Overrides the class's exit code (signals: 128 + n). */
  exitCode?: number;
};

export class CliError extends Error {
  readonly init: CliErrorInit;
  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.init = init;
  }
  get exitCode(): number {
    return this.init.exitCode ?? EXIT_CODES[this.init.class];
  }
  get status(): "action_required" | "error" {
    if (this.init.actionRequired !== undefined) return this.init.actionRequired ? "action_required" : "error";
    return this.init.class === "missing_input" ? "action_required" : "error";
  }
}

export function isAbort(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";
}

export function usageError(message: string, init: Partial<CliErrorInit> = {}): CliError {
  return new CliError({ class: "usage", reason: "invalid_arguments", message, ...init });
}

/** Edit distance with adjacent transpositions (lsit → list is 1), for "Did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** At most one close suggestion. */
export function closest(input: string, candidates: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance <= Math.max(1, Math.floor(candidate.length / 3)) && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}
