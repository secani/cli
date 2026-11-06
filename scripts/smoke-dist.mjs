// Runs the built CLI as a person would: shebang and executable bit, help and
// version offline, and a command that needs a login failing as a JSON error.
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const source = await readFile(cli, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) throw new Error("dist/cli.js is missing its Node shebang");
if (process.platform !== "win32") {
  if (!((await stat(cli)).mode & 0o111)) throw new Error("dist/cli.js is not executable");
  await access(cli, constants.X_OK);
}

const config = await mkdtemp(join(tmpdir(), "secani-cli-smoke-"));
const env = { ...process.env, SECANI_CONFIG_DIR: config, SECANI_MCP_URL: "https://mcp.invalid/mcp", NO_COLOR: "1" };
delete env.SECANI_TOKEN;
delete env.SECANI_WORKSPACE;
const exec = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
const check = (condition, message, result) => {
  if (!condition) throw new Error(`${message}\nstdout: ${result?.stdout}\nstderr: ${result?.stderr}`);
};

try {
  const help = exec("--help");
  check(help.status === 0 && help.stdout.startsWith("secani <command> [options]") && help.stderr === "", "secani --help failed", help);

  const version = exec("--version");
  check(version.status === 0 && version.stdout === `${manifest.version}\n`, "secani --version printed the wrong version", version);

  const helpJson = exec("risks", "list", "--help", "--json");
  check(helpJson.status === 0 && JSON.parse(helpJson.stdout).path === "secani risks list", "secani risks list --help --json failed", helpJson);

  const usage = exec("risks", "lsit");
  check(usage.status === 2 && usage.stderr.includes("Did you mean list?"), "an unknown command didn't fail with exit 2", usage);

  const loggedOut = exec("risks", "list", "--json");
  check(loggedOut.status === 1 && loggedOut.stdout === "", "a command without a login didn't fail with exit 1", loggedOut);
  check(JSON.parse(loggedOut.stderr).reason === "login_required", "the login error isn't login_required", loggedOut);

  console.log("secani dist smoke passed");
} finally {
  await rm(config, { recursive: true, force: true });
}
