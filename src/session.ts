import { accessToken } from "./auth";
import { configDir, readSavedWorkspace, serverUrl, Store } from "./config";
import { McpClient, ToolFailure, type CallOptions } from "./mcp";
import { withOptions } from "./runtime/args";
import { CliError, type CliErrorInit } from "./runtime/errors";
import type { Io } from "./runtime/io";
import type { Mode } from "./runtime/mode";
import { cleanRemote } from "./runtime/style";

// Everything a command needs from the outside, resolved lazily: help and
// local commands never touch the config directory or the network.

export const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
/** A Convex document ID, such as a governance scope's. */
const CONVEX_ID = /^[0-9a-z]{31,37}$/;

export type WorkspaceTarget = {
  organizationSlug: string;
  workspaceSlug: string;
  /** `org/workspace` */
  ref: string;
  source: "option" | "environment" | "saved" | "only";
};

export type WhoamiOrganization = {
  organizationId: string;
  name: string;
  slug: string;
  accessLevel?: string;
  effect?: string;
  roles?: string[];
  canWrite?: boolean;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    slug: string;
    description?: string;
    governanceScopes?: Array<{ governanceScopeId: string; name: string; role?: string }>;
    governanceScopesTruncated?: boolean;
  }>;
};

export type Whoami = {
  user?: { workosUserId?: string };
  connector?: { clientId?: string; readOnlyMode?: boolean };
  organizations: WhoamiOrganization[];
};

/** What a failed call was trying to do, for CLI-written error copy. */
export type Attempt = {
  /** "update risk RI-12" */
  action: string;
  /** "risk" */
  noun?: string;
  /** "RI-12" */
  ref?: string;
  workspace?: string;
  /** The command that lists this noun, for not-found recovery. */
  listArgv?: string[];
};

export class Session {
  private storeInstance: Store | undefined;
  private clientInstance: McpClient | undefined;
  private workspaceInstance: Promise<WorkspaceTarget> | undefined;

  constructor(
    readonly io: Io,
    readonly mode: Mode,
    readonly version: string,
    private readonly workspaceOption: string | undefined,
  ) {}

  get server(): string {
    return serverUrl(this.io);
  }

  get store(): Store {
    this.storeInstance ??= new Store(configDir(this.io));
    return this.storeInstance;
  }

  debug = (message: string): void => {
    if (this.mode.debug) this.io.stderr.write(`[debug] ${message}\n`);
  };

  get client(): McpClient {
    this.clientInstance ??= new McpClient(
      this.io,
      this.server,
      {
        get: () => accessToken(this.io, this.store, this.server),
        refresh: () => accessToken(this.io, this.store, this.server, { force: true }),
      },
      this.version,
      this.debug,
    );
    return this.clientInstance;
  }

  /** Calls a tool and maps its failure to CLI copy for `attempt`. */
  /** A write that was sent and hasn't answered yet, for an honest cancel message. */
  inFlightWrite: { action: string; requestId: string } | undefined;

  async call(tool: string, args: Record<string, unknown>, attempt: Attempt, options: CallOptions = { write: false }): Promise<Record<string, unknown>> {
    if (options.write && options.requestId) this.inFlightWrite = { action: attempt.action, requestId: options.requestId };
    try {
      const result = await this.client.callTool(tool, args, options);
      this.inFlightWrite = undefined;
      return result;
    } catch (error) {
      if (!this.io.signal.aborted) this.inFlightWrite = undefined;
      if (error instanceof ToolFailure) throw toolError(error, attempt, options, this.replayArgv);
      if (error instanceof CliError && error.init.class === "unknown_outcome" && options.requestId) {
        throw unknownOutcome(error, attempt, options.requestId, this.replayArgv);
      }
      throw error;
    }
  }

  async whoami(args: Record<string, unknown> = {}): Promise<Whoami> {
    const result = await this.call("whoami", args, { action: "load your account" });
    return {
      ...(result as Whoami),
      organizations: Array.isArray((result as Whoami).organizations) ? (result as Whoami).organizations : [],
    };
  }

  /**
   * The workspace to act in, highest first: --workspace, SECANI_WORKSPACE, the
   * saved current workspace (never for a detected agent), the only workspace.
   */
  workspace(): Promise<WorkspaceTarget> {
    this.workspaceInstance ??= this.resolveWorkspace();
    return this.workspaceInstance;
  }

  private async resolveWorkspace(): Promise<WorkspaceTarget> {
    const option = this.workspaceOption?.trim();
    const fromEnv = this.io.env.SECANI_WORKSPACE?.trim() || undefined;
    for (const [value, label] of [
      [option, "--workspace"],
      [fromEnv, "SECANI_WORKSPACE"],
    ] as const) {
      if (value !== undefined && !WORKSPACE_PATTERN.test(value)) {
        throw new CliError({
          class: "usage",
          reason: "invalid_arguments",
          message: `${label} takes <ORG/WORKSPACE> in lowercase, such as acme/isms, not ${JSON.stringify(cleanRemote(value))}.`,
          recovery: [{ instruction: "List your workspaces", command: { argv: ["secani", "workspaces", "list"] } }],
        });
      }
    }
    if (option && fromEnv && option !== fromEnv) {
      throw new CliError({
        class: "usage",
        reason: "conflicting_options",
        message: `Can't use --workspace ${option} with SECANI_WORKSPACE=${fromEnv}. They name different workspaces.`,
        recovery: [{ instruction: "Pass one workspace, or unset SECANI_WORKSPACE." }],
      });
    }
    const target = (ref: string, source: WorkspaceTarget["source"]): WorkspaceTarget => {
      const [organizationSlug, workspaceSlug] = ref.split("/") as [string, string];
      return { organizationSlug, workspaceSlug, ref, source };
    };
    if (option) return target(option, "option");
    if (fromEnv) return target(fromEnv, "environment");
    if (!this.mode.agent) {
      const saved = await readSavedWorkspace(this.store, this.server);
      if (saved && WORKSPACE_PATTERN.test(saved)) return target(saved, "saved");
    }
    const whoami = await this.whoami({ includeScopes: false });
    const all = whoami.organizations.flatMap((org) => org.workspaces.map((ws) => `${org.slug}/${ws.slug}`));
    if (all.length === 1) return target(all[0]!, "only");
    if (all.length === 0) {
      throw new CliError({
        class: "not_found",
        reason: "workspace_not_found",
        message: "Couldn't find a workspace. Your account isn't a member of any Secani workspace.",
        recovery: [{ instruction: "Create a workspace in the Secani app, or ask an admin to invite you: https://app.secani.com" }],
      });
    }
    throw new CliError({
      class: "missing_input",
      reason: "missing_workspace",
      message: `Can't choose a workspace. ${all.length} workspaces are available.`,
      userActionRequired: false,
      data: { workspaces: all.map((ref) => ({ workspace: ref })) },
      recovery: this.mode.agent
        ? [
            {
              instruction: "Pass the workspace with --workspace",
              command: { argv: ["secani", ...this.argvForRecovery(), "--workspace", "<ORG/WORKSPACE>"], when: "Replace <ORG/WORKSPACE> with one from data.workspaces" },
            },
          ]
        : [
            { instruction: "Choose the current workspace", command: { argv: ["secani", "workspaces", "switch", "<ORG/WORKSPACE>"], when: "Replace <ORG/WORKSPACE> with one from data.workspaces" } },
            { instruction: "Or pass it with --workspace", command: { argv: ["secani", ...this.argvForRecovery(), "--workspace", "<ORG/WORKSPACE>"] } },
          ],
    });
  }

  /** The current command path, set by the dispatcher, for recovery commands. */
  recoveryPath: string[] = [];
  /** The invocation as typed, without --request-id, to rerun a keyed write. */
  replayArgv: string[] = ["secani"];
  private argvForRecovery(): string[] {
    return this.recoveryPath;
  }

  /** The workspace's frameworks (governance scopes), as whoami lists them. */
  async frameworks(
    target?: WorkspaceTarget,
  ): Promise<{ scopes: Array<{ governanceScopeId: string; name: string }>; truncated: boolean }> {
    const workspace = target ?? (await this.workspace());
    const whoami = await this.whoami({
      organizationSlug: workspace.organizationSlug,
      workspaceSlug: workspace.workspaceSlug,
      includeScopes: true,
    });
    const ws = whoami.organizations.flatMap((org) => org.workspaces)[0];
    return { scopes: ws?.governanceScopes ?? [], truncated: ws?.governanceScopesTruncated === true };
  }

  /**
   * The framework (governance scope) to act in: --framework by ID or exact
   * name (case-insensitive), else the workspace's only framework. Names are
   * resolved here because only some of Secani's tools accept them. `target`
   * is a workspace the command named itself, such as `tools call --input`.
   */
  async framework(
    given: string | undefined,
    attempt: Attempt,
    target?: WorkspaceTarget,
  ): Promise<{ id: string; name?: string; source: "option" | "only" }> {
    // An ID needs no lookup, and no workspace.
    if (given !== undefined && CONVEX_ID.test(given.trim())) return { id: given.trim(), source: "option" };
    const workspace = target ?? (await this.workspace());
    const { scopes, truncated } = await this.frameworks(workspace);
    if (given !== undefined) {
      const wanted = given.trim().toLocaleLowerCase("de-DE");
      const matches = scopes.filter((scope) => scope.name.trim().toLocaleLowerCase("de-DE") === wanted);
      const listed = { frameworks: scopes.map((scope) => ({ id: scope.governanceScopeId, name: scope.name })) };
      if (matches.length === 1) return { id: matches[0]!.governanceScopeId, name: matches[0]!.name, source: "option" };
      if (matches.length > 1) {
        throw new CliError({
          class: "usage",
          reason: "ambiguous_reference",
          message: `Can't ${attempt.action}. ${matches.length} frameworks in ${workspace.ref} are named ${JSON.stringify(cleanRemote(given))}.`,
          data: { frameworks: matches.map((scope) => ({ id: scope.governanceScopeId, name: scope.name })) },
          recovery: [{ instruction: "Pass the framework's ID with --framework; data.frameworks lists them." }],
        });
      }
      throw new CliError({
        class: "not_found",
        reason: "not_found",
        message: `Couldn't find framework ${JSON.stringify(cleanRemote(given))} in ${workspace.ref}.`,
        detail: scopes.slice(0, 5).map((scope) => cleanRemote(scope.name)).concat(scopes.length > 5 ? [`and ${scopes.length - 5} more`] : []),
        data: listed,
        recovery: [
          {
            instruction: truncated
              ? "This workspace has more frameworks than Secani lists by name; pass the framework's ID with --framework."
              : "Pass one of the names above, exactly, with --framework.",
          },
        ],
      });
    }
    if (scopes.length === 1 && !truncated) {
      return { id: scopes[0]!.governanceScopeId, name: scopes[0]!.name, source: "only" };
    }
    if (scopes.length === 0) {
      throw new CliError({
        class: "not_found",
        reason: "not_found",
        message: `Can't ${attempt.action}. ${workspace.ref} has no frameworks yet.`,
        recovery: [{ instruction: "Add a framework in the Secani app under Frameworks: https://app.secani.com" }],
      });
    }
    throw new CliError({
      class: "missing_input",
      reason: "missing_framework",
      message: `Can't ${attempt.action} without a framework. ${workspace.ref} has ${scopes.length} frameworks.`,
      data: { frameworks: scopes.map((scope) => ({ id: scope.governanceScopeId, name: scope.name })) },
      detail: scopes.slice(0, 5).map((scope) => cleanRemote(scope.name)).concat(scopes.length > 5 ? [`and ${scopes.length - 5} more`] : []),
      recovery: [
        {
          instruction: "Pass the framework with --framework",
          command: { argv: ["secani", ...this.recoveryPath, "--framework", "<FRAMEWORK>"], when: "Replace <FRAMEWORK> with a name or id from data.frameworks" },
        },
      ],
    });
  }
}

const VALIDATION_CODES = new Set([
  "VALIDATION_FAILED",
  "INVALID_DESCRIPTION",
  "INVALID_TITLE",
  "INVALID_TARGET",
  "INVALID_MODEL",
  "RATIONALE_REQUIRED",
  "EMPTY_SELECTION",
  "SCOPE_REQUIRED",
]);

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Maps a tool's error code to one CLI error class, reason and CLI-written copy. */
export function toolError(
  failure: ToolFailure,
  attempt: Attempt,
  options: CallOptions = { write: false },
  replayArgv: string[] = ["secani"],
): CliError {
  const where = attempt.workspace ? ` in ${attempt.workspace}` : "";
  const object = attempt.noun && attempt.ref ? `${attempt.noun} ${cleanRemote(attempt.ref)}` : attempt.noun ?? "it";
  const remote = cleanRemote(failure.remoteMessage);
  const base: Pick<CliErrorInit, "data"> = {
    data: { code: failure.code, ...(remote ? { remoteMessage: remote } : {}), ...failure.extra },
  };
  const detail = remote ? [`Secani: ${remote}`] : [];
  switch (failure.code) {
    case "NOT_FOUND":
    case "TOOL_NOT_FOUND":
      return new CliError({
        class: "not_found",
        reason: failure.code === "TOOL_NOT_FOUND" ? "tool_not_found" : "not_found",
        message: `Couldn't find ${object}${where}.`,
        detail,
        ...base,
        ...(attempt.listArgv ? { recovery: [{ instruction: `List the ${attempt.noun}s`, command: { argv: attempt.listArgv } }] } : {}),
      });
    case "AMBIGUOUS_REFERENCE": {
      const candidates = Array.isArray(failure.extra.candidates) ? (failure.extra.candidates as unknown[]) : [];
      return new CliError({
        class: "usage",
        reason: "ambiguous_reference",
        message: `Can't ${attempt.action}. ${cleanRemote(attempt.ref ?? "The reference")} matches more than one ${attempt.noun ?? "record"}.`,
        detail: candidates.slice(0, 5).map((candidate) => cleanRemote(JSON.stringify(candidate))),
        ...base,
        recovery: [{ instruction: `Use the ${attempt.noun ?? "record"}'s ID instead, such as the one shown in the app` }],
      });
    }
    case "UNAUTHENTICATED":
      return new CliError({
        class: "authentication",
        reason: "token_expired",
        message: "Your login expired.",
        userActionRequired: true,
        actionRequired: true,
        recovery: [{ instruction: "Log in again", command: { argv: ["secani", "login"] } }],
      });
    case "READ_ONLY_CONNECTOR":
      return new CliError({
        class: "permission",
        reason: "writes_disabled",
        message: `Can't ${attempt.action}. Writes are off for the Secani CLI connection.`,
        userActionRequired: true,
        actionRequired: true,
        ...base,
        recovery: [
          {
            instruction:
              "Allow writes for Secani CLI in the Secani app under Settings > Integrations, then run the command again.",
          },
        ],
      });
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPE":
      return new CliError({
        class: "permission",
        reason: "permission_denied",
        message: `You can't ${attempt.action}${where}. Your role doesn't allow it.`,
        detail,
        ...base,
        recovery: [{ instruction: "Ask a workspace admin for access." }],
      });
    case "APPROVAL_REQUIRED":
      return new CliError({
        class: "permission",
        reason: "approval_required",
        message: `Can't ${attempt.action}. Secani needs an approval that the CLI can't show.`,
        userActionRequired: true,
        actionRequired: true,
        ...base,
        recovery: [{ instruction: "Make this change in the Secani app: https://app.secani.com" }],
      });
    case "STALE_CURRENT":
    case "CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_REUSED":
      return new CliError({
        class: "conflict",
        reason: failure.code === "STALE_CURRENT" ? "stale_version" : "conflict",
        message:
          failure.code === "STALE_CURRENT"
            ? `Can't ${attempt.action}. It changed since it was read.`
            : failure.code.startsWith("IDEMPOTENCY")
              ? `Can't ${attempt.action}. The request ID was already used for a different change.`
              : `Can't ${attempt.action}. ${sentence(remote) || "It conflicts with the current state."}`,
        ...(failure.code === "CONFLICT" ? {} : { detail }),
        ...base,
        ...(failure.code.startsWith("IDEMPOTENCY")
          ? { recovery: [{ instruction: "Run the command again without --request-id, or with a new one." }] }
          : attempt.ref && attempt.noun
            ? { recovery: [{ instruction: `Read the ${attempt.noun} again before changing it` }] }
            : {}),
      });
    case "INVALID_TRANSITION":
      return new CliError({
        class: "conflict",
        reason: "invalid_transition",
        message: `Can't ${attempt.action}. That status change isn't allowed from the current status.`,
        detail,
        ...base,
      });
    case "LIMIT":
    case "TOO_MANY_RESULTS":
    case "PAYLOAD_TOO_LARGE":
    case "OUTPUT_TOO_LARGE":
      return new CliError({
        class: "limit",
        reason: "limit_reached",
        message: `Can't ${attempt.action}. It exceeds a Secani limit.`,
        detail,
        ...base,
      });
    case "PARTIAL_FAILURE":
      return new CliError({
        class: "partial",
        reason: "partial_failure",
        message: `Couldn't ${attempt.action} completely. Some steps were saved and others weren't.`,
        detail,
        ...base,
        ...(options.requestId
          ? {
              ids: [["Request ID", options.requestId]],
              recovery: [
                {
                  instruction: "Finish the remaining steps; the request ID keeps the saved ones from repeating",
                  command: { argv: withOptions(replayArgv, "--request-id", options.requestId) },
                },
              ],
            }
          : {}),
      });
    default:
      if (VALIDATION_CODES.has(failure.code) || failure.code.startsWith("INVALID_") || failure.code.startsWith("UNSUPPORTED_")) {
        const issues = Array.isArray(failure.extra.issues) ? (failure.extra.issues as Array<{ path?: string; message?: string }>) : [];
        return new CliError({
          class: "usage",
          reason: "invalid_arguments",
          message: `Can't ${attempt.action}. Secani rejected ${issues.length > 1 ? `${issues.length} inputs` : "the input"}.`,
          detail:
            issues.length > 0
              ? issues.slice(0, 5).map((issue) => `${issue.path ? `${cleanRemote(issue.path)}: ` : ""}${cleanRemote(issue.message ?? "")}`)
              : detail,
          ...base,
        });
      }
      return new CliError({
        class: "platform",
        reason: "api_error",
        message: `Failed to ${attempt.action}. Secani returned an error.`,
        detail: [...detail, `Error Code      ${cleanRemote(failure.code)}`],
        ...base,
      });
  }
}

function unknownOutcome(error: CliError, attempt: Attempt, requestId: string, replayArgv: string[]): CliError {
  return new CliError({
    ...error.init,
    message: `Can't confirm whether Secani finished: ${attempt.action}. The connection failed after the request was sent.`,
    ids: [["Request ID", requestId]],
    data: { requestId, remote: "unknown" },
    recovery: [
      {
        instruction: "Run it again with the same request ID; Secani applies it at most once",
        command: { argv: withOptions(replayArgv, "--request-id", requestId) },
      },
    ],
  });
}
