#!/usr/bin/env node
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
import { cli } from "./lib/ui"
import { warnIfOutdated } from "./lib/updateCheck"
// Version is sourced from package.json so it stays in sync with each release
// without anyone having to remember to bump a string here. Bun's --compile
// inlines this JSON into the standalone binary at build time.
import pkg from "../package.json" with { type: "json" }
import { loginCommand } from "./commands/login"
import { whoamiCommand, logoutCommand } from "./commands/account"
import { functionsCommand } from "./commands/functions"
import { functionsInitCommand } from "./commands/functions/init"
import { functionsImportCommand } from "./commands/functions/import"
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
import { callsCommand } from "./commands/api/calls"
import { telegramCommand } from "./commands/api/telegram"
import { emailDomainsCommand } from "./commands/api/emailDomains"
import { memoryCommand } from "./commands/api/memory"
import {
  balanceCommand,
  introspectCommand,
} from "./commands/api/account"

const program = new Command()
  // The binary is `zavudev`; `zavu` is gone. This is what every usage line and
  // error message is built from, so it has to match what people can actually run.
  .name("zavudev")
  .description(
    "Zavu CLI — deploy Functions, send messages, and manage every resource exposed by the public API."
  )
  // `--version` is handled here rather than by commander's built-in flag so it
  // can also say when that version is stale. A CLI silently four minors behind
  // produces "the API does not support this" reports that are really an old
  // binary. The check is best-effort and never blocks.
  .option("-V, --version", "Print the version and check for a newer one")
  .showHelpAfterError()

// Auth + Functions dev workflow. The `functions` group keeps the full set
// (init, deploy, invoke, logs) for discoverability under one namespace, but
// each one is also mounted top-level since `npx zavudev init` / `npx zavudev deploy` is
// what most users will type from muscle memory.
program.addCommand(loginCommand())
program.addCommand(whoamiCommand())
program.addCommand(logoutCommand())
program.addCommand(functionsInitCommand())
program.addCommand(functionsImportCommand())
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
program.addCommand(memoryCommand())
program.addCommand(callsCommand())
program.addCommand(telegramCommand())
program.addCommand(emailDomainsCommand())
program.addCommand(addressesCommand())
program.addCommand(documentsCommand())
program.addCommand(exportsCommand())
program.addCommand(urlsCommand())
program.addCommand(subAccountsCommand())
program.addCommand(tenDlcCommand())
program.addCommand(introspectCommand())

// Singletons (no list/get pattern).
program.addCommand(balanceCommand())

// Commander's built-in `help` takes a single command name, so
// `zavu help agents create` silently printed the help for `agents` — the
// parent — instead of for `create`. Two of the three conventions people try
// worked (`agents create --help`, `agents help create`); this one lied.
//
// Walk the whole argument list down the command tree so every depth resolves,
// and name the token that failed rather than falling back to the root help.
program
  .command("help [command...]")
  .description("Show help for a command, e.g. `help agents create`.")
  .action((path: string[] = []) => {
    let cmd: Command = program
    for (const name of path) {
      const next = cmd.commands.find(
        (c) => c.name() === name || c.aliases().includes(name)
      )
      if (!next) {
        process.stderr.write(
          `Unknown command "${name}"${cmd !== program ? ` under \`${cmd.name()}\`` : ""}.\n`
        )
        cmd.outputHelp()
        process.exit(1)
      }
      cmd = next
    }
    cmd.outputHelp()
  })

// An unrecognised command printed the root help and exited 0 — so a typo, or a
// quoted argument that never got split, looked like a successful run that
// happened to print a lot. Say what was not understood and fail.
program.on("command:*", (operands: string[]) => {
  process.stderr.write(`Unknown command "${operands[0]}".\n`)
  process.stderr.write(`Run \`${cli("--help")}\` to see the available commands.\n`)
  process.exit(1)
})

// Intercepted before parseAsync so `zavu --version` prints the number, checks
// npm, and exits without commander looking for a subcommand.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write(`${pkg.version}\n`)
  void warnIfOutdated(pkg.version).then(() => process.exit(0))
} else {
  program.parseAsync().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
