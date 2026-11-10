// `zavudev project-webhook`: the project-level webhook, where project events
// are delivered: invitations, broadcasts, email domains and sandboxes. A sender's
// webhook (message events) is configured under `senders` instead.

import { Command } from "commander"
import { buildApi } from "../../lib/api"
import { ui, fail, cli } from "../../lib/ui"
import { collectRepeatable } from "../../lib/phoneNumberRequirements"

import { PROJECT_WEBHOOK_EVENTS } from "../../lib/sandboxes"

const EVENTS = PROJECT_WEBHOOK_EVENTS.join(", ")

const PATH = "/v1/invitations/webhook"

interface ProjectWebhook {
  url: string
  events: string[]
  active: boolean
  secret?: string
}

function show(w: ProjectWebhook) {
  ui.info(`${w.url} · ${w.active ? "active" : "inactive"}`)
  ui.hint(`events: ${w.events.join(", ") || "none"}`)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function projectWebhookCommand(): Command {
  const cmd = new Command("project-webhook").description(
    "The project webhook: invitation, broadcast, email domain and sandbox events."
  )

  cmd
    .command("get")
    .description("Show the project webhook. The secret is never shown here.")
    .option("--json", "Print the raw JSON response")
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.get<{ webhook: ProjectWebhook | null }>(PATH)
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + "\n")
          return
        }
        if (!res.webhook) {
          ui.info(`No project webhook. Set one: ${cli("project-webhook set --url <https-url> --event sandbox.stopped")}`)
          return
        }
        show(res.webhook)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("set")
    .description("Create or replace the project webhook and activate it. Prints the signing secret.")
    .requiredOption("--url <url>", "HTTPS URL that receives the events")
    .requiredOption("--event <event>", `An event to subscribe to. Repeat for each. One of: ${EVENTS}`, collectRepeatable)
    .action(async (opts) => {
      const api = await buildApi()
      try {
        const res = await api.post<{ webhook: ProjectWebhook }>(PATH, { url: opts.url, events: opts.event })
        ui.success("Project webhook set.")
        show(res.webhook)
        if (res.webhook.secret) {
          ui.info("Signing secret for X-Zavu-Signature. Save it: `get` never shows it.")
          process.stdout.write(`${res.webhook.secret}\n`)
        }
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("update")
    .description("Change the URL, the events, or whether it is active. The secret is kept.")
    .option("--url <url>", "New HTTPS URL")
    .option("--event <event>", "Replaces the event list. Repeat for each.", collectRepeatable)
    .option("--active", "Turn delivery on")
    .option("--inactive", "Turn delivery off")
    .action(async (opts) => {
      if (opts.active && opts.inactive) fail("Pass --active or --inactive, not both.")
      const body = {
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.event?.length ? { events: opts.event } : {}),
        ...(opts.active ? { active: true } : {}),
        ...(opts.inactive ? { active: false } : {}),
      }
      if (Object.keys(body).length === 0) fail("Pass --url, --event, --active or --inactive.")
      const api = await buildApi()
      try {
        const res = await api.patch<{ webhook: ProjectWebhook }>(PATH, body)
        ui.success("Project webhook updated.")
        show(res.webhook)
      } catch (err) {
        fail(errMsg(err))
      }
    })

  cmd
    .command("delete")
    .description("Remove the project webhook and its secret. Project events stop being delivered.")
    .action(async () => {
      const api = await buildApi()
      try {
        await api.del(PATH)
        ui.success("Project webhook removed.")
      } catch (err) {
        fail(errMsg(err))
      }
    })

  return cmd
}
