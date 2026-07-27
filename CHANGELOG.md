# Changelog

All notable changes to the `zavudev` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`agents executions` and `agents stats` now state that they do not cover voice.**
  An execution is one inbound message answered by the agent, so a voice-only agent
  read as "never ran" no matter how many calls it handled. A call is a multi-turn
  conversation, not a message and a reply, so it is recorded as a call instead.
  `No executions.` now points at `calls list`, and both commands say so in `--help`.

## [0.9.3] - 2026-07-27

### Fixed

- **`login` hung after reporting success.** The local callback server was closed with
  `server.close()`, which stops accepting new connections but waits for keep-alive
  sockets the browser leaves open. The process now calls `closeAllConnections()`
  (guarded, falling back to `unref()`), so the command exits as soon as the token
  is stored.
- **`--http` printed a URL that 404s.** `deploy` read `publicUrl` from the local
  `.zavu/config.json`, which never carries it, so the flag produced a working
  endpoint at an address the caller could not learn. It is now read from the API.
- **Releases aborted on a version-bump race.** `release.sh` ran under `set -euo pipefail`,
  so a rejected `git push` killed the whole script and left a tag pointing at an
  unpushed commit. The push now fetches and rebases with up to three attempts, and
  the tag is created only after the push succeeds.

## [0.9.2] - 2026-07-27

### Changed

- Reorganized the command structure and the API scaffolding.

## [0.9.1] - 2026-07-27

### Fixed

- Follow-up fixes to the HTTP endpoint toggle.

## [0.9.0] - 2026-07-27

### Added

- **`fn info`** shows a function's status and, when HTTP is on, its public URL.
  `--json` prints the raw response.
- **`fn http enable|disable`** turns the public HTTPS endpoint on or off. It applies
  to the already-deployed function through the tag sync, so no redeploy is needed.
  Until now the endpoint was the one step in the Functions lifecycle that could
  neither be changed nor observed from a terminal.

## [0.8.0] - 2026-07-27

### Added

- **`--http`** on function creation, to expose the function on a public HTTPS URL.

### Fixed

- **`fn invoke` accepted anything.** Arguments are now validated against the tool
  schema (required fields, types, enums) before the handler runs, and exit codes
  distinguish the two failures that used to look identical: `2` when the tool was
  called wrong, `1` when the handler itself threw.
- **`.env` was missing from the scaffolded `.gitignore`.** Documenting `.env` for
  secrets without ignoring it created a path to committing credentials.
- **`--version` reported an older version than the tarball it shipped in.**
  `bun build` inlines `package.json` at build time and there was no `prepack`, so
  `npm publish` shipped whatever `dist/` happened to hold. The binary and the
  manifest now agree by construction.

## [0.7.5] - 2026-07-27

### Changed

- Documentation updates.

## [0.7.2] - 2026-07-27

### Changed

- `deploy` no longer reports unchanged agents and tools as modified. The reconcile
  step compares the stored document before patching, so `~` means something
  actually changed.

## [0.7.0] - 2026-07-25

### Added

- Voice agent support, following the two-way voice channel.

## [0.5.0] - 2026-07

### Added

- CPU architecture selection for functions.

## [0.4.0] - 2026-07

### Added

- Agent routes and identifier lookup.

## [0.3.0] and earlier

Initial releases: `login`, Functions scaffolding and deploy, senders, contacts,
and message sending.
