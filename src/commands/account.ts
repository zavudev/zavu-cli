// `zavu whoami` / `zavu logout` — inspect or clear the saved credentials.
//
// `whoami` is essential whenever the dashboard and CLI seem to disagree:
// it prints the project name the API key is bound to, so the user can
// confirm at a glance that they're operating on the project they expect.

import { Command } from "commander"
import { buildApi } from "../lib/api"
import {
  readCredentials,
  clearCredentials,
  credentialsPath,
} from "../lib/config"
import { ui, fail } from "../lib/ui"

export function whoamiCommand(): Command {
  return new Command("whoami")
    .description("Show which project + team the CLI is authenticated against.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      const creds = await readCredentials()
      if (!creds?.apiKey) {
        fail("Not logged in. Run `zavu login` first.")
      }
      const api = await buildApi()
      try {
        const me = await api.get<{
          project: { id: string; name: string | null; isSubAccount: boolean }
          team: { id: string; name: string | null }
          apiKey: { id: string }
          isTestMode: boolean
        }>("/v1/me")
        if (opts.json) {
          process.stdout.write(JSON.stringify(me, null, 2) + "\n")
          return
        }
        ui.info(`Project:  ${me.project.name ?? "(unnamed)"}`)
        ui.hint(`Project ID: ${me.project.id}`)
        ui.hint(`Team:       ${me.team.name ?? "(unnamed)"}`)
        ui.hint(`Mode:       ${me.isTestMode ? "test" : "live"}`)
        if (me.project.isSubAccount) ui.hint("This is a sub-account.")
        ui.hint(`API URL:    ${creds!.apiBaseUrl}`)
        ui.hint(`Key ending: …${creds!.apiKey.slice(-4)}`)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
}

export function logoutCommand(): Command {
  return new Command("logout")
    .description("Clear saved credentials. The API key on the server stays valid until you revoke it.")
    .action(async () => {
      const creds = await readCredentials()
      if (!creds) {
        ui.info("Not logged in.")
        return
      }
      await clearCredentials()
      ui.success(`Cleared ${credentialsPath()}`)
      ui.hint(
        "The API key itself is still active on the server. Revoke it from the dashboard API Keys page if needed."
      )
    })
}
