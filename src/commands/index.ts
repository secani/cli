import type { RootSpec } from "../runtime/spec";
import { accountCommands, workspaces } from "./account";
import { controls } from "./controls";
import { findings } from "./findings";
import { incidents } from "./incidents";
import { risks } from "./risks";
import { search } from "./search";
import { tasks } from "./tasks";
import { tools } from "./tools";

export const ROOT: RootSpec = {
  kind: "root",
  name: "secani",
  summary: "Work with your Secani ISMS from the terminal",
  sections: [
    { title: "Account and Workspaces", entries: [accountCommands.login, accountCommands.logout, accountCommands.whoami, workspaces] },
    { title: "Risk and Compliance", entries: [risks, controls, findings] },
    { title: "Operations", entries: [tasks, incidents] },
    { title: "Search and Automation", entries: [search, tools] },
  ],
  examples: [
    { title: "Log in", command: "secani login" },
    { title: "Read high risks in a script", command: "secani risks list --min-level high --workspace acme/isms --json" },
  ],
  notes: [
    "Environment: SECANI_TOKEN (an access token instead of the stored login), SECANI_WORKSPACE (workspace for every command; must agree with --workspace), SECANI_CONFIG_DIR (config directory), SECANI_MCP_URL (another Secani server), SECANI_ACCESSIBLE=1 (plain words instead of glyphs), SECANI_GUIDANCE_DISABLED=1 (no optional next steps), NO_COLOR and FORCE_COLOR, CI (non-interactive).",
    "Exit codes: 0 done (including empty results and no-ops), 1 failed, 2 usage or missing input, 130 canceled.",
  ],
};
