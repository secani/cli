# Changelog

All notable changes to the Secani CLI. It follows [Semantic Versioning](https://semver.org/); while the version is 0.x, a minor release may change commands, options or JSON output.

## 0.1.1

- The npm package and the README link to the documentation at [secani.com/docs/cli](https://secani.com/docs/cli).

## 0.1.0

The first release.

- `secani login`, `logout` and `whoami`, with the device-code login of Secani's MCP server.
- `secani workspaces list` and `switch`.
- `secani risks` (list, inspect, create, update, delete), `controls` and `findings` (list, inspect), `tasks` (list, inspect, create, update, archive, restore) and `incidents` (list, create, update).
- `secani search`, and `secani tools list`, `inspect` and `call` for every tool of Secani's MCP server.
- `--json` output, stable error reasons and exit codes, consent for destructive commands, and idempotent writes with `--request-id`.
