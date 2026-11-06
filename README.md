# secani

Work with your Secani ISMS from the terminal: risks, tasks, findings, controls
and incidents, plus every tool of Secani's MCP server. Made for people, shell
scripts and coding agents.

```bash
npm install --global secani
secani login
secani workspaces switch acme/isms
secani tasks list --assignee me --open
secani risks list --min-level high
```

Or run it without installing: `npx secani login`. It needs Node.js 22.12 or
newer and a Secani account.

Documentation: [secani.com/docs/cli](https://secani.com/docs/cli).

## Logging in

`secani login` prints a login page and a code and opens the page in your browser
(`--no-open` only prints it, for SSH sessions and containers). Confirm the code
there and the CLI stores the login owner-only in `~/.config/secani/auth.json`
(`SECANI_CONFIG_DIR` moves it). The login refreshes itself; `secani logout`
deletes it from this computer.

The CLI connects to Secani the way Claude and ChatGPT do, as an MCP client.
It starts read-only: to create or change records, allow writes for
**Secani CLI** in the Secani app under Settings > Integrations. The same page
removes the connection.

## Commands

| Command | What it does |
| --- | --- |
| `secani login`, `logout`, `whoami` | Log in and out; show the account and current workspace |
| `secani workspaces list`, `switch <ORG/WORKSPACE>` | List workspaces and choose the current one |
| `secani risks list`, `inspect`, `create`, `update`, `delete` | The risk register |
| `secani controls list`, `inspect` | Controls (measures) |
| `secani findings list`, `inspect` | Audit and assessment findings |
| `secani tasks list`, `inspect`, `create`, `update`, `archive`, `restore` | Tasks |
| `secani incidents list`, `create`, `update` | Security incidents |
| `secani search <QUERY>` | Assets, tasks, requirements and evidence |
| `secani tools list`, `inspect`, `call <TOOL>` | Any tool of Secani's MCP server |

`secani <command> --help` shows each command's options and examples;
`secani help search <words>` finds a command by task.

## Scripts and agents

- `--json` prints exactly one JSON document on stdout and never prompts. Lists
  return `{ "<records>": [...], "pagination": { "next": ... } }`; writes return
  the record with an `outcome` (`created`, `updated`, `deleted`, `unchanged`, …)
  and the command to inspect it in `next`. Errors are one JSON line on stderr
  with a stable `reason`, and `status: "action_required"` when input or a
  person's approval would let the command run.
- Piped output is tab-separated with a header row and ISO times; a write piped
  elsewhere prints only the record's ID.
- Pass the workspace with `--workspace acme/isms` or `SECANI_WORKSPACE`. Coding
  agents (Claude Code, Cursor, Codex, Gemini CLI) never use the saved current
  workspace and never get prompts.
- Destructive commands (`risks delete`, `tasks archive`, destructive tools) ask
  first, and in non-interactive runs need `--yes`, which an agent should add
  only after a person approved.
- Every write sends an idempotency key. When the connection drops after a write
  was sent, the error prints the command to rerun with `--request-id`, which
  Secani applies at most once.
- `--limit` is a total across pages; `--next <CURSOR>` continues a list with
  the same filters.

Exit codes: `0` done, including empty results and no-ops; `1` failed; `2` usage
error or missing input; `130` canceled.

### Environment

| Variable | Effect |
| --- | --- |
| `SECANI_WORKSPACE` | Workspace for every command; `--workspace` must agree with it |
| `SECANI_TOKEN` | An MCP access token to use instead of the stored login. Tokens are short-lived |
| `SECANI_CONFIG_DIR` | Config directory (default `~/.config/secani`, `%APPDATA%\secani` on Windows) |
| `SECANI_MCP_URL` | Another Secani server, such as `https://app.localhost:3000/mcp` in development |
| `SECANI_ACCESSIBLE=1` | Plain words instead of glyphs |
| `SECANI_GUIDANCE_DISABLED=1` | No optional next steps |
| `NO_COLOR`, `FORCE_COLOR` | Color off or forced |
| `CI` | Non-interactive mode |

## Design

The CLI follows Vercel's [CLI design guidelines](https://vercel.com/design/cli):
stdout carries only the answer, everything else goes to stderr; help, the parser,
`--help --json` and `help search` come from one set of command metadata; one
writer decides interaction, format and color; errors have one class each, which
sets the exit code; destructive work previews its target and needs consent;
remote text is cleaned of terminal escapes before it prints.

It has no runtime dependencies and talks to `https://mcp.secani.com/mcp` over
MCP Streamable HTTP. Logging in uses the server's OAuth metadata, dynamic client
registration and the device authorization grant.

## Development

```bash
npm install
npm run verify    # typecheck, tests, build and a smoke test of the build
node dist/cli.js --help
```

The tests run every command end to end against a fake OAuth and MCP server
(`test/harness.ts`); nothing reaches the network. The CLI is developed in
Secani's main repository and published from [secani/cli](https://github.com/secani/cli);
see [CONTRIBUTING.md](CONTRIBUTING.md). Inside the main repository, run
`pnpm --filter ./packages/cli verify` (a path filter: the root package is also
named `secani`), and release with `node scripts/mirror-cli.mjs --release`.

## License

[Apache-2.0](LICENSE)
