import { afterEach, beforeEach, describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import { ROOT } from "../src/commands/index";
import { parseArgv } from "../src/runtime/args";
import { allCommands } from "../src/runtime/help";
import { createWorld, run, type World } from "./harness";

let world: World;
beforeEach(() => {
  world = createWorld();
});
afterEach(() => world.cleanup());

describe("help and parsing", () => {
  it("shows root help on stdout, offline, for every entry point", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
      const result = await run(world, argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("secani <command> [options]");
      expect(result.stdout).toContain("Risk and Compliance:");
      expect(result.stderr).toBe("");
    }
    expect(world.calls).toHaveLength(0);
  });

  it("reaches the same help at any depth, and a group without an action shows its help", async () => {
    const viaFlag = await run(world, ["risks", "list", "--help"]);
    const viaHelp = await run(world, ["help", "risks", "list"]);
    expect(viaFlag.stdout).toBe(viaHelp.stdout);
    expect(viaFlag.stdout).toMatch(/^secani risks list \[options\]\nList the workspace's active risks/);
    const group = await run(world, ["risks"]);
    expect(group.code).toBe(0);
    expect(group.stdout).toContain("Commands:");
  });

  it("wins over invalid input and over --version", async () => {
    const result = await run(world, ["risks", "list", "--bogus", "--version", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("secani risks list");
  });

  it("fails unknown commands and options with one suggestion and exit 2", async () => {
    const command = await run(world, ["risks", "lsit"]);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain("Unknown command lsit for secani risks. Did you mean list?");
    expect(command.stderr).toContain("    secani risks --help");
    const option = await run(world, ["tasks", "list", "--stauts", "done", "--json"]);
    expect(option.code).toBe(2);
    expect(option.stdout).toBe("");
    const error = JSON.parse(option.stderr);
    expect(error).toMatchObject({ status: "error", reason: "unknown_option", data: { suggestion: "--status" } });
  });

  it("never infers an option or command from a prefix", async () => {
    expect((await run(world, ["risks", "li"])).code).toBe(2);
    expect((await run(world, ["tasks", "list", "--stat", "done"])).code).toBe(2);
  });

  it("rejects values outside an option's choices before any request", async () => {
    const result = await run(world, ["risks", "list", "--status", "opne"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--status accepts identified, analyzed");
    expect(world.calls).toHaveLength(0);
  });

  it("prints the version, as JSON on request", async () => {
    expect((await run(world, ["--version"])).stdout).toBe(`${manifest.version}\n`);
    expect(JSON.parse((await run(world, ["tasks", "-v", "--json"])).stdout)).toEqual({ version: manifest.version });
  });

  it("describes a command as JSON from the same metadata", async () => {
    const result = await run(world, ["tasks", "update", "--help", "--json"]);
    const doc = JSON.parse(result.stdout);
    expect(doc.path).toBe("secani tasks update");
    expect(doc.consequence).toBe("ordinary");
    expect(doc.options.map((option: { name: string }) => option.name)).toContain("due");
    expect(doc.arguments).toEqual([{ name: "TASK", required: true, description: "The task's ID, such as TASK-12" }]);
  });

  it("finds commands by task, offline", async () => {
    const result = await run(world, ["help", "search", "overdue", "--json"]);
    expect(JSON.parse(result.stdout).commands[0].path).toBe("secani tasks list");
    const none = await run(world, ["help", "search", "zzzz"]);
    expect(none.code).toBe(0);
    expect(none.stderr).toContain('No commands match "zzzz".');
  });

  it("parses --name=value, -x value and globals before or after the path", () => {
    const a = parseArgv(ROOT, ["-w", "acme/isms", "tasks", "list", "--status=done"]);
    const b = parseArgv(ROOT, ["tasks", "list", "--status", "done", "--workspace=acme/isms"]);
    expect(a.options).toMatchObject({ workspace: "acme/isms", status: "done" });
    expect(b.options).toMatchObject({ workspace: "acme/isms", status: "done" });
    expect(a.path).toEqual(["tasks", "list"]);
  });

  it("treats everything after -- as positional", async () => {
    const parsed = parseArgv(ROOT, ["search", "--", "--not-an-option"]);
    expect(parsed.passthrough).toEqual(["--not-an-option"]);
    const { bindArgs } = await import("../src/runtime/args");
    expect(bindArgs(ROOT, parsed, parsed.node as never)).toEqual({ QUERY: "--not-an-option" });
  });

  it("gives every command an example that parses against current metadata", () => {
    for (const { spec, path } of allCommands(ROOT)) {
      expect(spec.summary, path.join(" ")).toMatch(/^[A-Z][^.]*[^.]$/);
      for (const example of spec.examples ?? []) {
        const argv = example.command
          .match(/'[^']*'|\S+/g)!
          .slice(1)
          .map((token) => token.replace(/^'|'$/g, ""))
          .filter((token) => token !== "<" && !token.endsWith(".json"));
        expect(() => parseArgv(ROOT, argv), example.command).not.toThrow();
        expect(parseArgv(ROOT, argv).path, example.command).toEqual(path);
      }
    }
  });

  it("keeps help readable without color at 80 columns", async () => {
    const result = await run(world, ["risks", "create", "--help"], { columns: 80 });
    for (const line of result.stdout.split("\n")) {
      if (line.trim().startsWith("secani risks create --title")) continue;
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
    expect(result.stdout).not.toMatch(/\u001b\[/);
  });
});
