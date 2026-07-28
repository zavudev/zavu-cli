// `npx zavudev functions` — subcommand group for everything related to authoring and
// shipping Zavu Functions.

import { Command } from "commander"
import { functionsInitCommand } from "./init"
import { functionsDeployCommand } from "./deploy"
import { functionsPushCommand } from "./push"
import { functionsInvokeCommand } from "./invoke"
import { functionsLogsCommand } from "./logs"
import { functionsTriggersCommand } from "./triggers"
import { functionsSecretsCommand } from "./secrets"
import { functionsDeleteCommand } from "./delete"
import { functionsInfoCommand, functionsHttpCommand } from "./http"
import {
  functionsVersionsCommand,
  functionsRollbackCommand,
} from "./versions"

export function functionsCommand(): Command {
  const cmd = new Command("functions")
    .alias("fn")
    .description("Author, deploy, and operate Zavu Functions.")
  cmd.addCommand(functionsInitCommand())
  cmd.addCommand(functionsPushCommand())
  cmd.addCommand(functionsDeployCommand())
  cmd.addCommand(functionsInvokeCommand())
  cmd.addCommand(functionsLogsCommand())
  cmd.addCommand(functionsTriggersCommand())
  cmd.addCommand(functionsSecretsCommand())
  cmd.addCommand(functionsVersionsCommand())
  cmd.addCommand(functionsRollbackCommand())
  cmd.addCommand(functionsInfoCommand())
  cmd.addCommand(functionsHttpCommand())
  cmd.addCommand(functionsDeleteCommand())
  return cmd
}
