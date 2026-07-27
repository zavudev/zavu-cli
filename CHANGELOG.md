# Changelog

All notable changes to the `zavudev` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `agents executions` and `agents stats` now state that they cover messaging only.
  An execution is one inbound message answered by the agent, so an agent that only
  takes calls reported no activity no matter how many it handled. Voice calls are
  recorded as calls: use `calls list`, and `calls get <id>` for the transcript.

## [0.9.3] - 2026-07-27

### Fixed

- `login` did not exit after reporting success. It now returns as soon as the
  token is stored.
- Functions created with `--http` returned a public URL that did not resolve.
  `deploy` and `fn info` now report the URL the function actually answers on.

## [0.9.2] - 2026-07-27

### Security

- Scaffolded projects did not include a `.gitignore`, while `fn invoke` reads
  secrets from `.env`. New projects now ignore `.env` and `.env.*` from the
  start. **If you scaffolded a project with 0.9.1 or earlier, check whether a
  `.env` was committed and rotate any keys it held.**

### Changed

- Reorganized the command structure and the scaffolded project layout.

## [0.9.1] - 2026-07-27

### Fixed

- Follow-up fixes to the HTTP endpoint toggle added in 0.9.0.

## [0.9.0] - 2026-07-27

### Added

- `fn info` shows a function's status and, when HTTP is on, its public URL.
  `--json` prints the raw response.
- `fn http enable|disable` turns the public HTTPS endpoint on or off without a
  redeploy. Previously the endpoint could only be set when the function was
  created, and never inspected from the terminal.

## [0.8.0] - 2026-07-27

### Added

- `--http` on function creation, to expose the function on a public HTTPS URL.

### Fixed

- `fn invoke` ran the handler with whatever arguments it was given. Arguments are
  now checked against the tool schema first: required fields, types, and enums.
- `fn invoke` returned the same exit code whether the tool was called wrong or the
  handler itself failed. It now exits `2` for invalid arguments and `1` when the
  handler throws.
- `--version` could report an older version than the one installed.

## [0.7.5] - 2026-07-27

### Changed

- Documentation updates.

## [0.7.2] - 2026-07-27

### Fixed

- `deploy` listed agents and tools as modified when nothing about them had
  changed. The summary now marks only what actually changed.

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
