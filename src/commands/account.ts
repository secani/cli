import { discover, hostOf, pollDeviceToken, registerClient, requestDeviceCode } from "../auth";
import { DEFAULT_SERVER_URL, readLogin, readSavedWorkspace, saveLogin, saveWorkspace } from "../config";
import { CliError } from "../runtime/errors";
import { count, words } from "../runtime/format";
import { outcomeLine, rows, table } from "../runtime/layout";
import { nextJson } from "../runtime/output";
import type { CommandContext, CommandSpec, GroupSpec } from "../runtime/spec";
import { cleanRemote } from "../runtime/style";
import { WORKSPACE_PATTERN, type Whoami } from "../session";

function canOpenBrowser(context: CommandContext): boolean {
  const { io, mode, options } = context;
  if (options.open === false || !mode.interactive || mode.ci) return false;
  if (io.env.SSH_CONNECTION || io.env.SSH_TTY || io.env.SSH_CLIENT) return false;
  if (io.platform === "linux") return Boolean(io.env.DISPLAY || io.env.WAYLAND_DISPLAY);
  return io.platform === "darwin" || io.platform === "win32";
}

function workspaceRefs(whoami: Whoami): string[] {
  return whoami.organizations.flatMap((org) => org.workspaces.map((ws) => `${org.slug}/${ws.slug}`));
}

const login: CommandSpec = {
  kind: "command",
  name: "login",
  summary: "Log in to Secani",
  consequence: "ordinary",
  options: [
    {
      name: "open",
      type: "boolean",
      negatable: true,
      description: "Open the login page in your browser (default: on a desktop); --no-open only prints it",
    },
  ],
  examples: [
    { title: "Log in", command: "secani login" },
    { title: "Log in over SSH and open the page on another device", command: "secani login --no-open" },
  ],
  notes: [
    "Prints a login page and a code, then waits until you confirm the code in the browser; the code expires after about 5 minutes. The login is stored owner-only in the CLI config directory (SECANI_CONFIG_DIR, or ~/.config/secani). Scripts and CI pass an access token in SECANI_TOKEN instead.",
  ],
  resultSchema: { outcome: "logged_in" },
  async run(context) {
    const { session, out, io, mode } = context;
    if (!mode.interactive) {
      throw new CliError({
        class: "missing_input",
        reason: "requires_terminal",
        message: "Can't log in in non-interactive mode. Logging in needs a person to confirm a code in the browser.",
        userActionRequired: true,
        recovery: [{ instruction: "Run secani login in a terminal, or set SECANI_TOKEN to an access token for this run." }],
      });
    }
    const server = session.server;
    const auth = await discover(io, server);
    const existing = await readLogin(session.store, server);
    let clientId = existing?.issuer === auth.issuer ? existing.clientId : undefined;
    let code;
    try {
      clientId ??= await registerClient(io, auth, session.version);
      code = await requestDeviceCode(io, auth, clientId, server);
    } catch (error) {
      if (!existing || clientId !== existing.clientId) throw error;
      // The stored client may have been removed; register a new one once.
      clientId = await registerClient(io, auth, session.version);
      code = await requestDeviceCode(io, auth, clientId, server);
    }
    const page = code.verificationUriComplete ?? code.verificationUri;
    out.note(rows(out.err, [["Login Page", page], ["Code", code.userCode]]));
    if (canOpenBrowser(context) && (await io.openUrl(page))) {
      out.gap();
      out.note("  Confirm the code in the browser window that opened.");
    } else {
      out.gap();
      out.note("  Open the login page on any device and confirm the code.");
    }
    out.note("  Waiting for confirmation…");
    const stored = await pollDeviceToken(io, auth, clientId, code, server);
    await session.store.withLock("auth.json", io, () => saveLogin(session.store, server, stored));
    const whoami = await session.whoami({ includeScopes: false });
    const refs = workspaceRefs(whoami);
    out.gap();
    out.note(
      [
        outcomeLine(out.err, "Logged in", ""),
        rows(out.err, [
          ...(server !== DEFAULT_SERVER_URL ? [["Server", hostOf(server)] as [string, string]] : []),
          ["Workspaces", refs.length === 1 ? refs[0]! : String(refs.length)],
          ["Writes", whoami.connector?.readOnlyMode === false ? "Allowed" : "Off until allowed in Settings > Integrations"],
        ]),
      ].join("\n"),
    );
    const saved = await readSavedWorkspace(session.store, server);
    if (refs.length > 1 && !saved) out.next("Choose the workspace to work in", ["secani", "workspaces", "switch", "<ORG/WORKSPACE>"]);
    else out.next("List your open tasks", ["secani", "tasks", "list", "--assignee", "me", "--open"]);
  },
};

const logout: CommandSpec = {
  kind: "command",
  name: "logout",
  summary: "Log out of Secani on this computer",
  consequence: "ordinary",
  notes: [
    "Deletes the stored login. Secani's sign-in service can't revoke it remotely; the Secani CLI connection stays listed in Settings > Integrations until you remove it there.",
  ],
  resultSchema: { outcome: "logged_out | unchanged" },
  async run(context) {
    const { session, out, io } = context;
    const server = session.server;
    const existing = await readLogin(session.store, server);
    if (io.env.SECANI_TOKEN) out.warn("token_in_environment", "SECANI_TOKEN is set, so commands keep using that token. Unset it to log out completely.");
    if (!existing) {
      if (out.json) out.document({ outcome: "unchanged" });
      else out.note("  You're not logged in on this computer. Nothing was changed.");
      return;
    }
    await session.store.withLock("auth.json", io, () => saveLogin(session.store, server, undefined));
    if (out.json) {
      out.document({ outcome: "logged_out", server: { revoked: false } });
      return;
    }
    out.note(
      [
        outcomeLine(out.err, "Logged out", ""),
        rows(out.err, [
          ["This Computer", "Login deleted"],
          ["Secani", "Not revoked; remove Secani CLI in Settings > Integrations to end it there"],
        ]),
      ].join("\n"),
    );
  },
};

const whoami: CommandSpec = {
  kind: "command",
  name: "whoami",
  summary: "Show who you're logged in as and where commands act",
  consequence: "read",
  resultSchema: { user: "object", connector: "object", organizations: "array", workspace: "string | null" },
  async run(context) {
    const { session, out } = context;
    const result = await session.whoami({ includeScopes: false });
    let current: string | null = null;
    let source = "";
    try {
      const workspace = await session.workspace();
      current = workspace.ref;
      source = { option: "--workspace", environment: "SECANI_WORKSPACE", saved: "current", only: "your only workspace" }[workspace.source];
    } catch (error) {
      if (!(error instanceof CliError) || error.init.reason !== "missing_workspace") throw error;
    }
    if (out.json) {
      out.document({ user: result.user ?? null, connector: result.connector ?? null, organizations: result.organizations, workspace: current });
      return;
    }
    out.answer(
      rows(out.out, [
        ["User ID", String(result.user?.workosUserId ?? "")],
        ["Writes", result.connector?.readOnlyMode === false ? "Allowed" : "Off"],
        ["Workspace", current ? `${current} (${source})` : "None chosen"],
        ["Workspaces", String(workspaceRefs(result).length)],
      ]),
    );
    if (result.connector?.readOnlyMode !== false) {
      out.next("Allow writes for Secani CLI in the Secani app under Settings > Integrations", undefined);
    }
  },
};

const workspacesList: CommandSpec = {
  kind: "command",
  name: "list",
  aliases: ["ls"],
  summary: "List the workspaces you can work in",
  consequence: "read",
  resultSchema: { workspaces: "array" },
  async run(context) {
    const { session, out, mode } = context;
    const result = await session.whoami({ includeScopes: false });
    const saved = mode.agent ? undefined : await readSavedWorkspace(session.store, session.server);
    const items = result.organizations.flatMap((org) =>
      org.workspaces.map((ws) => ({
        workspace: `${org.slug}/${ws.slug}`,
        organization: { slug: org.slug, name: org.name },
        slug: ws.slug,
        name: ws.name,
        accessLevel: org.accessLevel ?? null,
        canWrite: org.canWrite === true,
        current: `${org.slug}/${ws.slug}` === saved,
      })),
    );
    if (out.json) {
      out.document({ workspaces: items });
      return;
    }
    if (items.length === 0) {
      if (!out.out.rich) out.answer("Workspace\tOrganization\tName\tAccess\tCurrent");
      out.note("  You aren't a member of any Secani workspace yet.");
      return;
    }
    out.answer(
      table(
        out.out,
        [
          { header: "Workspace", human: (item) => item.workspace },
          { header: "Organization", human: (item) => item.organization.name, flex: true },
          { header: "Name", human: (item) => item.name, flex: true },
          { header: "Access", human: (item) => words(item.accessLevel), raw: (item) => item.accessLevel ?? "" },
          { header: "Current", human: (item) => (item.current ? "Yes" : ""), raw: (item) => (item.current ? "true" : "false") },
        ],
        items,
      ),
    );
    if (!saved && items.length > 1) out.next("Choose the workspace to work in", ["secani", "workspaces", "switch", items[0]!.workspace]);
  },
};

const workspacesSwitch: CommandSpec = {
  kind: "command",
  name: "switch",
  summary: "Choose the workspace commands act in",
  consequence: "ordinary",
  args: [{ name: "ORG/WORKSPACE", description: "Organization and workspace slugs, such as acme/isms", required: true }],
  examples: [{ title: "Work in one workspace from now on", command: "secani workspaces switch acme/isms" }],
  notes: [
    "Agents and scripts don't use the current workspace: they pass --workspace or SECANI_WORKSPACE on each run.",
  ],
  resultSchema: { workspace: "string", outcome: "switched | unchanged" },
  async run(context) {
    const { session, out, mode, io } = context;
    const ref = context.args["ORG/WORKSPACE"]!;
    if (mode.agent) {
      throw new CliError({
        class: "usage",
        reason: "agent_cannot_switch",
        message: "Can't switch the current workspace from an agent. Agents pass the workspace on each command.",
        recovery: [{ instruction: "Pass it with --workspace", command: { argv: ["secani", "risks", "list", "--workspace", ref] } }],
      });
    }
    if (!WORKSPACE_PATTERN.test(ref)) {
      throw new CliError({
        class: "usage",
        reason: "invalid_arguments",
        message: `Workspaces are written <ORG/WORKSPACE> in lowercase, such as acme/isms, not ${JSON.stringify(cleanRemote(ref))}.`,
        recovery: [{ instruction: "List your workspaces", command: { argv: ["secani", "workspaces", "list"] } }],
      });
    }
    const result = await session.whoami({ includeScopes: false });
    const refs = workspaceRefs(result);
    if (!refs.includes(ref)) {
      throw new CliError({
        class: "not_found",
        reason: "workspace_not_found",
        message: `Couldn't find workspace ${ref} among your ${count(refs.length, "workspace")}.`,
        recovery: [{ instruction: "List your workspaces", command: { argv: ["secani", "workspaces", "list"] } }],
      });
    }
    const saved = await readSavedWorkspace(session.store, session.server);
    const unchanged = saved === ref;
    if (!unchanged) await session.store.withLock("config.json", io, () => saveWorkspace(session.store, session.server, ref));
    if (out.json) {
      out.document({ workspace: ref, outcome: unchanged ? "unchanged" : "switched", next: [nextJson({ argv: ["secani", "whoami"] })] });
      return;
    }
    if (unchanged) out.note(`  ${ref} is already the current workspace. Nothing was changed.`);
    else out.note(outcomeLine(out.err, "Switched to", ref));
    if (!mode.interactive || !io.stdout.isTTY) out.answer(ref);
  },
};

export const accountCommands = { login, logout, whoami };

export const workspaces: GroupSpec = {
  kind: "group",
  name: "workspaces",
  aliases: ["workspace"],
  summary: "List workspaces and choose the current one",
  children: [workspacesList, workspacesSwitch],
};
