import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorld, ISSUER, loggedIn, run, SERVER, tool, whoamiTool, type World } from "./harness";

let world: World;
beforeEach(() => {
  world = createWorld();
});
afterEach(() => world.cleanup());

describe("login", () => {
  it("runs the device flow, stores the login owner-only and reports the result", async () => {
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    const result = await run(world, ["login"], { tty: true, env: { DISPLAY: ":0" } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`Login Page      ${ISSUER}/device?user_code=WDJB-MJHT`);
    expect(result.stderr).toContain("Code            WDJB-MJHT");
    expect(result.stderr).toContain("✓ Logged in");
    expect(result.stderr).toContain("Workspaces      2");
    expect(result.stderr).toContain("secani workspaces switch <ORG/WORKSPACE>");
    expect(result.stdout).toBe("");
    expect(world.opened).toEqual([`${ISSUER}/device?user_code=WDJB-MJHT`]);
    const file = join(world.configDir, "auth.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.servers[SERVER]).toMatchObject({ clientId: "client_cli", accessToken: "access-1", refreshToken: "refresh-1" });
    // The device grant asked for the MCP server as the token's resource.
    expect(world.tokenRequests[0]).toMatchObject({ resource: SERVER, client_id: "client_cli" });
  });

  it("prints the page without opening a browser over SSH or with --no-open", async () => {
    whoamiTool(world);
    await run(world, ["login"], { tty: true, env: { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" } });
    world.pendingPolls = 0;
    await run(world, ["login", "--no-open"], { tty: true, env: { DISPLAY: ":0" } });
    expect(world.opened).toEqual([]);
  });

  it("refuses to wait for a browser in non-interactive mode", async () => {
    const result = await run(world, ["login", "--json"], { tty: true });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: "action_required", reason: "requires_terminal", userActionRequired: true });
    expect(world.tokenRequests).toHaveLength(0);
  });
});

describe("credentials", () => {
  it("fails with login_required and never opens a browser when nobody is logged in", async () => {
    const result = await run(world, ["risks", "list", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "action_required",
      reason: "login_required",
      next: [{ command: "secani login", argv: ["secani", "login"] }],
    });
  });

  it("refreshes an expiring token before the request", async () => {
    whoamiTool(world);
    await loggedIn(world, 30_000);
    const result = await run(world, ["whoami", "--json"]);
    expect(result.code).toBe(0);
    expect(world.tokenRequests).toEqual([expect.objectContaining({ grant_type: "refresh_token", refresh_token: "refresh-1" })]);
    const stored = JSON.parse(readFileSync(join(world.configDir, "auth.json"), "utf8"));
    expect(stored.servers[SERVER].accessToken).toBe("access-refreshed-1");
    expect(stored.servers[SERVER].refreshToken).toBe("refresh-1");
  });

  it("refreshes once after a 401 and resends", async () => {
    whoamiTool(world);
    await loggedIn(world);
    world.validTokens.delete("access-1");
    const result = await run(world, ["whoami", "--json"]);
    expect(result.code).toBe(0);
    expect(world.tokenRequests).toHaveLength(1);
  });

  it("says the login expired when the refresh token is rejected", async () => {
    whoamiTool(world);
    await loggedIn(world, -1);
    const { Store, saveLogin, readLogin } = await import("../src/config");
    const store = new Store(world.configDir);
    const login = (await readLogin(store, SERVER))!;
    await saveLogin(store, SERVER, { ...login, refreshToken: "revoked" });
    const result = await run(world, ["whoami"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error: Your login expired.");
    expect(result.stderr).toContain("    secani login");
  });

  it("removes only a lock it still owns", async () => {
    const { writeFileSync, existsSync, readFileSync: read } = await import("node:fs");
    const { Store } = await import("../src/config");
    const store = new Store(world.configDir);
    const lock = join(world.configDir, "auth.json.lock");
    const io = { now: () => Date.now(), sleep: async () => undefined, signal: new AbortController().signal } as never;
    await store.withLock("auth.json", io, async () => {
      // Another process took the lock over while this one worked.
      writeFileSync(lock, "someone-else");
    });
    expect(existsSync(lock)).toBe(true);
    expect(read(lock, "utf8")).toBe("someone-else");
    writeFileSync(lock, "", { flag: "w" });
    const { utimesSync } = await import("node:fs");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await store.withLock("auth.json", io, async () => undefined);
    expect(existsSync(lock)).toBe(false);
  });

  it("uses SECANI_TOKEN without a stored login", async () => {
    whoamiTool(world);
    const result = await run(world, ["whoami", "--json"], { env: { SECANI_TOKEN: "env-token" } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).user).toEqual({ workosUserId: "user_1" });
  });

  it("reports a broken auth file with its path instead of resetting it", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(world.configDir, "auth.json"), "{ nope");
    const result = await run(world, ["whoami"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${join(world.configDir, "auth.json")} isn't valid JSON.`);
    expect(readFileSync(join(world.configDir, "auth.json"), "utf8")).toBe("{ nope");
  });

  it("logs out locally and says the server connection stays", async () => {
    await loggedIn(world);
    const result = await run(world, ["logout"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Logged out");
    expect(result.stderr).toContain("Settings > Integrations");
    const again = await run(world, ["logout", "--json"]);
    expect(JSON.parse(again.stdout)).toEqual({ outcome: "unchanged" });
  });
});

describe("workspaces", () => {
  it("uses the only workspace without asking", async () => {
    whoamiTool(world, ["acme/isms"]);
    tool(world, { name: "list_tasks", handler: () => ({ result: { items: [], completeness: "complete" } }) });
    await loggedIn(world);
    const result = await run(world, ["tasks", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(world.calls.at(-1)).toMatchObject({ tool: "list_tasks", args: { organizationSlug: "acme", workspaceSlug: "isms" } });
  });

  it("fails with missing_workspace and lists the choices when there are several", async () => {
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    await loggedIn(world);
    const result = await run(world, ["tasks", "list", "--json"]);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({ status: "action_required", reason: "missing_workspace" });
    expect(error.data.workspaces).toEqual([{ workspace: "acme/isms" }, { workspace: "acme/privacy" }]);
  });

  it("saves the current workspace with switch and reports a repeat as unchanged", async () => {
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    tool(world, { name: "list_tasks", handler: () => ({ result: { items: [] } }) });
    await loggedIn(world);
    const first = await run(world, ["workspaces", "switch", "acme/privacy"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("acme/privacy\n");
    const again = await run(world, ["workspaces", "switch", "acme/privacy", "--json"]);
    expect(JSON.parse(again.stdout)).toMatchObject({ workspace: "acme/privacy", outcome: "unchanged" });
    const list = await run(world, ["tasks", "list"], { tty: true });
    expect(list.stderr).toContain("Workspace       acme/privacy");
    expect(list.stderr).toContain("No tasks in acme/privacy.");
  });

  it("lists workspaces in one aligned table at 80 columns, with the next step after a blank line", async () => {
    whoamiTool(world, ["prosec-group/prosec-networks", "bsi-muster-test/it-grundschutz-kundendienst"]);
    await loggedIn(world);
    const result = await run(world, ["workspaces", "list"], { tty: true, columns: 80 });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ {2}Workspace +Name +Access$/);
    expect(lines).toHaveLength(3);
    expect(result.stderr).toMatch(/^\n {2}Choose the workspace to work in:/);
    const piped = await run(world, ["workspaces", "list"]);
    expect(piped.stdout.split("\n")[0]).toBe("Workspace\tOrganization\tName\tAccess\tCurrent");
  });

  it("refuses a workspace the account can't see", async () => {
    whoamiTool(world, ["acme/isms"]);
    await loggedIn(world);
    const result = await run(world, ["workspaces", "switch", "acme/other"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Couldn't find workspace acme/other among your 1 workspace.");
  });

  it("never uses the saved workspace for an agent, and agents can't switch", async () => {
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    await loggedIn(world);
    await run(world, ["workspaces", "switch", "acme/isms"]);
    const listed = await run(world, ["tasks", "list"], { env: { CLAUDECODE: "1" } });
    expect(listed.code).toBe(2);
    expect(listed.stderr).toContain("secani tasks list --workspace <ORG/WORKSPACE>");
    const switched = await run(world, ["workspaces", "switch", "acme/privacy"], { env: { CLAUDECODE: "1" } });
    expect(switched.code).toBe(2);
    expect(switched.stderr).toContain("Can't switch the current workspace from an agent.");
  });

  it("fails when --workspace and SECANI_WORKSPACE disagree, and on a malformed value", async () => {
    await loggedIn(world);
    const conflict = await run(world, ["tasks", "list", "--workspace", "acme/isms"], { env: { SECANI_WORKSPACE: "acme/privacy" } });
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("They name different workspaces.");
    const malformed = await run(world, ["tasks", "list", "--workspace", "Acme"]);
    expect(malformed.code).toBe(2);
    expect(world.calls).toHaveLength(0);
  });
});
