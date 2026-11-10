# Changelog

All notable changes to the `zavudev` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2026-11-10

### Added

- `zavudev sandboxes` starts and drives isolated Linux machines, billed per
  second. Sandboxes need a paid plan and a live API key.

  `sandboxes create` starts one (`--size`, `--timeout` or `--no-timeout`,
  `--ephemeral`, `--env KEY=value`, `--environment`, `--from` a snapshot or
  share code, `--setup-script`, `--wait`). `list`, `get`, `stop`, `resume`,
  `fork` and `delete` manage it.

  `sandboxes exec <id> -- <command>` runs a command and exits with its exit
  code; `--background` returns a command id to follow with `sandboxes command`.
  `sandboxes files read|write|list|rm` moves files, `sandboxes ports expose`
  gives a port an HTTPS URL, `sandboxes ssh` authorizes your public key, and
  `sandboxes desktop` opens the machine's screen.

  `sandboxes snapshots` saves (`create --wait` waits until it is ready),
  shares and deletes disks, and `sandboxes environments` keeps named sets of
  variables to start with. Their values are never shown back, only the last
  four characters.

  Retrying `sandboxes create` with the same `--idempotency-key` prints the
  sandbox the first call created instead of failing.

- `zavudev project-webhook get|set|update|delete` configures the project
  webhook, where invitation, broadcast, email domain and sandbox events are
  delivered. `set` prints the signing secret once.

- `phone-numbers requirements --phone-number <e164>` returns the regulatory
  requirements for the exact number you are about to buy, which are the ones
  `buy` accepts. `--country` is no longer required when it is given.

- `phone-numbers buy` accepts `--type` and a repeatable
  `--requirement <requirementId>=<value>`, so a number in a regulated country
  can be bought from the CLI. The value is text, or the id of an address or
  document created beforehand. `--type` is required with `--requirement`.

- `zavudev memory` manages what your agents remember between messages, in both
  of the ways they need to.

  Facts, recalled by meaning: `memory add`, `search`, `list`, `get`, `delete`,
  and `wipe`. Use it for "she is allergic to peanuts", which nobody would think
  to look up under a key.

  Collections, read and written by key: `memory collection set` / `get` / `del`
  / `list` / `query`. Use it for the booking, the cart, the counter. Plural
  manages the set (`memory collections list|create|get|update|delete`) and
  singular operates inside one (`memory collection list <name>`).

  Every command takes `--scope contact:<id>` or `--scope conversation:<id>`, so
  what an agent remembers can belong to one person or one thread instead of the
  whole project.

  `memory collection export` writes a collection to stdout as NDJSON and
  `memory collection import` reads it back, so one can be backed up, edited
  with ordinary text tools, and pushed to another. `memory usage` shows the
  month against your plan's quota.

  A value typed at the shell is stored as JSON when it is JSON and as a string
  otherwise, so `memory collection set prefs theme dark` needs no quoting. Each
  write prints the type it stored.

  Available once Zavu Memory is enabled for your team.

### Changed

- `zavudev fn invoke` hands the handler the same `ctx.memory` it gets when
  deployed. Without `--live` it holds its data in memory for the length of the
  run and prints one line saying so, so a handler that reads or writes what the
  agent remembers can be exercised locally without touching your project's data.

- `zavudev init --template restaurant-booking` scaffolds an agent whose
  reservations survive a restart. It previously kept them in a variable, so
  every booking was lost when the function went cold and `view_reservation`
  answered "not found" for a reservation the same conversation had just made.

- A new project is scaffolded against `@zavudev/functions@^0.3.0`, which is
  where `ctx.memory` lives. In a project you already have, run
  `npm install -D @zavudev/functions@^0.3.0` before using it.

### Fixed

- `zavudev login` on Windows opens the full authorize URL. `cmd /c start`
  was splitting on `&`, so the browser only got `?port=` and the
  dashboard showed "Missing required parameters" while the same link
  pasted from the terminal worked.

- `zavudev init --template blank` scaffolds a project that passes
  `tsc --noEmit`. The echo handler did not typecheck against the strict
  `tsconfig.json` it was scaffolded with, so a new project reported errors
  before anyone had changed a line.

## [0.14.0] - 2026-08-10

### Added

- `zavudev agents test --execute-tools` runs the tools the agent calls instead
  of reporting the choice and stopping. Each call prints with whether the
  handler answered, and a run where the agent called nothing says so. The
  handlers run for real: whatever they do — charge, write, notify — happens.
  Nothing is delivered to a customer.

### Fixed

- A failed deploy prints the build output: the unresolved import, the syntax
  error, the package that would not install. It previously reported only a
  one-line status that rarely named anything you could act on.
- A deploy no longer reports success when an agent ends up unable to receive
  anything, which happens when it declares channels its sender does not have.
  The agent and the mismatch are printed and the command exits non-zero.
- `zavudev functions init` scaffolded a project pinned to an older release of
  `@zavudev/functions`, so flows, knowledge bases and multi-sender agents had
  no types and code copied from the docs did not typecheck. New projects get
  the current release. In a project you already have, run
  `npm install -D @zavudev/functions@^0.2.0`.
- The scaffolded `tsconfig.json` covered only the project root, so a file in a
  subdirectory was never typechecked. It covers subdirectories now.

## [0.13.0] - 2026-08-10

### Added

- A function can be split across as many files as it needs. `zavudev deploy`
  starts at your entrypoint and uploads every file it reaches through relative
  imports, and the imports between them are resolved when the function is
  built.

  Files nothing imports are not uploaded, so tests and scratch work stay on
  your machine. A project can hold up to 200 files totalling 900,000 bytes.
  npm packages are unchanged: declare them under `dependencies` in
  `package.json`.

  Paths that reach above the project directory, `node_modules/`, and
  `package.json` are refused. If you import a file from outside the project,
  move it in or publish it as an npm package.

### Changed

- `zavudev deploy` no longer warns that a relative import cannot be deployed.
  It follows the import and uploads the file. An import it cannot resolve is
  still reported, and the deploy continues.
- `--source <file>` names the project's entrypoint. It used to name the only
  file that would be uploaded.
- A single-file project deploys exactly as before.

## [0.12.0] - 2026-08-08

### Added

- `zavudev senders signature <senderId>` prints which signature scheme a
  sender's webhook is sent: `v1`, `v2`, or both during a migration. A receiver
  that verifies the wrong one rejects every delivery, and nothing in the
  request says which you are being sent, so this is the way to check.
- `zavudev senders update --signature-version <v1|v1+v2|v2>` moves a sender
  between schemes. Going straight from `v1` to `v2` is refused: set `v1+v2`
  first, confirm your receiver accepts the new one, then switch. `senders list`
  shows a `signature` column.
- `zavudev senders update --webhook-url` and `--webhook-events`. Changing
  either previously meant hand-writing the JSON body with `--data`.
- `zavudev agents tools rotate-secret <toolId>` mints a new signing secret for
  a tool's webhook. The previous one stops working immediately, so update your
  endpoint first.
- `zavudev deploy` prints what it synced for knowledge bases and flows, not
  only agents and tools. A flow arrives disabled and the output says how to
  turn it on.
- `zavudev deploy` warns before uploading when the file looks like it imports
  another file next to it, since a function deploys as a single file. It is a
  warning, not a refusal: the check reads source text without parsing it, and
  stopping a deploy that would have worked costs more than a stray line.

### Changed

- `zavudev deploy` no longer prints a per-document line for a knowledge base.
  Documents sync after the deploy returns, so that line reported nothing had
  changed whether or not anything had. The knowledge bases themselves are
  still listed.
- `zavudev fn init` scaffolds an agent with a tool by default (`defineAgent` +
  `defineTool`), the shape the guides and skills teach. The previous default is
  still there as `--template blank`; it uses `defineFunction` and handles raw
  events, which is a different model.

- `zavudev agents tools test <toolId>` runs one tool now and prints what it
  answered: the status, the body and how long it took. Running a tool was
  REST-only, so the way to check whether a tool worked was to write a curl.
  A tool that answers with an error is reported as a failed run rather than as
  a success. It calls the real webhook, so it has whatever side effects the
  tool has.
- `zavudev agents tools test-runs <toolId>` lists the recent runs of that tool,
  with the reason on screen for the ones that failed. Manual tests only: a tool
  called by the agent during a real conversation is not listed there.
- `zavudev agents executions` shows a `tools` column with how many tools the
  agent called on each reply. A zero on a reply that promised a lookup is the
  answer to "it said it would fetch something and nothing reached my server".
  Executions recorded before this existed show `—`, which is not the same as
  zero.

- `zavudev import <repo>` brings an agent project in from GitHub and deploys it
  in one command. It accepts `owner/repo`, `owner/repo#ref`, and github.com
  URLs, detects the project type automatically, and supports monorepos via
  `--root`. Private repositories work by setting a `GITHUB_TOKEN` environment
  variable; the token is only sent to GitHub.
- `zavudev deploy` now recognizes projects written with the eve agent framework
  (an `agent/instructions.md` layout) and deploys them as Zavu agents without
  any changes to the project's files. A compatibility report prints before the
  deploy: every eve capability that will not run on Zavu is listed explicitly,
  and tools declared with Zod schemas are converted to JSON Schema
  automatically. Compiling an eve project requires `esbuild` in the project
  (`npm install -D esbuild`); `zavudev import` installs it for you.
- A file under `agent/tools/` counts as a tool only when it default-exports
  `defineTool({ ... })`. One that does not is reported by name before the deploy
  starts, so the tool count in the compatibility report is always the number of
  tools the deploy actually creates.
- `agent/agent.ts` is read for two keys: `model` and `name`. Every other key it
  declares is reported by name in the compatibility report, including keys Zavu
  has never heard of, so nothing a project declares is dropped without saying
  so. Two consequences worth knowing: a `voice` block is not translated and the
  agent deploys as text only, and the agent takes the `name` you declared
  instead of the one in `package.json`.
- `zavudev deploy --sender <id>` binds the deployed agent to a sender for eve
  projects. Without it, the agent reads the `SENDER_ID` secret at runtime.
- `zavudev fn triggers add --events cron --cron '<expr>'` runs a function on a
  schedule. Standard 5-field cron expressions, evaluated in UTC, minimum
  granularity one minute. A function can hold several schedules.
- `zavudev deploy` registers the project the first time you deploy it, so a
  project that already exists on disk no longer has to be created through
  `init` or pushed to GitHub first. The name comes from `--name`, then
  `package.json`, then the directory; the slug from `--slug` or the name.
  Later deploys reuse what the first one wrote.
- `zavudev fn git link <owner/repo>` connects a GitHub repository to a function
  so every push to the branch deploys it. Linking previously required the
  dashboard, so it could not be scripted or run from CI. Also `fn git status`,
  `fn git deploy` to deploy the linked branch on demand, and `fn git unlink`.
  The argument takes `owner/repo`, a github.com URL, or an SSH remote.

  Where the Zavu GitHub App is installed, pushes arrive through it and private
  repositories work with no setup in the repository. Without it, the command
  prints a payload URL and a secret to add as a webhook yourself; the secret is
  shown once.

### Fixed

- `zavudev deploy` failed with "No .zavu/config.json found" in a project you
  had written yourself, and neither remedy it suggested worked: `init` refuses
  a directory that already holds files, and `import` only accepts a GitHub
  repository. It now deploys the project.
- `zavudev invoke --tool <name>` could not run a tool in an eve project. It now
  runs the same compiled artifact the deploy ships, so a tool behaves locally
  the way it will once deployed. Running a tool locally needs
  `@zavudev/functions` installed in the project; the command says so when it is
  missing, instead of asking for an `npm install` that cannot fix it.
- `zavudev whoami` reported the API URL and key stored in
  `~/.zavu/credentials.json` even when `ZAVUDEV_API_KEY` was set, so the
  identity it printed was not the one answering. It now reports the
  credentials actually in use.
- `zavudev invoke --live` used the stored credentials instead of
  `ZAVUDEV_API_KEY` when both were present.
- The "not the production API" notice printed on stdout, so it landed inside
  `--json` output and broke piping a command into a JSON parser. It now prints
  on stderr.
- `zavudev fn triggers events` failed with a 404. It lists the event types
  again.
- `zavudev fn http enable` on an eve project announced a public URL without
  saying that such a project declares no HTTP handler, so the URL answered 404
  to everything. It now says so and points at `invoke --tool`.

## [0.10.1] - 2026-08-02

### Fixed

- The npm package now actually ships `@zavudev/sdk` 0.51.0. The CLI bundles
  the SDK into `dist/zavu.js` at build time, and 0.10.0 was published before
  the dependency bump landed, so its embedded client was older than the range
  in `package.json` claimed. Rebuilt and republished; no CLI behavior changes.

## [0.10.0] - 2026-07-28

### Changed

- **BREAKING: the command is now `zavudev`, not `zavu`.** If you installed
  globally, `zavu` stops working when you upgrade:

  ```sh
  npm install -g zavudev@latest
  zavudev --version
  ```

  Scripts, CI jobs, and Makefiles that call `zavu` need updating. `npx zavudev`
  is unaffected and has always been the recommended way to run it. Every usage
  line, hint, and error message now prints `zavudev`.

- `--version` also tells you when a newer release is published. The check is
  best-effort and prints to stderr, so `zavudev --version` still pipes just the
  number.

### Fixed

- `agents get` accepted an agent id and ignored it, answering about whichever
  agent the `--sender` resolved to instead. Since this is the command you use to
  confirm a deploy, it could report a different agent's configuration as your
  own. It now takes an agent id: `zavudev agents get <agentId>`.

- `agents test --sender` did not say which agent it reached. A sender resolves to
  exactly one agent, so with several attached you were testing one and reading
  the reply as proof about another. It now names the agent it tested, and warns
  which ones on that sender cannot be reached.

- New projects scaffolded without `@zavudev/sdk` in their dependencies, so the
  generated code failed to run before you had changed anything.

## [0.9.5] - 2026-07-27

### Added

- Voice on an agent, from the terminal: `agents create --voice`, with
  `--voice-greeting`, `--voice-language`, `--voice-id` and `--voice-transfer-to`.
  `agents update` takes the same flags plus `--no-voice`.
- `agents voices` lists the voices an agent can speak with, filterable by
  `--language`. Previously the only way to find a valid voice id was to open the
  dashboard.
- `senders create --enable-voice`, and real flags on `senders update`
  (`--name`, `--enable-voice`, `--disable-voice`, `--set-default`) instead of
  hand-written JSON.
- `phone-numbers search --capabilities voice,sms` filters to numbers that have
  all of them.

### Changed

- `senders create --phone` now attaches the number to the sender, so the sender
  can actually send. It requires a number your project owns and returns an error
  for one it does not, rather than creating a sender with no channels.
- `deploy` no longer prints a green success line when your declarations failed
  to sync. Read the lines above it.

### Fixed

- `init` refused to use a directory that already existed, including an empty one,
  which broke `mkdir my-agent && cd my-agent && zavudev init`.
- `fn logs` printed nothing at all when there were no logs in the window, which
  was indistinguishable from a broken command. It now says so and suggests
  `--since`.

## [0.9.4] - 2026-07-27

### Fixed

- `phone-numbers search` reported `$0` for every number on one provider while the
  purchase charged the real price. Search now quotes what you will be charged.
- Owned numbers reported themselves as SMS-only even when provisioned for calls.

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
