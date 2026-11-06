# Contributing

Thanks for helping improve the Secani CLI.

## Where the code lives

The CLI is developed in Secani's main repository, next to the MCP server it talks to, and copied to this repository for each release. Commits here are generated from there, so a pull request isn't merged here directly: a maintainer applies it in the main repository, with credit to you, and it arrives here with the next sync.

## Issues

Bug reports and ideas are welcome as GitHub issues. For a bug, include the command you ran, what you expected, what happened, the output of `secani --version`, and, if it helps, the output of the command with `--debug`. Remove workspace names or record titles you don't want to share. Report security issues as described in [SECURITY.md](SECURITY.md), not as issues.

## Working on the code

```bash
npm install
npm run verify    # typecheck, tests, build and a smoke test of the build
node dist/cli.js --help
```

The tests run every command against a fake OAuth and MCP server (`test/harness.ts`) and never reach the network. The CLI follows [Vercel's CLI design guidelines](https://vercel.com/design/cli); new commands are declared as metadata in `src/commands` and use the shared helpers in `src/runtime` for output, errors and consent.
