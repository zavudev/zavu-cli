# @zavudev/cli

Official CLI for Zavu. Built with Bun, compiles to a single standalone binary
per platform (no Node or Bun runtime required on the user's machine).

## What's included

| Command | What it does |
|---|---|
| `zavu login` | Authenticate. Stores API key in `~/.zavu/credentials.json` (chmod 600). |
| `zavu functions init` | Scaffold a new function locally + register it in your project. |
| `zavu functions deploy` | Push the local function code to Zavu (server-side bundle + activate). |
| `zavu functions invoke` | Run the function locally with a synthetic event. Mock or live mode. |
| `zavu functions logs --tail` | Stream invocation logs. |
| `zavu messages send / list / get` | Wraps the SDK's messages resource. More API mirrors planned. |

The `zavu functions` group is the dev workflow (init/deploy/invoke/logs). The
top-level groups (`messages`, future `contacts`, `templates`, etc.) thinly
wrap `@zavudev/sdk` so they stay auto-aligned with the API.

## Develop locally

```sh
bun install
bun run dev login            # invoke straight from src/
bun run dev functions init
```

## Build a binary

```sh
# Single platform
bun run build:macos-arm64
./dist/zavu-macos-arm64 login

# All supported targets
bun run build:all
ls dist/
# zavu-macos-arm64
# zavu-macos-x64
# zavu-linux-x64
# zavu-linux-arm64
# zavu-windows-x64.exe
```

The binaries embed the Bun runtime; users don't need anything installed.
Ship via npm (`npx zavudev@latest` / `npm install -g zavudev`) and GitHub Releases. The Homebrew tap is deprecated.

## Architecture

- `src/index.ts` — Commander program, mounts subcommand groups.
- `src/commands/login.ts` — auth flow.
- `src/commands/functions/` — dev workflow (init, deploy, invoke, logs).
- `src/commands/api/messages.ts` — example API mirror. Pattern repeats for each SDK resource.
- `src/lib/config.ts` — `~/.zavu/credentials.json` + `./.zavu/config.json`.
- `src/lib/client.ts` — builds an authenticated `@zavudev/sdk` client.
- `src/lib/ui.ts` — color output, table rendering, fail() helper.
- `src/templates.ts` — function scaffolding templates (mirrors the dashboard's set).

## Backend API endpoints

The CLI talks to these endpoints on top of the SDK:

- `POST /v1/functions` — create a function (used by `init`)
- `POST /v1/functions/:id/deploy` — start a deployment (used by `deploy`)
- `GET  /v1/functions/deployments/:id` — poll deployment status
- `GET  /v1/functions/:id/logs` — fetch invocation logs

These live in `apps/dashboard/convex/routes/functions.ts` and are documented
in `apps/docs/openapi.json`. Stainless will pick them up on the next SDK
regeneration; until then the CLI calls them directly with `fetch`.
