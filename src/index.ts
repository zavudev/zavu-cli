#!/usr/bin/env bun
// Zavu CLI entry point.
//
// Distribution targets:
//   bun run dev               — development (uses TS source)
//   bun run build             — single .js bundle (still needs Bun runtime)
//   bun run build:macos-arm64 — standalone executable for macOS Apple Silicon
//   bun run build:linux-x64   — standalone executable for Linux x86_64
//   etc.
//
// Once compiled with bun build --compile, users get a single static binary
// — no Node, no Bun, no node_modules required on their machine.
//
// Layout:
//   - login + functions are dev-workflow commands (auth, deploy, invoke, logs).
//   - Everything else mirrors the public REST API resource-by-resource. Each
//     resource lives in src/commands/api/* and uses the shared helpers in
//     lib/resource.ts (declarative CRUD) or lib/api.ts (raw fetch) so the
//     surface stays in lockstep with apps/docs/openapi.json.

import { Command } from "commander"
// Version is sourced from package.json so it stays in sync with each release
// without anyone having to remember to bump a string here. Bun's --compile
// inlines this JSON into the standalone binary at build time.
import pkg from "../package.json" with { type: "json" }
import { loginCommand } from "./commands/login"
import { whoamiCommand, logoutCommand } from "./commands/account"
import { functionsCommand } from "./commands/functions"
import { functionsInitCommand } from "./commands/functions/init"
import { functionsPushCommand } from "./commands/functions/push"
import { functionsDeployCommand } from "./commands/functions/deploy"
import { functionsInvokeCommand } from "./commands/functions/invoke"
import { functionsLogsCommand } from "./commands/functions/logs"

import { messagesCommand } from "./commands/api/messages"
import { sendersCommand } from "./commands/api/senders"
import { templatesCommand } from "./commands/api/templates"
import { contactsCommand } from "./commands/api/contacts"
import { broadcastsCommand } from "./commands/api/broadcasts"
import { phoneNumbersCommand } from "./commands/api/phoneNumbers"
import { invitationsCommand } from "./commands/api/invitations"
import { addressesCommand } from "./commands/api/addresses"
import { documentsCommand } from "./commands/api/documents"
import { exportsCommand } from "./commands/api/exports"
import { urlsCommand } from "./commands/api/urls"
import { subAccountsCommand } from "./commands/api/subAccounts"
import { tenDlcCommand } from "./commands/api/tenDlc"
import { agentsCommand } from "./commands/api/agents"
import {
  balanceCommand,
  planCommand,
  usageCommand,
  introspectCommand,
} from "./commands/api/account"

const program = new Command()
  .name("zavu")
  .description(
    "Zavu CLI — deploy Functions, send messages, and manage every resource exposed by the public API."
  )
  .version(pkg.version)
  .showHelpAfterError()

// Auth + Functions dev workflow. The `functions` group keeps the full set
// (init, deploy, invoke, logs) for discoverability under one namespace, but
// each one is also mounted top-level since `zavu init` / `zavu deploy` is
// what most users will type from muscle memory.
program.addCommand(loginCommand())
program.addCommand(whoamiCommand())
program.addCommand(logoutCommand())
program.addCommand(functionsInitCommand())
program.addCommand(functionsPushCommand())
program.addCommand(functionsDeployCommand())
program.addCommand(functionsInvokeCommand())
program.addCommand(functionsLogsCommand())
program.addCommand(functionsCommand())

// API resource mirrors. Order shown in --help follows registration order.
program.addCommand(messagesCommand())
program.addCommand(templatesCommand())
program.addCommand(sendersCommand())
program.addCommand(contactsCommand())
program.addCommand(broadcastsCommand())
program.addCommand(phoneNumbersCommand())
program.addCommand(invitationsCommand())
program.addCommand(agentsCommand())
program.addCommand(addressesCommand())
program.addCommand(documentsCommand())
program.addCommand(exportsCommand())
program.addCommand(urlsCommand())
program.addCommand(subAccountsCommand())
program.addCommand(tenDlcCommand())
program.addCommand(introspectCommand())

// Singletons (no list/get pattern).
program.addCommand(balanceCommand())
program.addCommand(planCommand())
program.addCommand(usageCommand())

program.parseAsync().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
