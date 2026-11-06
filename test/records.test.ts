import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dueAt } from "../src/commands/tasks";
import { createWorld, loggedIn, NOW, run, tool, whoamiTool, type World } from "./harness";

let world: World;
beforeEach(async () => {
  world = createWorld();
  whoamiTool(world, ["acme/isms"]);
  await loggedIn(world);
});
afterEach(() => world.cleanup());

const risk = (n: number, extra: Record<string, unknown> = {}) => ({
  riskId: `r${n}`,
  currentRevisionId: `rev${n}`,
  displayKey: `RI-${n}`,
  title: `Risk ${n}`,
  category: "security",
  residualLevel: "high",
  strategy: "mitigate",
  status: "identified",
  updatedAt: NOW - n * 3_600_000,
  ...extra,
});

/** A list_risks server with 5 risks per page. */
function riskPages(total: number) {
  tool(world, {
    name: "list_risks",
    handler: (args) => {
      const start = args.cursor ? Number(args.cursor) : 0;
      const items = Array.from({ length: Math.min(5, total - start) }, (_, i) => risk(start + i + 1));
      const next = start + 5 < total ? String(start + 5) : undefined;
      return { result: { items, completeness: "complete", truncated: false, ...(next ? { cursor: next } : {}) } };
    },
  });
}

describe("lists", () => {
  it("prints an aligned table on a TTY and tab-separated rows when piped", async () => {
    riskPages(2);
    const rich = await run(world, ["risks", "list"], { tty: true });
    expect(rich.code).toBe(0);
    expect(rich.stdout.split("\n")[0]).toBe("  ID     Title    Category   Residual   Strategy   Status       Updated");
    expect(rich.stdout).toContain("RI-1   Risk 1   Security   High       Mitigate   Identified   1h");
    const piped = await run(world, ["risks", "list"]);
    expect(piped.stdout.split("\n")[0]).toBe("ID\tTitle\tCategory\tResidual\tStrategy\tStatus\tUpdated");
    expect(piped.stdout.split("\n")[1]).toBe(`RI-1\tRisk 1\tsecurity\thigh\tmitigate\tidentified\t${new Date(NOW - 3_600_000).toISOString()}`);
  });

  it("treats --limit as a total across pages, never over-fetches, and resumes with --next", async () => {
    riskPages(12);
    const first = await run(world, ["risks", "list", "--limit", "7", "--json"]);
    const doc = JSON.parse(first.stdout);
    expect(doc.risks.map((r: { displayKey: string }) => r.displayKey)).toEqual(["RI-1", "RI-2", "RI-3", "RI-4", "RI-5", "RI-6", "RI-7"]);
    expect(world.calls.filter((call) => call.tool === "list_risks")).toHaveLength(2);
    const second = await run(world, ["risks", "list", "--limit", "7", "--next", doc.pagination.next, "--json"]);
    const rest = JSON.parse(second.stdout);
    expect(rest.risks.map((r: { displayKey: string }) => r.displayKey)).toEqual(["RI-8", "RI-9", "RI-10", "RI-11", "RI-12"]);
    expect(rest.pagination.next).toBeNull();
  });

  it("keeps filters fixed across pages and refuses to change them with --next", async () => {
    riskPages(12);
    const first = JSON.parse((await run(world, ["risks", "list", "--status", "identified", "--limit", "5", "--json"])).stdout);
    world.calls.length = 0;
    await run(world, ["risks", "list", "--next", first.pagination.next, "--json"]);
    expect(world.calls.find((call) => call.tool === "list_risks")!.args).toMatchObject({ status: "identified", cursor: "5" });
    const changed = await run(world, ["risks", "list", "--status", "closed", "--next", first.pagination.next]);
    expect(changed.code).toBe(2);
    expect(changed.stderr).toContain("Can't change filters with --next.");
  });

  it("prints the next page command on stderr", async () => {
    riskPages(30);
    const result = await run(world, ["risks", "list"], { tty: true });
    expect(result.stderr).toMatch(/Next page:\n {4}secani risks list --next \S+/);
    expect(result.stdout).not.toContain("--next");
  });

  it("clamps --limit above the cap with a warning", async () => {
    riskPages(3);
    const result = await run(world, ["risks", "list", "--limit", "500", "--json"]);
    expect(JSON.parse(result.stdout).warnings).toEqual([{ reason: "limit_clamped", message: expect.stringContaining("capped at 200") }]);
  });

  it("separates first use from a filter that matches nothing, and exits 0", async () => {
    riskPages(0);
    const empty = await run(world, ["risks", "list"], { tty: true });
    expect(empty.code).toBe(0);
    expect(empty.stderr).toContain("No risks in acme/isms.");
    expect(empty.stderr).toContain("Add one:");
    const filtered = await run(world, ["risks", "list", "--status", "closed"], { tty: true });
    expect(filtered.stderr).toContain("No risks match this filter. Remove --status to see all risks.");
    const piped = await run(world, ["risks", "list"]);
    expect(piped.stdout).toBe("ID\tTitle\tCategory\tResidual\tStrategy\tStatus\tUpdated\n");
    expect(JSON.parse((await run(world, ["risks", "list", "--json"])).stdout)).toEqual({ risks: [], pagination: { next: null } });
  });

  it("strips terminal escapes and format characters from remote text", async () => {
    tool(world, {
      name: "list_risks",
      handler: () => ({ result: { items: [risk(1, { title: "Evil\u001b[2J‮title\nline" })] } }),
    });
    const result = await run(world, ["risks", "list"], { tty: true });
    expect(result.stdout).toContain("Eviltitle\\nline");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("‮");
  });

  it("switches to compact records when the columns don't fit", async () => {
    riskPages(1);
    const result = await run(world, ["risks", "list"], { tty: true, columns: 40 });
    expect(result.stdout).toContain("  ID              RI-1");
    expect(result.stdout).toContain("  Status          Identified");
  });
});

describe("inspect", () => {
  it("shows label/value rows on stdout and the record as JSON", async () => {
    tool(world, {
      name: "get_risk",
      handler: (args) =>
        args.riskId === "RI-12"
          ? { result: { risk: risk(12, { inherentLevel: "critical", inherentScore: 20, residualScore: 12, description: "Long text." }), objectLink: { href: "https://app.secani.com/acme/isms/risks/r12", label: "RI-12" } } }
          : { error: { code: "NOT_FOUND", message: "Risiko nicht gefunden" } },
    });
    const result = await run(world, ["risks", "inspect", "RI-12"], { tty: true });
    expect(result.stdout).toContain("  Inherent        Critical (20)");
    expect(result.stdout).toContain("  Open            https://app.secani.com/acme/isms/risks/r12");
    expect(result.stdout).toContain("\n\n  Long text.");
    const json = JSON.parse((await run(world, ["risks", "inspect", "RI-12", "--json"])).stdout);
    expect(json.risk.displayKey).toBe("RI-12");
    const missing = await run(world, ["risks", "inspect", "RI-99"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Couldn't find risk RI-99 in acme/isms.");
    expect(missing.stderr).toContain("Secani: Risiko nicht gefunden");
    expect(missing.stderr).toContain("    secani risks list");
  });
});

describe("writes", () => {
  function saveRisk() {
    tool(world, {
      name: "save_risk",
      readOnly: false,
      handler: (args) => ({
        result: { riskId: args.id ? "r12" : "r40", riskRevisionId: "rev", replayed: false, applied: args.id ? Object.keys(args).filter((key) => key === "status") : ["create"], objectLink: { href: "https://app.secani.com/x", label: "RI-40" } },
      }),
    });
    tool(world, { name: "get_risk", handler: (args) => ({ result: { risk: risk(Number(String(args.riskId).replace(/\D/g, "")) || 40) } }) });
  }

  it("validates every input before any request and reports all problems at once", async () => {
    saveRisk();
    const result = await run(world, ["risks", "create", "--title", "x", "--treatment-due", "soon"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Can't create the risk. 7 inputs are missing or invalid.");
    expect(result.stderr).toContain("--treatment-due takes a date as YYYY-MM-DD");
    expect(result.stderr).toContain("Missing --category.");
    expect(world.calls).toHaveLength(0);
  });

  it("creates a risk in the only framework with a request ID and prints a receipt", async () => {
    saveRisk();
    const result = await run(world, ["risks", "create", "--hazard", "secani:G0.1", "--strategy", "mitigate"], { tty: true });
    expect(result.code).toBe(0);
    const call = world.calls.find((each) => each.tool === "save_risk")!;
    expect(call.args).toMatchObject({ governanceScopeId: "scope_iso", hazardRefCode: "secani:G0.1", strategy: "mitigate", organizationSlug: "acme" });
    expect(call.args.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stderr).toContain("Framework       ISO 27001");
    expect(result.stderr).toContain("✓ Created         RI-40");
    expect(result.stderr).toContain("  Open            https://app.secani.com/x");
    expect(result.stdout).toBe("");
  });

  it("prints only the identifier on stdout when piped, and a JSON outcome", async () => {
    saveRisk();
    const piped = await run(world, ["risks", "update", "RI-12", "--status", "analyzed"]);
    expect(piped.stdout).toBe("RI-12\n");
    const json = JSON.parse((await run(world, ["risks", "update", "RI-12", "--status", "analyzed", "--json"])).stdout);
    expect(json).toMatchObject({ outcome: "updated", next: [{ command: "secani risks inspect RI-12" }] });
    const unchanged = JSON.parse((await run(world, ["risks", "update", "RI-12", "--owner", "Jane", "--json"])).stdout);
    expect(unchanged.outcome).toBe("unchanged");
  });

  it("asks which framework when there are several, and names the input in non-interactive mode", async () => {
    world.tools.delete("whoami");
    whoamiTool(world, ["acme/isms"], [
      { governanceScopeId: "s1", name: "ISO 27001" },
      { governanceScopeId: "s2", name: "NIS2" },
    ]);
    saveRisk();
    const result = await run(world, ["risks", "update", "RI-12", "--status", "analyzed", "--json"]);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({ reason: "missing_framework", data: { frameworks: [{ id: "s1", name: "ISO 27001" }, { id: "s2", name: "NIS2" }] } });
    expect(error.next[0].argv).toEqual(["secani", "risks", "update", "--framework", "<FRAMEWORK>"]);
    const named = await run(world, ["risks", "update", "RI-12", "--status", "analyzed", "--framework", "nis2"]);
    expect(named.code).toBe(0);
    expect(world.calls.at(-1)!.args.governanceScopeId).toBe("s2");
    const unknown = await run(world, ["risks", "list", "--framework", "SOC 2", "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stderr)).toMatchObject({ reason: "not_found", data: { frameworks: [{ id: "s1", name: "ISO 27001" }, { id: "s2", name: "NIS2" }] } });
    expect(world.calls.map((call) => call.tool)).not.toContain("list_risks");
  });

  it("says how to allow writes when the connection is read-only", async () => {
    tool(world, {
      name: "save_task",
      readOnly: false,
      handler: () => ({ error: { code: "READ_ONLY_CONNECTOR", message: "This connector is read-only." } }),
    });
    const result = await run(world, ["tasks", "update", "TASK-1", "--status", "done", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ status: "action_required", reason: "writes_disabled", userActionRequired: true });
  });

  it("sends --no-due and --no-assignee as cleared values and dates at 5 pm local time", async () => {
    tool(world, { name: "save_task", readOnly: false, handler: () => ({ result: { workItemId: "w1", applied: ["fields"], workflowState: "planned" } }) });
    await run(world, ["tasks", "update", "TASK-1", "--no-due", "--no-assignee"]);
    expect(world.calls.at(-1)!.args).toMatchObject({ dueAt: null, assigneeEmail: null });
    expect(dueAt("2026-12-15")).toMatch(/^2026-12-15T17:00:00[+-]\d{2}:\d{2}$/);
    expect(dueAt("2026-12-15T09:00:00Z")).toBe("2026-12-15T09:00:00Z");
    expect(dueAt("tomorrow")).toBeUndefined();
  });
});

describe("tasks archive and restore", () => {
  it("restores an archived task by the ID get_task resolves", async () => {
    tool(world, { name: "get_task", handler: () => ({ result: { task: { workItemId: "wi_archived", displayKey: "TASK-12", title: "Old", lifecycleStatus: "retired" } } }) });
    tool(world, { name: "save_task", readOnly: false, handler: () => ({ result: { workItemId: "wi_archived", applied: ["restore"], workflowState: "planned" } }) });
    const result = await run(world, ["tasks", "restore", "TASK-12", "--json"]);
    expect(result.code).toBe(0);
    expect(world.calls.find((call) => call.tool === "save_task")!.args).toMatchObject({ id: "wi_archived", archived: false });
    expect(JSON.parse(result.stdout).outcome).toBe("restored");
  });
});

describe("search", () => {
  function searchTool() {
    tool(world, {
      name: "search",
      handler: (args) => ({
        result: {
          results: [{ entityType: "requirement", id: "req1", title: "A.8.13 Information backup", rank: 1 }],
          sections: [
            { entityType: "workspace_object", state: "ok", count: 0 },
            String(args.query).length < 2
              ? { entityType: "requirement", state: "skipped", count: 0, errorCode: "QUERY_TOO_SHORT" }
              : { entityType: "requirement", state: args.governanceScopeId ? "ok" : "skipped", count: 1, ...(args.governanceScopeId ? {} : { errorCode: "SCOPE_REQUIRED" }) },
          ],
        },
      }),
    });
  }

  it("searches requirements in the workspace's only framework", async () => {
    searchTool();
    const result = await run(world, ["search", "backup", "--json"]);
    expect(world.calls.find((call) => call.tool === "search")!.args.governanceScopeId).toBe("scope_iso");
    expect(JSON.parse(result.stdout).warnings).toBeUndefined();
    const short = await run(world, ["search", "a", "--json"]);
    expect(JSON.parse(short.stdout).warnings).toEqual([{ reason: "query_too_short", message: "Skipped requirement results: their search needs at least 2 characters." }]);
  });

  it("asks for a framework when requirements are requested and several exist, and warns when they're skipped", async () => {
    world.tools.delete("whoami");
    whoamiTool(world, ["acme/isms"], [
      { governanceScopeId: "s1", name: "ISO 27001" },
      { governanceScopeId: "s2", name: "NIS2" },
    ]);
    searchTool();
    const explicit = await run(world, ["search", "backup", "--kind", "requirement", "--json"]);
    expect(explicit.code).toBe(2);
    expect(JSON.parse(explicit.stderr).reason).toBe("missing_framework");
    const broad = await run(world, ["search", "backup", "--json"]);
    expect(broad.code).toBe(0);
    expect(JSON.parse(broad.stdout).warnings).toEqual([{ reason: "framework_required", message: expect.stringContaining("Pass --framework") }]);
    await run(world, ["search", "backup", "--framework", "ISO 27001", "--json"]);
    expect(world.calls.at(-1)!.args.governanceScopeId).toBe("s1");
  });
});

describe("consent", () => {
  function deletable() {
    tool(world, { name: "get_risk", handler: () => ({ result: { risk: risk(12) } }) });
    tool(world, { name: "delete_risk", readOnly: false, handler: () => ({ result: { riskId: "r12", lifecycleStatus: "retired", applied: ["delete"] } }) });
  }

  it("needs --yes in non-interactive mode and changes nothing without it", async () => {
    deletable();
    const result = await run(world, ["risks", "delete", "RI-12", "--json"]);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({ status: "action_required", reason: "confirmation_required", userActionRequired: true });
    expect(error.data.effects[0]).toContain("Removes RI-12 from the active risk register");
    expect(error.next[0]).toMatchObject({ argv: ["secani", "risks", "delete", "RI-12", "--json", "--yes"], when: expect.stringMatching(/^Only after a human approves: /) });
    expect(world.calls.map((call) => call.tool)).not.toContain("delete_risk");
  });

  it("previews and asks (y/N) on a terminal; anything but yes cancels with exit 130", async () => {
    deletable();
    const declined = await run(world, ["risks", "delete", "RI-12"], { tty: true, answers: [""] });
    expect(declined.code).toBe(130);
    expect(declined.prompts).toEqual(["? Delete risk RI-12? (y/N) "]);
    expect(declined.stderr).toContain("Risk            RI-12  Risk 1");
    expect(declined.stderr).toContain("Canceled. Nothing was changed.");
    expect(world.calls.map((call) => call.tool)).not.toContain("delete_risk");
    const accepted = await run(world, ["risks", "delete", "RI-12"], { tty: true, answers: ["y"] });
    expect(accepted.code).toBe(0);
    expect(accepted.stderr).toContain("✓ Deleted         RI-12");
  });

  it("puts --yes before a -- in the continuation", async () => {
    tool(world, { name: "get_task", handler: () => ({ result: { task: { workItemId: "wi12", displayKey: "TASK-12", title: "T" } } }) });
    const result = await run(world, ["tasks", "archive", "--json", "--", "TASK-12"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).next[0].argv).toEqual(["secani", "tasks", "archive", "--json", "--yes", "--", "TASK-12"]);
    const { replayArgv } = await import("../src/main");
    expect(replayArgv(["search", "--yes", "--", "--yes"])).toEqual(["secani", "search", "--", "--yes"]);
  });

  it("runs with --yes without prompting", async () => {
    deletable();
    const result = await run(world, ["risks", "delete", "RI-12", "--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "deleted", next: [{ command: "secani risks list" }] });
  });

  it("never confirms ordinary writes", async () => {
    tool(world, { name: "save_task", readOnly: false, handler: () => ({ result: { workItemId: "w1", applied: ["fields"], workflowState: "done" } }) });
    const result = await run(world, ["tasks", "update", "TASK-1", "--status", "done"], { tty: true });
    expect(result.prompts).toEqual([]);
    expect(result.code).toBe(0);
  });
});

describe("network and retries", () => {
  it("retries a read after a server error", async () => {
    tool(world, { name: "list_tasks", handler: (_args, call) => (call === 1 ? { http: 502 } : { result: { items: [] } }) });
    const result = await run(world, ["tasks", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(world.calls.filter((call) => call.tool === "list_tasks")).toHaveLength(2);
  });

  it("resends a write with the same request ID and reports an unknown outcome when it never answers", async () => {
    tool(world, { name: "save_task", readOnly: false, handler: () => ({ network: true }) });
    const result = await run(world, ["tasks", "update", "TASK-1", "--status", "done", "--request-id", "abc-1"]);
    expect(result.code).toBe(1);
    const sent = world.calls.filter((call) => call.tool === "save_task");
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((call) => call.args.requestId))).toEqual(new Set(["abc-1"]));
    expect(result.stderr).toContain("Can't confirm whether Secani finished: update task TASK-1.");
    expect(result.stderr).toContain("Request ID      abc-1");
    expect(result.stderr).toContain("    secani tasks update TASK-1 --status done --request-id abc-1");
  });

  it("times out a request that never answers: a read fails, a write is an unknown outcome", async () => {
    const timeout = () => Object.assign(new DOMException("The operation timed out.", "TimeoutError"));
    tool(world, { name: "list_tasks", handler: () => { throw timeout(); } });
    const read = await run(world, ["tasks", "list", "--json"]);
    expect(read.code).toBe(1);
    expect(JSON.parse(read.stderr)).toMatchObject({ reason: "network_error", message: "Couldn't reach mcp.secani.com. No answer arrived in time." });
    expect(world.calls.filter((call) => call.tool === "list_tasks")).toHaveLength(3);
    tool(world, { name: "save_task", readOnly: false, handler: () => { throw timeout(); } });
    const write = await run(world, ["tasks", "update", "TASK-1", "--status", "done", "--json"]);
    expect(write.code).toBe(1);
    expect(JSON.parse(write.stderr)).toMatchObject({ reason: "unknown_outcome", data: { remote: "unknown" } });
  });

  it("names the host when it can't be reached", async () => {
    const result = await run(world, ["whoami", "--json"], { env: { SECANI_MCP_URL: "https://offline.example.test/mcp", SECANI_TOKEN: "env-token" } });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "network_error",
      message: "Couldn't reach offline.example.test. The host name didn't resolve.",
      retryable: true,
    });
  });
});

describe("tools", () => {
  it("fills the workspace and a request ID, and prints the structured result", async () => {
    tool(world, {
      name: "save_vendor",
      readOnly: false,
      properties: ["organizationSlug", "workspaceSlug", "requestId", "name"],
      handler: (args) => ({ result: { vendorId: "v1", name: args.name } }),
    });
    const result = await run(world, ["tools", "call", "save_vendor", "--input", '{"name":"Acme Cloud"}', "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tool: "save_vendor", result: { vendorId: "v1", name: "Acme Cloud" } });
    expect(world.calls.at(-1)!.args).toMatchObject({ organizationSlug: "acme", workspaceSlug: "isms", name: "Acme Cloud", requestId: expect.any(String) });
  });

  it("asks before a destructive tool and suggests the closest tool name", async () => {
    tool(world, { name: "remove_link", readOnly: false, destructive: true, properties: ["requestId"], handler: () => ({ result: { ok: true } }) });
    const blocked = await run(world, ["tools", "call", "remove_link", "--non-interactive"]);
    expect(blocked.code).toBe(2);
    expect(world.calls.map((call) => call.tool)).not.toContain("remove_link");
    const typo = await run(world, ["tools", "call", "remove_lnk"]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("Did you mean remove_link?");
  });

  it("takes a framework ID without resolving a workspace when --input names one", async () => {
    world.tools.delete("whoami");
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    tool(world, {
      name: "get_isms_status",
      properties: ["organizationSlug", "workspaceSlug", "governanceScopeId"],
      required: ["governanceScopeId"],
      handler: () => ({ result: { contract: "ok" } }),
    });
    const id = "k17f2c9d8m3n4p5q6r7s8t9v0w1x2y3z";
    const result = await run(world, ["tools", "call", "get_isms_status", "--framework", id, "--input", '{"organizationSlug":"acme","workspaceSlug":"privacy"}', "--json"], { env: { CLAUDECODE: "1" } });
    expect(result.code).toBe(0);
    expect(world.calls.at(-1)!.args).toMatchObject({ organizationSlug: "acme", workspaceSlug: "privacy", governanceScopeId: id });
    expect(world.calls.map((call) => call.tool)).not.toContain("whoami");
  });

  it("resends a write with the requestId given in --input", async () => {
    tool(world, { name: "save_task", readOnly: false, properties: ["requestId"], handler: (_args, call) => (call === 1 ? { network: true } : { result: { ok: true } }) });
    const result = await run(world, ["tools", "call", "save_task", "--input", '{"requestId":"mine-1","id":"TASK-1"}', "--json"]);
    expect(result.code).toBe(0);
    const sent = world.calls.filter((call) => call.tool === "save_task");
    expect(sent.map((call) => call.args.requestId)).toEqual(["mine-1", "mine-1"]);
  });

  it("resolves a framework name in the workspace --input names", async () => {
    world.tools.delete("whoami");
    whoamiTool(world, ["acme/isms", "acme/privacy"]);
    tool(world, {
      name: "get_isms_status",
      properties: ["organizationSlug", "workspaceSlug", "governanceScopeId"],
      required: ["governanceScopeId"],
      handler: () => ({ result: { contract: "ok" } }),
    });
    const result = await run(world, ["tools", "call", "get_isms_status", "--framework", "iso 27001", "--input", '{"organizationSlug":"acme","workspaceSlug":"privacy"}', "--json"], { env: { CLAUDECODE: "1" } });
    expect(result.code).toBe(0);
    expect(world.calls.find((call) => call.tool === "whoami")!.args).toMatchObject({ organizationSlug: "acme", workspaceSlug: "privacy" });
    expect(world.calls.at(-1)!.args).toMatchObject({ workspaceSlug: "privacy", governanceScopeId: "scope_iso" });
  });

  it("rejects input that isn't a JSON object", async () => {
    const result = await run(world, ["tools", "call", "whoami", "--input", "[1]"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--input must be a JSON object.");
  });
});
